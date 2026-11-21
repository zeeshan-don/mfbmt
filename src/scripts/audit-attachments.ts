import { rawDb } from "../lib/db-base";
import { readBuffer, storageReadiness } from "../lib/storage";

/**
 * Read-only attachment audit.
 *
 * Reports how many attachment records exist, which key format they use and
 * whether a sample can be read with the configured storage driver. It never
 * prints customer names, file names, message bodies or credentials, and never
 * rewrites or deletes an object.
 *
 *   DATABASE_URL=... npm run audit:attachments
 */
async function main() {
  const readiness = storageReadiness();
  const total = await rawDb.attachment.count();
  const byPrefix = { tenantScoped: 0, legacy: 0, other: 0 };
  const byOrganization = new Map<string, number>();

  const rows = await rawDb.attachment.findMany({
    select: { organizationId: true, storagePath: true },
    orderBy: { createdAt: "asc" },
    take: 10_000,
  });

  for (const row of rows) {
    if (row.storagePath.startsWith("organizations/")) byPrefix.tenantScoped += 1;
    else if (row.storagePath.startsWith("attachments/")) byPrefix.legacy += 1;
    else byPrefix.other += 1;
    byOrganization.set(row.organizationId, (byOrganization.get(row.organizationId) ?? 0) + 1);
  }

  const sample = rows.slice(0, 25);
  let readable = 0;
  const failures: string[] = [];
  if (readiness.ok) {
    for (const row of sample) {
      try {
        await readBuffer(row.storagePath);
        readable += 1;
      } catch {
        failures.push(row.storagePath.split("/").slice(0, 3).join("/"));
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        storage: { configured: readiness.ok, driver: readiness.driver, mode: readiness.mode, detail: readiness.detail },
        attachmentRecords: total,
        sampled: sample.length,
        keyFormat: byPrefix,
        recordsByOrganization: Object.fromEntries(byOrganization),
        readableSample: readiness.ok ? `${readable}/${sample.length}` : "not checked (storage not ready)",
        unreadableSamples: [...new Set(failures)].slice(0, 5),
        migrationNeeded: byPrefix.legacy > 0,
        note:
          "Legacy keys are supported in place for existing records. Do not rewrite object keys without a verified, backed-up migration procedure.",
      },
      null,
      2,
    ),
  );
  await rawDb.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
