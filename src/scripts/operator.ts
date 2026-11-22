import { db } from "../lib/db";
import { rawDb } from "../lib/db-base";
import { provisionOrganizationAndOwner } from "../lib/onboarding/provision";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function createOrg() {
  // Passwords must never appear in process arguments, shell history or logs.
  if (hasArg("owner-password") || hasArg("password")) {
    console.error(
      "Passwords must not be supplied on the command line. create-org issues a one-time owner invitation; the owner sets their own password.",
    );
    process.exit(1);
  }

  const name = arg("name");
  const slug = arg("slug");
  const ownerEmail = arg("owner-email");
  const ownerName = arg("owner-name");
  if (!name || !slug || !ownerEmail || !ownerName) {
    console.error(
      "Usage: create-org --name <name> --slug <slug> --owner-email <email> --owner-name <name> [--country AE] [--timezone Asia/Dubai] [--currency AED]",
    );
    console.error("No password is accepted. A one-time invitation link is printed once.");
    process.exit(1);
  }

  const result = await provisionOrganizationAndOwner({
    name,
    slug,
    ownerEmail,
    ownerName,
    country: arg("country") ?? undefined,
    timezone: arg("timezone") ?? undefined,
    defaultCurrency: arg("currency") ?? undefined,
  });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(`Created organization ${result.organizationId} (${result.slug}). No owner account exists yet.`);
  console.log(`Owner invitation for ${result.email} expires at ${result.expiresAt.toISOString()}.`);
  console.log("One-time invitation link (shown only once; no password is stored or printed):");
  console.log(result.inviteUrl);
}

async function setStatus(status: "ACTIVE" | "SUSPENDED") {
  const slug = arg("slug");
  if (!slug) {
    console.error(`Usage: ${status === "SUSPENDED" ? "suspend-org" : "reactivate-org"} --slug <slug>`);
    process.exit(1);
  }
  const organization = await rawDb.organization.findUnique({ where: { slug: slug.trim().toLowerCase() } });
  if (!organization) {
    console.error("Organization not found.");
    process.exit(1);
  }
  await rawDb.organization.update({ where: { id: organization.id }, data: { status } });
  console.log(`${organization.name} is now ${status}.`);
}

async function exportUsage() {
  const slug = arg("slug");
  const month = arg("month") ?? new Date().toISOString().slice(0, 7);
  if (!slug) {
    console.error("Usage: export-usage --slug <slug> [--month YYYY-MM]");
    process.exit(1);
  }
  const organization = await rawDb.organization.findUnique({ where: { slug: slug.trim().toLowerCase() } });
  if (!organization) {
    console.error("Organization not found.");
    process.exit(1);
  }
  const { getMonthlyUsage, usageCsv } = await import("../lib/usage");
  const { runWithTenant } = await import("../lib/tenant");
  const usage = await runWithTenant({ organizationId: organization.id, source: "explicit" }, () =>
    getMonthlyUsage(month),
  );
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
      console.log("create-org issues a one-time invitation; it never accepts a password.");
      console.log("Rotate credential keys via the documented key-rotation runbook; never print secrets.");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
    await rawDb.$disconnect().catch(() => undefined);
  });
