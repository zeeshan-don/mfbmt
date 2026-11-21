import { rawDb } from "../lib/db-base";
import { env, productionConfigProblems } from "../lib/env";
import { runWithTenant } from "../lib/tenant";
import { getRate } from "../lib/costing/fx";
import { storageDriver, storageReadiness, testStorage } from "../lib/storage";
import { workerLiveness } from "../lib/workflow/jobs";

/**
 * Production readiness gate. It never prints a secret and never approves a
 * provider just because a key is present: integrations must have a recorded
 * live success. Every FAIL includes the human action that clears it.
 */
type Check = { name: string; ok: boolean; detail: string; human: string };

function add(checks: Check[], name: string, ok: boolean, detail: string, human: string) {
  checks.push({ name, ok, detail, human });
}

async function main() {
  const checks: Check[] = [];
  const orgSlug = process.env.GOLIVE_ORG_SLUG || "ogs";
  const configProblems = productionConfigProblems({ ...env, NODE_ENV: "production" });
  add(
    checks,
    "runtime configuration",
    configProblems.length === 0,
    configProblems.length === 0 ? "no blocking configuration problems" : configProblems.map((problem) => problem.variable).join(", "),
    "Copy .env.production.example, fill every required value, and run npm run check:config.",
  );
  add(checks, "APP_URL uses HTTPS", /^https:\/\//i.test(env.APP_URL), env.APP_URL, "Set APP_URL to the public HTTPS origin and configure DNS.");
  add(checks, "CRON_SECRET is set", env.CRON_SECRET.length >= 16, env.CRON_SECRET ? "set" : "missing", "Generate a long random CRON_SECRET in Vercel; set the same value for the cron caller.");
  add(checks, "WORKER_SECRET is set", env.WORKER_SECRET.length >= 16, env.WORKER_SECRET ? "set" : "missing", "Generate a long random WORKER_SECRET in the daemon environment.");

  let orgId: string | null = null;
  try {
    await rawDb.$queryRaw`SELECT 1`;
    add(checks, "database reachable", true, "PostgreSQL responded", "Create the production PostgreSQL database and set DATABASE_URL.");
    const migrations = await rawDb.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`;
    add(checks, "migrations applied", Number(migrations[0]?.count ?? 0) > 0, `${Number(migrations[0]?.count ?? 0)} migration rows`, "Run npx prisma migrate deploy against the production database after a verified backup.");
    let org: {
      id: string;
      name: string;
      procurementProfile: string;
      logo: string | null;
      legalName: string | null;
      address: string | null;
      quotationTerms: string | null;
    } | null = null;
    try {
      org = await rawDb.organization.findUnique({ where: { slug: orgSlug } });
    } catch (error) {
      add(
        checks,
        "organization schema",
        false,
        error instanceof Error ? error.message.slice(0, 160) : "organization query failed",
        "Apply pending Prisma migrations to this database; do not reset it.",
      );
    }
    orgId = org?.id ?? null;
    add(checks, `organization ${orgSlug} exists`, Boolean(org), org ? org.name : "not found", `Run npm run provision:org for slug ${orgSlug} and invite the owner.`);
    if (org) {
      add(checks, "procurement profile", org.procurementProfile === "INDUSTRIAL", org.procurementProfile, "Set the OGS organization procurementProfile to INDUSTRIAL.");
      add(
        checks,
        "letterhead and terms",
        Boolean(org.logo || (org.legalName && org.address)) && Boolean(org.quotationTerms),
        [org.logo ? "logo" : org.legalName ? "legal name" : "no letterhead", org.quotationTerms ? "terms" : "no terms"].join(" · "),
        "In Settings, add the OGS legal name/address, logo and quotation terms.",
      );
      const [products, suppliers] = await Promise.all([
        rawDb.product.count({ where: { organizationId: org.id } }),
        rawDb.supplier.count({ where: { organizationId: org.id, status: "ACTIVE" } }),
      ]);
      add(checks, "inventory loaded", products > 0, `${products} products`, "Import the OGS inventory file from Settings → Inventory.");
      add(checks, "verified active supplier", suppliers > 0, `${suppliers} active suppliers`, "Add at least one supplier and mark it active after checking its details.");

      const worker = await runWithTenant({ organizationId: org.id, source: "internal" }, () => workerLiveness());
      add(checks, "worker heartbeat fresh", worker.status === "HEALTHY", worker.status, "Start the worker daemon and confirm /health returns 200.");

      const integrations = await rawDb.integration.findMany({ where: { organizationId: org.id } });
      for (const key of ["AI_PROVIDER", "WEB_SEARCH", "EXCHANGE_RATE", "STORAGE"]) {
        const row = integrations.find((entry) => entry.key === key);
        add(
          checks,
          `integration ${key}`,
          row?.status === "CONNECTED" && Boolean(row.lastSuccessAt),
          row ? `${row.status}${row.lastSuccessAt ? " · live success recorded" : " · no live success"}` : "not configured",
          key === "AI_PROVIDER"
            ? "Create an AI API key, set AI_PROVIDER/AI_API_KEY/AI_MODEL, then run the connection test."
            : key === "WEB_SEARCH"
              ? "Create Tavily or Serper/Brave credentials, set WEB_SEARCH_PROVIDER and the key, then run the connection test."
              : key === "EXCHANGE_RATE"
                ? "Set EXCHANGE_RATE_PROVIDER and its API key, then run the connection test."
                : "Create a private S3/R2 bucket, set the S3 variables, then run the storage test.",
        );
      }
      const communication = integrations.filter(
        (entry) => ["GMAIL", "MICROSOFT365", "WHATSAPP"].includes(entry.key) && entry.status === "CONNECTED" && entry.lastSuccessAt,
      );
      add(checks, "one communication channel live", communication.length > 0, communication.map((entry) => entry.key).join(", ") || "none", "Connect Gmail, Microsoft 365 or WhatsApp and complete a live test.");

      const fx = await runWithTenant({ organizationId: org.id, source: "internal" }, () => getRate("USD", "AED"));
      add(checks, "USD/AED rate available", Boolean(fx), fx ? `${fx.rate} from ${fx.source}` : "no rate", "Configure EXCHANGE_RATE_PROVIDER or the fixed USD/AED peg and run the FX test.");
    }
  } catch (error) {
    add(checks, "database reachable", false, error instanceof Error ? error.message.slice(0, 160) : "connection failed", "Fix DATABASE_URL and network access, then rerun.");
  }

  const readiness = storageReadiness();
  add(checks, "production storage configuration", readiness.ok && storageDriver === "s3", `${storageDriver} · ${readiness.mode}`, "Use a private S3-compatible bucket (R2 or S3); do not deploy on ephemeral local disk.");
  if (readiness.ok) {
    const roundTrip = await testStorage().catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : "round trip failed" }));
    add(checks, "storage write/read/delete", roundTrip.ok, roundTrip.detail, "Check bucket permissions, endpoint and credentials, then run npm run check:storage.");
  } else {
    add(checks, "storage write/read/delete", false, readiness.detail, "Configure S3 and run npm run check:storage.");
  }

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
    if (!check.ok) console.log(`      HUMAN: ${check.human}`);
  }
  const failures = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed for ${orgSlug}${orgId ? "" : " (organization missing)"}.`);
  if (failures.length > 0) process.exitCode = 1;
  await rawDb.$disconnect();
}

main().catch((error) => {
  console.error("go-live check failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
