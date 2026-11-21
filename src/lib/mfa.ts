import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { rawDb } from "./db-base";
import { writeAudit } from "./audit";
import { randomToken, sha256 } from "./crypto";

/**
 * RFC 6238 TOTP for owner/admin accounts.
 *
 * Secrets are 160-bit base32 values. Only a hash of each one-time recovery code
 * is stored. A TOTP counter can be accepted once per account, so a captured
 * code cannot be replayed even inside its 30-second window. The challenge token
 * is short-lived, single-use and stored only as a hash.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
  window = 1,
): { ok: boolean; counter?: number } {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized) || !secret) return { ok: false };
  const current = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = current + delta;
    const expected = totpCode(secret, counter);
    if (
      expected.length === normalized.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    ) {
      return { ok: true, counter };
    }
  }
  return { ok: false };
}

export function otpauthUri(secret: string, email: string, issuer = "Procurement Intelligence"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((code) => sha256(normalizeRecoveryCode(code)));
}

function recoveryHashes(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export async function mfaStatus(userId: string): Promise<{ enabled: boolean; enabledAt: Date | null }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } });
  return { enabled: Boolean(user?.mfaEnabledAt), enabledAt: user?.mfaEnabledAt ?? null };
}

/** Verifies the current password before a security-sensitive MFA change. */
export async function verifyAccountPassword(userId: string, password: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true, isActive: true } });
  return Boolean(user?.isActive && password && (await bcrypt.compare(password, user.passwordHash)));
}

/** Starts enrollment. The secret is not active until a valid code is confirmed. */
export async function beginMfaEnrollment(input: { userId: string; password: string; email: string }) {
  if (!(await verifyAccountPassword(input.userId, input.password))) {
    return { ok: false as const, error: "Your current password is incorrect." };
  }
  const existing = await db.user.findUnique({ where: { id: input.userId }, select: { mfaEnabledAt: true } });
  if (existing?.mfaEnabledAt) {
    return { ok: false as const, error: "MFA is already enabled. Disable it before enrolling again." };
  }
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: input.userId }, data: { mfaSecret: secret, mfaEnabledAt: null } });
  return { ok: true as const, secret, uri: otpauthUri(secret, input.email) };
}

/** Confirms the first code, enables MFA and returns recovery codes exactly once. */
export async function confirmMfaEnrollment(input: { userId: string; code: string; actorLabel: string }) {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user?.mfaSecret) return { ok: false as const, error: "Start MFA enrolment again." };
  if (user.mfaEnabledAt) return { ok: false as const, error: "MFA is already enabled." };
  const verified = verifyTotp(user.mfaSecret, input.code);
  if (!verified.ok || verified.counter == null) {
    return { ok: false as const, error: "That code is not valid. Check the authenticator app and try the current code." };
  }
  const recoveryCodes = generateRecoveryCodes();
  await db.user.update({
    where: { id: user.id },
    data: {
      mfaEnabledAt: new Date(),
      mfaLastUsedCounter: verified.counter,
      mfaRecoveryCodesJson: JSON.stringify(hashRecoveryCodes(recoveryCodes)),
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: input.actorLabel,
    action: "auth.mfa_enabled",
    entityType: "User",
    entityId: user.id,
  });
  return { ok: true as const, recoveryCodes };
}

export async function disableMfa(input: { userId: string; password: string; actorLabel: string }) {
  if (!(await verifyAccountPassword(input.userId, input.password))) {
    return { ok: false as const, error: "Your current password is incorrect." };
  }
  await db.user.update({
    where: { id: input.userId },
    data: {
      mfaSecret: null,
      mfaEnabledAt: null,
      mfaRecoveryCodesJson: "[]",
      mfaLastUsedCounter: null,
    },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "auth.mfa_disabled",
    entityType: "User",
    entityId: input.userId,
  });
  return { ok: true as const };
}

export async function createMfaChallenge(userId: string, organizationId: string) {
  const token = randomToken(32);
  const challenge = await rawDb.mfaChallenge.create({
    data: {
      userId,
      organizationId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
    },
  });
  return { token, challengeId: challenge.id };
}

/**
 * Verifies a challenge and consumes a TOTP counter or recovery code atomically.
 * Returns only non-secret identity fields; the caller creates the session.
 */
export async function verifyMfaChallenge(input: {
  token: string;
  code: string;
  ip?: string;
}): Promise<
  | { ok: true; userId: string; organizationId: string }
  | { ok: false; error: string }
> {
  if (!input.token || !input.code) return { ok: false, error: "Enter the code from your authenticator app." };
  const challenge = await rawDb.mfaChallenge.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { user: { include: { organization: true } } },
  });
  const now = new Date();
  if (!challenge) return { ok: false, error: "This sign-in challenge is not valid. Sign in again." };
  if (challenge.usedAt) return { ok: false, error: "This sign-in challenge was already used. Sign in again." };
  if (challenge.expiresAt <= now) return { ok: false, error: "This sign-in challenge expired. Sign in again." };
  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    return { ok: false, error: "Too many invalid codes. Sign in again." };
  }
  if (!challenge.user.isActive || challenge.user.organization.status !== "ACTIVE") {
    return { ok: false, error: "This account or workspace is not active." };
  }
  if (challenge.user.organizationId !== challenge.organizationId || !challenge.user.mfaEnabledAt || !challenge.user.mfaSecret) {
    return { ok: false, error: "MFA is no longer active for this account. Sign in again." };
  }

  const normalized = normalizeRecoveryCode(input.code);
  const isTotpShape = /^\d{6}$/.test(input.code.replace(/\s+/g, ""));
  const totp = isTotpShape ? verifyTotp(challenge.user.mfaSecret, input.code) : { ok: false as const };
  const recoveryHash = sha256(normalized);
  const currentRecovery = recoveryHashes(challenge.user.mfaRecoveryCodesJson);
  const recoveryIndex = !totp.ok ? currentRecovery.indexOf(recoveryHash) : -1;

  if (!totp.ok && recoveryIndex < 0) {
    await rawDb.mfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, error: "That code is not valid." };
  }

  let consumed = false;
  try {
    await rawDb.$transaction(async (tx) => {
    const claimed = await tx.mfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
      data: { usedAt: now },
    });
    if (claimed.count === 0) return;

    if (totp.ok && totp.counter != null) {
      const updated = await tx.user.updateMany({
        where: {
          id: challenge.userId,
          OR: [{ mfaLastUsedCounter: null }, { mfaLastUsedCounter: { lt: totp.counter } }],
        },
        data: { mfaLastUsedCounter: totp.counter },
      });
      if (updated.count === 0) throw new Error("This authenticator code was already used.");
    } else {
      const next = currentRecovery.filter((hash) => hash !== recoveryHash);
      await tx.user.update({
        where: { id: challenge.userId },
        data: { mfaRecoveryCodesJson: JSON.stringify(next) },
      });
      await tx.auditLog.create({
        data: {
          organizationId: challenge.organizationId,
          actorId: challenge.userId,
          actorLabel: challenge.user.email,
          action: "auth.mfa_recovery_code_used",
          entityType: "User",
          entityId: challenge.userId,
          metaJson: "{}",
          ip: input.ip?.slice(0, 60) ?? null,
        },
      });
    }
      consumed = true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already used/i.test(message)) return { ok: false, error: "That authenticator code was already used. Wait for the next code." };
    throw error;
  }

  if (!consumed) return { ok: false, error: "This sign-in challenge is no longer valid. Sign in again." };
  await writeAudit({
    organizationId: challenge.organizationId,
    actorId: challenge.userId,
    actorLabel: challenge.user.email,
    action: "auth.mfa_verified",
    entityType: "User",
    entityId: challenge.userId,
    ip: input.ip ?? null,
  });
  return { ok: true, userId: challenge.userId, organizationId: challenge.organizationId };
}
