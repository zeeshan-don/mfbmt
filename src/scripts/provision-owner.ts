import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { db } from "../lib/db";
import { rawDb } from "../lib/db-base";
import { hashPassword } from "../lib/auth";
import { passwordProblem } from "../lib/account";
import { writeAudit } from "../lib/audit";
import { ensureIntegrations } from "../lib/integrations/store";
import { runWithTenant } from "../lib/tenant";
import { createOwnerInvitation } from "../lib/onboarding/invite";

/**
 * Secure initial-owner provisioning, per organization.
 *
 * DEFAULT (recommended): create a one-time owner invitation. Only the token hash
 * is stored; the invite link is written to a 0600 file and is never printed.
 * The invitee sets their own password.
 *
 *   ORG_SLUG=ogs CONFIRM_ORGANIZATION=ogs OWNER_EMAIL=... OWNER_NAME=... \
 *     npm run provision:owner:invite
 *
 * PASSWORD MODE (legacy/self-managed deployments). The password is read from
 * OWNER_PASSWORD_FILE or a masked interactive prompt. It is never accepted on
 * the command line and never printed.
 *
 *   ORG_SLUG=mfbmt CONFIRM_ORGANIZATION=mfbmt OWNER_EMAIL=... OWNER_NAME=... \
 *     OWNER_INVITE=false OWNER_PASSWORD_FILE=/secure/path/password.txt \
 *     npm run provision:owner
 *
 * Guards:
 *   * ORG_SLUG has no default and CONFIRM_ORGANIZATION must equal it, so an
 *     owner can never be provisioned into the wrong tenant by accident.
 *   * An existing owner is never reset unless OWNER_RESET=RESET_OWNER_PASSWORD.
 *   * An email that belongs to another tenant is refused, never reused.
 *   * Every successful action writes an audit record.
 */

type MutableReadline = readline.Interface & { _writeToOutput?: (text: string) => void };

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Masked password prompt. Nothing typed is echoed to the terminal. */
function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "No interactive terminal is available. Use OWNER_PASSWORD_FILE with a 0600 file, or use the owner invitation flow.",
    );
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as MutableReadline;
    const original = rl._writeToOutput?.bind(rl);
    let muted = false;
    rl._writeToOutput = (text: string) => {
      if (!muted) {
        original?.(text);
        return;
      }
      // Keep line breaks so the next prompt starts on a fresh line; omit every
      // typed character (and backspace sequence).
      if (/[\r\n]/.test(text)) original?.("\n");
    };
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    // The prompt has already been written by question(); mute the echo now.
    muted = true;
  });
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readPassword(): Promise<string> {
  if (process.env.OWNER_PASSWORD) {
    throw new Error(
      "OWNER_PASSWORD is not accepted: a password must not be passed through the environment. " +
        "Use OWNER_PASSWORD_FILE (mode 0600) or the masked interactive prompt.",
    );
  }
  const file = (process.env.OWNER_PASSWORD_FILE ?? "").trim();
  if (file) {
    const absolute = path.resolve(process.cwd(), file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) throw new Error("OWNER_PASSWORD_FILE was not found.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("OWNER_PASSWORD_FILE must not be readable by group or other users (chmod 600).");
    }
    return (await fs.readFile(absolute, "utf8")).replace(/\r?\n$/, "");
  }
  return askHidden("Password (min 12 chars, letters and numbers): ");
}

async function main() {
  const slug = requireEnv("ORG_SLUG").toLowerCase();
  const confirmation = requireEnv("CONFIRM_ORGANIZATION").toLowerCase();
  if (confirmation !== slug) {
    throw new Error(
      `CONFIRM_ORGANIZATION (${confirmation}) does not match ORG_SLUG (${slug}). ` +
        "Refusing to provision an owner into an unconfirmed organization.",
    );
  }

  const organization = await rawDb.organization.findUnique({ where: { slug } });
  if (!organization) {
    throw new Error(
      `No organization with slug "${slug}" exists. Provision the tenant first (see docs/ONBOARDING.md); this script never invents a company.`,
    );
  }
  if (organization.status !== "ACTIVE") throw new Error(`Organization ${slug} is ${organization.status}, not active.`);

  const email = (process.env.OWNER_EMAIL ?? (await ask("Owner email: "))).trim().toLowerCase();
  const name = (process.env.OWNER_NAME ?? (await ask("Owner name: "))).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");
  if (name.length < 2) throw new Error("A name is required.");

  // Never silently reuse an account from another tenant.
  const elsewhere = await rawDb.user.findFirst({
    where: { email, organizationId: { not: organization.id } },
    select: { organization: { select: { slug: true } } },
  });
  if (elsewhere) {
    throw new Error(
      `This email already belongs to workspace "${elsewhere.organization.slug}". An existing account is never reused across tenants.`,
    );
  }

  const existingOwner = await rawDb.user.findFirst({
    where: { organizationId: organization.id, role: "OWNER" },
    select: { email: true },
  });

  const inviteMode = (process.env.OWNER_INVITE ?? "true").trim().toLowerCase() !== "false";

  if (inviteMode) {
    if (existingOwner) {
      throw new Error(
        `An owner already exists in ${slug} (${existingOwner.email}). Invitations never reset an existing owner.`,
      );
    }
    const invitation = await createOwnerInvitation({
      organizationId: organization.id,
      email,
      name,
      createdByLabel: "provisioning-cli",
    });
    if (!invitation.ok) throw new Error(invitation.error);

    const file = (process.env.OWNER_INVITE_FILE ?? `owner-invite-${slug}.txt`).trim();
    const absolute = path.resolve(process.cwd(), file);
    await fs.writeFile(absolute, `${invitation.inviteUrl}\n`, { mode: 0o600 });
    console.log(`Owner invitation created for ${organization.name} (${slug}): ${email}`);
    console.log(`Expires ${invitation.expiresAt.toISOString()}. Single use.`);
    console.log(`Invitation link written to ${absolute} (mode 0600). It was not printed and cannot be recovered later.`);
    console.log("Deliver the file link to the approved owner through an approved channel, then delete the file.");
    return;
  }

  const reset = process.env.OWNER_RESET === "RESET_OWNER_PASSWORD";
  if (existingOwner && !reset) {
    throw new Error(
      `An owner account already exists (${existingOwner.email}). Set OWNER_RESET=RESET_OWNER_PASSWORD only when a deliberate password reset is authorised.`,
    );
  }

  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  await runWithTenant({ organizationId: organization.id, source: "internal" }, async () => {
    const existing = await db.user.findFirst({ where: { email } });
    if (existing && existing.role !== "OWNER" && !reset) {
      throw new Error(
        `A ${existing.role.toLowerCase()} account already uses this email in ${slug}. Invite the owner with a different address or reset deliberately.`,
      );
    }
    const passwordHash = await hashPassword(password);
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
    // A password reset invalidates every existing session for that account.
    await db.session.deleteMany({ where: { userId: user.id } });
    await writeAudit({
      action: "auth.owner_provisioned",
      entityType: "User",
      entityId: user.id,
      actorLabel: "provisioning-cli",
      meta: { email, organizationSlug: slug, mode: "password", reset },
    });

    console.log(`Owner account ready for ${organization.name} (${slug}): ${user.email}`);
    console.log("No password was printed. No demo data was created.");
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
    await rawDb.$disconnect().catch(() => undefined);
  });
