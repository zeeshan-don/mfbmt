import { db } from "../lib/db";
import { hashPassword } from "../lib/auth";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function createOrg() {
  const name = arg("name");
  const slug = arg("slug");
  const ownerEmail = arg("owner-email");
  const ownerPassword = arg("owner-password");
  const ownerName = arg("owner-name") ?? "Owner";
  if (!name || !slug || !ownerEmail || !ownerPassword) {
    console.error("Usage: create-org --name <name> --slug <slug> --owner-email <email> --owner-password <password> [--owner-name <name>]");
    process.exit(1);
  }
  const org = await db.organization.create({ data: { name, slug } });
  await db.user.create({
    data: {
      organizationId: org.id,
      email: ownerEmail.toLowerCase(),
      name: ownerName,
      passwordHash: await hashPassword(ownerPassword),
      role: "OWNER",
      mustChangePassword: true,
    },
  });
  console.log(`Created organization ${org.id} (${slug}) with owner ${ownerEmail}.`);
}

async function setStatus(status: "ACTIVE" | "SUSPENDED") {
  const slug = arg("slug");
  if (!slug) {
    console.error(`Usage: ${status === "SUSPENDED" ? "suspend-org" : "reactivate-org"} --slug <slug>`);
    process.exit(1);
  }
  const org = await db.organization.update({ where: { slug }, data: { status } });
  console.log(`${org.name} is now ${status}.`);
}

async function exportUsage() {
  const slug = arg("slug");
  const month = arg("month") ?? new Date().toISOString().slice(0, 7);
  if (!slug) {
    console.error("Usage: export-usage --slug <slug> [--month YYYY-MM]");
    process.exit(1);
  }
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) {
    console.error("Organization not found.");
    process.exit(1);
  }
  const { getMonthlyUsage, usageCsv } = await import("../lib/usage");
  const usage = await (async () => {
    // getMonthlyUsage uses tenant context; run scoped.
    const { runWithTenant } = await import("../lib/tenant");
    return runWithTenant({ organizationId: org.id, source: "explicit" }, () => getMonthlyUsage(month));
  })();
  process.stdout.write(usageCsv(usage));
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "create-org":
      await createOrg();
      break;
    case "suspend-org":
      await setStatus("SUSPENDED");
      break;
    case "reactivate-org":
      await setStatus("ACTIVE");
      break;
    case "export-usage":
      await exportUsage();
      break;
    default:
      console.log("Commands: create-org, suspend-org, reactivate-org, export-usage");
      console.log("Rotate credential keys via the documented key-rotation runbook; never print secrets.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });