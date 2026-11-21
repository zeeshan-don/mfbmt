import { rawDb } from "../lib/db-base";
import { runWithTenant } from "../lib/tenant";
import { runIntegrationDiagnostic, getIntegrationDiagnostics } from "../lib/integrations/diagnostics";
import { integrationKeys, type IntegrationKey } from "../lib/constants";

/**
 * Runs one non-destructive provider check per integration for the chosen
 * organization and prints PASS/FAIL with remediation. No secret is printed and
 * no real message/email/quotation is sent.
 *
 * Usage: ORG_SLUG=ogs npm run verify:live
 */
async function main() {
  const slug = (process.env.ORG_SLUG ?? "ogs").trim().toLowerCase();
  const org = await rawDb.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!org) {
    console.error(`No organization with slug "${slug}". Provision it first.`);
    process.exitCode = 1;
    await rawDb.$disconnect();
    return;
  }

  console.log(`Verifying integrations for ${org.name} (${slug})...\n`);

  const before = await runWithTenant({ organizationId: org.id, source: "internal" }, () => getIntegrationDiagnostics());

  let liveChecks = 0;
  let passed = 0;
  for (const key of integrationKeys) {
    const result = await runWithTenant({ organizationId: org.id, source: "internal" }, () => runIntegrationDiagnostic(key as IntegrationKey));
    if (result.liveRequest) liveChecks += 1;
    if (result.ok) passed += 1;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${key} — ${result.detail}`);
    if (!result.ok) {
      const row = before.find((entry) => entry.key === key);
      if (row?.remediation) console.log(`      HUMAN: ${row.remediation}`);
    }
  }

  const after = await runWithTenant({ organizationId: org.id, source: "internal" }, () => getIntegrationDiagnostics());
  console.log(`\n${passed}/${integrationKeys.length} integrations verified (${liveChecks} live provider request(s)).`);
  for (const row of after) {
    console.log(`  ${row.key}: ${row.status} · last success ${row.lastSuccessAt ?? "never"} · last sync ${row.lastSyncAt ?? "n/a"}`);
  }

  await rawDb.$disconnect();
  if (passed === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("verify:live failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});