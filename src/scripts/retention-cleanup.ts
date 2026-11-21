import { db } from "../lib/db";
import { runWithTenant } from "../lib/tenant";

async function main() {
  const apply = process.argv.includes("--apply");
  const orgs = await db.organization.findMany({
    where: { messageRetentionDays: { gt: 0 } },
    select: { id: true, name: true, messageRetentionDays: true },
  });
  for (const org of orgs) {
    const cutoff = new Date(Date.now() - (org.messageRetentionDays ?? 0) * 24 * 60 * 60 * 1000);
    const count = await runWithTenant({ organizationId: org.id, source: "explicit" }, async () => {
      const old = await db.message.count({ where: { createdAt: { lt: cutoff } } });
      if (apply) {
        await db.message.deleteMany({ where: { createdAt: { lt: cutoff } } });
      }
      return old;
    });
    console.log(`${org.name}: ${count} message(s) ${apply ? "deleted" : "would be deleted"} (retention ${org.messageRetentionDays} days).`);
  }
  console.log(apply ? "Retention cleanup applied." : "Dry run only. Re-run with --apply to delete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});