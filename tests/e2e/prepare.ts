import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Prepares a dedicated, disposable PostgreSQL schema for Playwright.
 *
 * The E2E suite must never touch the application's configured database. The
 * `.env` database may be a hosted/shared instance; this script refuses anything
 * except localhost and a schema other than `public`.
 */
async function main() {
  const url =
    process.env.TEST_E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_e2e?schema=public";
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("E2E_DATABASE must be a local PostgreSQL instance.");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!/e2e/i.test(database) || database === "postgres") {
    throw new Error("E2E_DATABASE must point at a dedicated local database whose name contains 'e2e'.");
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  adminUrl.searchParams.set("schema", "public");
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    // Disposable E2E database only, on localhost. Never a hosted database.
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.$disconnect();
  }

  const schema = "public";

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
    stdio: "inherit",
  });

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    // The tenancy migration already provisions both tenants; give MFBMT the
    // display name the dashboard shows and a distinct creation order so the
    // demo seeder always selects MFBMT as the first organization.
    await db.organization.upsert({
      where: { id: "org_mfbmt" },
      update: { name: "MFBMT", createdAt: new Date("2020-01-01T00:00:00Z") },
      create: {
        id: "org_mfbmt",
        slug: "mfbmt",
        name: "MFBMT",
        country: "AE",
        timezone: "Asia/Dubai",
        defaultCurrency: "AED",
        quotationPrefix: "QT",
        status: "ACTIVE",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    await db.organization.upsert({
      where: { id: "org_ogs" },
      update: { createdAt: new Date("2026-01-01T00:00:00Z") },
      create: {
        id: "org_ogs",
        slug: "ogs",
        name: "OGS & Chemicals FZC",
        country: "AE",
        timezone: "Asia/Dubai",
        defaultCurrency: "AED",
        quotationPrefix: "OGS",
        status: "ACTIVE",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
  } finally {
    await db.$disconnect();
  }

  execSync("npx tsx src/scripts/seed.ts", {
    env: {
      ...process.env,
      DATABASE_URL: url,
      NODE_ENV: "test",
      DEMO_MODE: "true",
      SEED_DEMO_DATA: "true",
    },
    stdio: "inherit",
  });

  console.log(`[e2e] isolated schema "${schema}" is migrated and seeded.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
