import readline from "node:readline";
import { db } from "../lib/db";
import { hashPassword } from "../lib/auth";
import { passwordProblem } from "../lib/account";
import { writeAudit } from "../lib/audit";
import { ensureIntegrations } from "../lib/integrations/store";

/**
 * Secure initial-owner provisioning.
 *
 * There is no public sign-up page and no default password. The first owner is
 * created from the server, interactively or with environment variables for a
 * managed deploy:
 *
 *   npm run provision:owner
 *   MBFMT_OWNER_EMAIL=... MBFMT_OWNER_NAME=... MBFMT_OWNER_PASSWORD=... npm run provision:owner
 *
 * Running it twice is safe: an existing owner is never overwritten unless
 * MBFMT_OWNER_RESET=true is explicitly set.
 */
function ask(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent) {
      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
      const wasRaw = Boolean(stdin.isTTY);
      // Note: readline echoes typed characters; a silent prompt is best-effort
      // and the password is never logged by this script regardless.
      void wasRaw;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = (process.env.MBFMT_OWNER_EMAIL ?? (await ask("Owner email: "))).trim().toLowerCase();
  const name = (process.env.MBFMT_OWNER_NAME ?? (await ask("Owner name: "))).trim();
  const password = process.env.MBFMT_OWNER_PASSWORD ?? (await ask("Password (min 12 chars, letters and numbers): "));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");
  if (name.length < 2) throw new Error("A name is required.");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const existingOwner = await db.user.findFirst({ where: { role: "OWNER" } });
  if (existingOwner && process.env.MBFMT_OWNER_RESET !== "true") {
    throw new Error(
      `An owner account already exists (${existingOwner.email}). Set MBFMT_OWNER_RESET=true to reset this specific owner's password.`,
    );
  }

  const passwordHash = await hashPassword(password);
  const user = await db.user.upsert({
    where: { email },
    update: { passwordHash, name, role: "OWNER", isActive: true, mustChangePassword: false, passwordChangedAt: new Date() },
    create: { email, name, passwordHash, role: "OWNER", isActive: true, mustChangePassword: false },
  });

  await ensureIntegrations();

  if (!(await db.organization.findFirst())) {
    await db.organization.create({
      data: { name: "Multi Fasteners Building Materials Trading LLC", defaultCurrency: "AED" },
    });
  }

  await db.session.deleteMany({ where: { userId: user.id } });
  await writeAudit({
    action: "auth.owner_provisioned",
    entityType: "User",
    entityId: user.id,
    actorLabel: "provisioning",
    meta: { email },
  });

  console.log(`Owner account ready: ${user.email}`);
  console.log("No demo data was created. Sign in and complete the setup checklist at /onboarding.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
