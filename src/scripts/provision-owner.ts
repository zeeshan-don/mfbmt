import readline from "node:readline";
import { db } from "../lib/db";
import { rawDb } from "../lib/db-base";
import { hashPassword } from "../lib/auth";
import { passwordProblem } from "../lib/account";
import { writeAudit } from "../lib/audit";
import { ensureIntegrations } from "../lib/integrations/store";
import { runWithTenant } from "../lib/tenant";

/**
 * Secure initial-owner provisioning, per organization.
 *
 * There is no public sign-up page and no default password. The first owner is
 * created from the server, interactively or with environment variables:
 *
 *   ORG_SLUG=ogs OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... npm run provision:owner
 *
 * The older MBFMT_* variables are still accepted for existing deployments.
 * Running it twice is safe: an existing owner is never overwritten unless
 * OWNER_RESET=true is explicitly set.
 */
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const slug = (process.env.ORG_SLUG ?? process.env.MBFMT_ORGANIZATION_SLUG ?? "mfbmt").trim().toLowerCase();
  const organization = await rawDb.organization.findUnique({ where: { slug } });
  if (!organization) {
    throw new Error(
      `No organization with slug "${slug}" exists. Provision the tenant first (see docs/ONBOARDING.md); this script never invents a company.`,
    );
  }
  if (organization.status !== "ACTIVE") throw new Error(`Organization ${slug} is ${organization.status}, not active.`);

  const email = (process.env.OWNER_EMAIL ?? process.env.MBFMT_OWNER_EMAIL ?? (await ask("Owner email: "))).trim().toLowerCase();
  const name = (process.env.OWNER_NAME ?? process.env.MBFMT_OWNER_NAME ?? (await ask("Owner name: "))).trim();
  const password = process.env.OWNER_PASSWORD ?? process.env.MBFMT_OWNER_PASSWORD ?? (await ask("Password (min 12 chars, letters and numbers): "));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");
  if (name.length < 2) throw new Error("A name is required.");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  return runWithTenant({ organizationId: organization.id, source: "internal" }, async () => {
    const existingOwner = await db.user.findFirst({ where: { role: "OWNER" } });
    const reset = process.env.OWNER_RESET === "true" || process.env.MBFMT_OWNER_RESET === "true";
    if (existingOwner && !reset) {
      throw new Error(
        `An owner account already exists (${existingOwner.email}). Set OWNER_RESET=true to reset this specific owner's password.`,
      );
    }

    const passwordHash = await hashPassword(password);
    const existing = await db.user.findFirst({ where: { email } });
    const user = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: { passwordHash, name, role: "OWNER", isActive: true, mustChangePassword: false, passwordChangedAt: new Date() },
        })
      : await db.user.create({
          data: {
            organizationId: organization.id,
            email,
            name,
            passwordHash,
            role: "OWNER",
            isActive: true,
            mustChangePassword: false,
          },
        });

    await ensureIntegrations();
    await db.session.deleteMany({ where: { userId: user.id } });
    await writeAudit({
      action: "auth.owner_provisioned",
      entityType: "User",
      entityId: user.id,
      actorLabel: "provisioning",
      meta: { email, organizationSlug: slug },
    });

    console.log(`Owner account ready for ${organization.name} (${slug}): ${user.email}`);
    console.log("No demo data was created. Sign in and complete the setup checklist at /onboarding.");
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
