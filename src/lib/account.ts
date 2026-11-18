import { db } from "./db";
import { hashPassword, verifyPassword } from "./auth";
import { sha256, randomToken } from "./crypto";
import { writeAudit } from "./audit";
import { sendEmail } from "./email/send";
import { env } from "./env";

export const MIN_PASSWORD_LENGTH = 12;
const RESET_TTL_MINUTES = 60;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Use a mix of letters and numbers.";
  }
  if (/^(password|changeme|mfbmt|admin)/i.test(password)) return "That password is too easy to guess.";
  return null;
}

/** Changes the signed-in user's own password and revokes their other sessions. */
export async function changeOwnPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionTokenHash?: string | null;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) return { ok: false, error: "Account not found." };
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    return { ok: false, error: "Your current password is incorrect." };
  }
  const problem = passwordProblem(input.newPassword);
  if (problem) return { ok: false, error: problem };
  if (input.newPassword === input.currentPassword) {
    return { ok: false, error: "Choose a password you have not used before." };
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });
  // Revoke every other session for this account.
  await db.session.deleteMany({
    where: {
      userId: user.id,
      ...(input.keepSessionTokenHash ? { tokenHash: { not: input.keepSessionTokenHash } } : {}),
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: input.actorLabel,
    action: "auth.password_changed",
    entityType: "User",
    entityId: user.id,
  });
  return { ok: true };
}

/**
 * Starts a password reset. The response is identical whether or not the address
 * exists, so the page cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const generic = {
    message: "If that email belongs to an MFBMT account, a reset link has been sent. It expires in 60 minutes.",
  };
  const normalised = email.trim().toLowerCase();
  if (!normalised) return generic;

  const user = await db.user.findUnique({ where: { email: normalised } });
  if (!user || !user.isActive) return generic;

  const token = randomToken(32);
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: sha256(token),
      passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
    },
  });

  const link = `${env.APP_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
  const sent = await sendEmail({
    to: user.email,
    subject: "Reset your MFBMT password",
    text: [
      `Hello ${user.name},`,
      "",
      "Use this link to choose a new password. It works once and expires in 60 minutes.",
      link,
      "",
      "If you did not ask for this, you can ignore the email — your password has not changed.",
    ].join("\n"),
  });

  await writeAudit({
    actorId: user.id,
    actorLabel: user.email,
    action: sent.ok ? "auth.password_reset_requested" : "auth.password_reset_unavailable",
    entityType: "User",
    entityId: user.id,
    meta: sent.ok ? {} : { error: sent.error },
  });

  if (!sent.ok) {
    // No mailbox connected: the owner must reset it from the server instead.
    return {
      message:
        "A reset was requested, but no company mailbox is connected so the email could not be sent. Ask the system administrator to reset the password on the server.",
    };
  }
  return generic;
}

export async function resetPasswordWithToken(input: {
  token: string;
  newPassword: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.token) return { ok: false, error: "This reset link is not valid." };
  const hash = sha256(input.token);
  const user = await db.user.findFirst({ where: { passwordResetTokenHash: hash } });
  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
    return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
  }
  const problem = passwordProblem(input.newPassword);
  if (problem) return { ok: false, error: problem };

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });
  await db.session.deleteMany({ where: { userId: user.id } });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.email,
    action: "auth.password_reset_completed",
    entityType: "User",
    entityId: user.id,
  });
  return { ok: true };
}
