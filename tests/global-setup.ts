import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_test?schema=public";

/**
 * Prepares the isolated PostgreSQL test database.
 *
 * It is a dedicated database (mfbmt_test), never the development or production
 * database. The URL is checked before anything destructive runs, so a
 * misconfigured TEST_DATABASE_URL can never reset real data.
 */
export default async function setup() {
  const url = TEST_DATABASE_URL;
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL connection string for the isolated test database.");
  }
  if (/\/mfbmt_dev(\?|$)/.test(url) || /prod/i.test(url)) {
    throw new Error("Refusing to run tests against a development or production database. Use a dedicated test database.");
  }

  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
  });

  // A previous test run may have cleared tenant rows. Tests never delete
  // organizations now, but the fixture is re-asserted so the suite is
  // order-independent and can run against a freshly migrated database.
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.organization.upsert({
      where: { id: "org_mfbmt" },
      update: {},
      create: {
        id: "org_mfbmt",
        slug: "mfbmt",
        name: "Multi Fasteners Building Materials Trading LLC",
        country: "AE",
        timezone: "Asia/Dubai",
        defaultCurrency: "AED",
        quotationPrefix: "QT",
        status: "ACTIVE",
      },
    });
    await db.organization.upsert({
      where: { id: "org_ogs" },
      update: {},
      create: {
        id: "org_ogs",
        slug: "ogs",
        name: "OGS & Chemicals FZC",
        country: "AE",
        timezone: "Asia/Dubai",
        defaultCurrency: "AED",
        quotationPrefix: "OGS",
        status: "ACTIVE",
      },
    });
  } finally {
    await db.$disconnect();
  }

  console.log("[tests] PostgreSQL test database ready (migrations applied, tenants present).");
}
