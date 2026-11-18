import crypto from "node:crypto";
import { env, isProd } from "./env";

/**
 * AES-256-GCM for integration credentials stored in the database.
 *
 * In production a dedicated CREDENTIAL_ENCRYPTION_KEY is mandatory (enforced by
 * env.ts). AUTH_SECRET is never used as a fallback there, so rotating the
 * session secret cannot silently make stored provider tokens unrecoverable.
 */
const KEY_ID = "v1";

function rawKey(): string {
  if (!isProd) return env.CREDENTIAL_ENCRYPTION_KEY || env.AUTH_SECRET;
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not configured. Stored integration credentials cannot be encrypted or decrypted.",
    );
  }
  return env.CREDENTIAL_ENCRYPTION_KEY;
}

function key(): Buffer {
  return crypto.createHash("sha256").update(rawKey()).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${KEY_ID}.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== KEY_ID || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Returns null and a reason instead of throwing, for callers that must render state. */
export function tryDecryptSecret(payload: string): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: decryptSecret(payload) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && /Unsupported state|bad decrypt|auth/i.test(error.message)
          ? "Stored credentials could not be decrypted. The encryption key may have changed; reconnect this integration."
          : error instanceof Error
            ? error.message
            : "Stored credentials could not be decrypted.",
    };
  }
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hmacSignature(secret: string, payload: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmacSignature(secret: string, payload: string, header: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return timingSafeEqual(expected, header.slice("sha256=".length));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** URL-safe, HMAC-signed, expiring tokens (downloads, OAuth state, supplier links). */
export function signPayload(payload: Record<string, unknown>, ttlSeconds: number, secret = env.AUTH_SECRET): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySignedPayload<T = Record<string, unknown>>(
  token: string,
  secret = env.AUTH_SECRET,
): { ok: true; data: T & { exp: number } } | { ok: false; error: string } {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "Malformed token." };
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeEqual(sig, expected)) return { ok: false, error: "Invalid token signature." };
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    if (!data.exp || data.exp < Date.now()) return { ok: false, error: "This link has expired." };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Malformed token." };
  }
}
