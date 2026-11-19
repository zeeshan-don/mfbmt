import { rawDb } from "../lib/db-base";

/**
 * ZeeshStudios platform administration: create, activate, suspend or list tenants.
 *
 * This is deliberately a server-side operator tool, not a public sign-up page.
 * It creates the tenant record only. It never invents legal details, users,
 * suppliers, prices or integrations; the company completes those through the
 * authenticated onboarding flow.
 *
 *   ORG_ACTION=create ORG_SLUG=ogs ORG_NAME="OGS & Chemicals FZC" npx tsx src/scripts/provision-organization.ts
 *   ORG_ACTION=suspend ORG_SLUG=ogs npx tsx src/scripts/provision-organization.ts
 *   ORG_ACTION=activate ORG_SLUG=ogs npx tsx src/scripts/provision-organization.ts
 *   ORG_ACTION=list npx tsx src/scripts/provision-organization.ts
 *
 * The operator is not given access to the tenant's business data. Support access
 * would require a separately authorised flow and an audit record.
 */

async function main() {
  const action = (process.env.ORG_ACTION ?? "list").trim().toLowerCase();

  if (action === "list") {
    const organizations = await rawDb.organization.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, slug: true, name: true, status: true, defaultCurrency: true, createdAt: true },
    });
    for (const organization of organizations) {
      console.log(
        `${organization.id}\t${organization.slug}\t${organization.status}\t${organization.defaultCurrency}\t${organization.name}`,
      );
    }
    return;
  }

  const slug = (process.env.ORG_SLUG ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new Error("ORG_SLUG must be a lowercase slug such as mfbmt or ogs.");
  }

  if (action === "create") {
    const name = (process.env.ORG_NAME ?? "").trim();
    if (name.length < 2) throw new Error("ORG_NAME is required; company details are never invented.");
    const existing = await rawDb.organization.findUnique({ where: { slug } });
    if (existing) throw new Error(`Organization ${slug} already exists (${existing.id}).`);
    const organization = await rawDb.organization.create({
      data: {
        slug,
        name,
        status: "ACTIVE",
        country: process.env.ORG_COUNTRY ?? "AE",
        timezone: process.env.ORG_TIMEZONE ?? "Asia/Dubai",
        defaultCurrency: (process.env.ORG_CURRENCY ?? "AED").toUpperCase().slice(0, 3),
      },
    });
    console.log(`Created ${organization.id} (${organization.slug}). No users or business data were created.`);
    return;
  }

  if (action === "suspend" || action === "activate") {
    const status = action === "suspend" ? "SUSPENDED" : "ACTIVE";
    const organization = await rawDb.organization.findUnique({ where: { slug } });
    if (!organization) throw new Error(`No organization with slug ${slug}.`);
    await rawDb.organization.update({ where: { id: organization.id }, data: { status } });
    if (status === "SUSPENDED") {
      // Sign every session out of a suspended workspace.
      await rawDb.session.deleteMany({ where: { organizationId: organization.id } });
    }
    console.log(`${organization.name} is now ${status}.`);
    return;
  }

  throw new Error(`Unknown ORG_ACTION "${action}". Use create, activate, suspend or list.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await rawDb.$disconnect();
  });
