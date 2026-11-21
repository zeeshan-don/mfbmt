import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env, MAX_UPLOAD_MB } from "./env";
import {
  buildTenantAttachmentKey,
  configuredRemoteDriver,
  storageConfigProblems,
  storageKeyOwnership,
  type KeyOwnership,
} from "./storage-config";

/**
 * File storage with two drivers:
 *  - `local`  a persistent server volume (development, or a self-hosted disk)
 *  - `s3`     any S3-compatible object store (Cloudflare R2, AWS S3, MinIO)
 *
 * Production is fail-closed: an unknown driver, a half-configured bucket or
 * local disk without an explicit persistent-volume opt-in stops every file
 * operation with a clear error instead of silently writing to ephemeral disk.
 *
 * Objects are private. There is no public bucket URL and no ACL is applied.
 * Reads go through the application (authenticated or HMAC-signed) or a
 * short-lived presigned URL.
 */

const STORAGE_ROOT = path.resolve(process.cwd(), env.STORAGE_ROOT);
const DRIVER = configuredRemoteDriver(env) ?? "local";

export const storageDriver = DRIVER;

export class StorageUnavailableError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Persistent file storage is not configured correctly. File operations are blocked. ${problems
        .slice(0, 2)
        .join(" ")}`,
    );
    this.name = "StorageUnavailableError";
    this.problems = problems;
  }
}

function configProblems(): string[] {
  return storageConfigProblems(env).map((problem) => `${problem.variable} ${problem.problem}`);
}

export type StorageReadiness = {
  ok: boolean;
  driver: "local" | "s3";
  /** `persistent` is object storage or an explicitly allowed local volume. */
  mode: "persistent" | "ephemeral" | "misconfigured";
  detail: string;
};

/**
 * Reports whether files can be stored durably. It performs no network call, so
 * it is safe in a liveness probe and never exposes credentials. The full
 * write/read/delete self-test is `testStorage()`.
 */
export function storageReadiness(): StorageReadiness {
  const problems = configProblems();
  if (problems.length > 0) {
    return {
      ok: false,
      driver: DRIVER,
      mode: "misconfigured",
      detail: problems[0] ?? "Storage configuration is incomplete.",
    };
  }
  if (DRIVER === "local") {
    return {
      ok: true,
      driver: "local",
      mode: env.NODE_ENV === "production" ? "persistent" : "ephemeral",
      detail: "Local storage is writable on the configured volume.",
    };
  }
  return { ok: true, driver: "s3", mode: "persistent", detail: "Object storage is configured." };
}

export const ALLOWED_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "archive",
  "application/vnd.ms-excel": "excel",
  "text/csv": "csv",
  "text/plain": "text",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/heic": "image",
  "image/heif": "image",
} as const;

export type FileFamily = "pdf" | "excel" | "csv" | "text" | "image" | "docx" | "archive" | "other";

/** Content-based detection — never trust the extension or the browser MIME alone. */
export function sniffType(buffer: Buffer): { mime: string; family: FileFamily } {
  const head = buffer.subarray(0, 512);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", family: "pdf" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: "image/jpeg", family: "image" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", family: "image" };
  }
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp", family: "image" };
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const text = buffer.subarray(0, Math.min(buffer.length, 8000)).toString("latin1");
    if (text.includes("word/document.xml")) {
      return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "docx" };
    }
    if (text.includes("xl/worksheets") || text.includes("[Content_Types].xml")) {
      return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "excel" };
    }
    return { mime: "application/zip", family: "archive" };
  }
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { mime: "application/vnd.ms-excel", family: "excel" };
  }
  const brand = head.subarray(4, 12).toString("latin1");
  if (brand.includes("ftyphei") || brand.includes("ftypmif1") || brand.includes("ftypmsf1")) {
    return { mime: "image/heic", family: "image" };
  }
  const text = head.toString("utf8");
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
    const isCsv = text.includes(",") && /\r?\n/.test(text);
    return { mime: isCsv ? "text/csv" : "text/plain", family: isCsv ? "csv" : "text" };
  }
  return { mime: "application/octet-stream", family: "other" };
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f]/g, "");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "attachment").slice(0, 120);
}

/** Rejects traversal, absolute paths and NUL bytes in an object key. */
export function assertSafeKey(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000") ||
    normalized.split("/").some((segment) => segment === ".." || segment === ".") ||
    normalized.length > 512
  ) {
    throw new Error("Invalid storage key.");
  }
  return normalized;
}

/**
 * Verifies that a key read for a database record belongs to the record's
 * tenant. New tenant-scoped keys must match exactly. Legacy keys (written before
 * tenant prefixes existed) have no tenant in the key, so they are only allowed
 * for an existing database record whose organizationId has already been checked.
 */
export function keyBelongsToOrganization(key: string, organizationId: string): { ok: boolean; ownership: KeyOwnership } {
  const ownership = storageKeyOwnership(assertSafeKey(key), organizationId);
  return { ok: ownership !== "foreign", ownership };
}

export function assertAllowedUpload(
  buffer: Buffer,
  declaredName: string,
): { ok: true; mime: string; family: FileFamily; filename: string } | { ok: false; error: string } {
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
  if (buffer.length === 0) return { ok: false, error: "The file is empty." };
  if (buffer.length > maxBytes) {
    return { ok: false, error: `The file is larger than ${MAX_UPLOAD_MB} MB.` };
  }
  const sniffed = sniffType(buffer);
  const allowedFamilies: FileFamily[] = ["pdf", "excel", "csv", "text", "image", "docx", "archive"];
  if (!allowedFamilies.includes(sniffed.family)) {
    return {
      ok: false,
      error: "This file type is not supported. Use PDF, XLSX, CSV, text or an image.",
    };
  }
  return { ok: true, mime: sniffed.mime, family: sniffed.family, filename: sanitizeFilename(declaredName) };
}

type S3Module = typeof import("@aws-sdk/client-s3");

let s3Client: InstanceType<S3Module["S3Client"]> | null = null;
let s3Module: S3Module | null = null;

/** True only for AWS S3 itself, which supports SSE-S3 without extra setup. */
function isAwsS3(): boolean {
  const endpoint = (env.S3_ENDPOINT ?? "").trim();
  return endpoint.length === 0 || /(^|\.)amazonaws\.com/i.test(endpoint);
}

async function s3(): Promise<{ module: S3Module; client: InstanceType<S3Module["S3Client"]> }> {
  if (!s3Module) s3Module = await import("@aws-sdk/client-s3");
  if (!s3Client) {
    const endpoint = (env.S3_ENDPOINT ?? "").trim();
    s3Client = new s3Module.S3Client({
      // R2 uses "auto"; AWS needs its real region. Storage configuration
      // validation guarantees a usable combination before this runs.
      region: endpoint ? (env.S3_REGION?.trim() || "auto") : env.S3_REGION,
      endpoint: endpoint || undefined,
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "false").toLowerCase() === "true",
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return { module: s3Module, client: s3Client };
}

function localPath(key: string): string {
  const safe = assertSafeKey(key);
  const resolved = path.resolve(STORAGE_ROOT, safe);
  const rootWithSep = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep;
  if (resolved !== STORAGE_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error("Invalid attachment path");
  }
  return resolved;
}

/** Writes an object and returns its key. Fails closed on a storage misconfiguration. */
export async function saveBuffer(
  buffer: Buffer,
  key: string,
  contentType = "application/octet-stream",
): Promise<{ storagePath: string; sha256: string; sizeBytes: number }> {
  const problems = configProblems();
  if (problems.length > 0) throw new StorageUnavailableError(problems);

  const safeKey = assertSafeKey(key);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (DRIVER === "s3") {
    const { module, client } = await s3();
    await client.send(
      new module.PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: safeKey,
        Body: buffer,
        ContentType: contentType,
        // No ACL is sent: the bucket must remain private. R2 does not implement
        // object ACLs, and S3 buckets should deny public access at bucket level.
        ServerSideEncryption: isAwsS3() ? "AES256" : undefined,
      }),
    );
  } else {
    const target = localPath(safeKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer, { mode: 0o600 });
  }
  return { storagePath: safeKey, sha256, sizeBytes: buffer.length };
}

export async function readBuffer(key: string): Promise<Buffer> {
  const problems = configProblems();
  if (problems.length > 0) throw new StorageUnavailableError(problems);

  const safeKey = assertSafeKey(key);
  if (DRIVER === "s3") {
    const { module, client } = await s3();
    const response = await client.send(new module.GetObjectCommand({ Bucket: env.S3_BUCKET, Key: safeKey }));
    if (!response.Body) throw new Error("The stored file could not be read.");
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
  return fs.readFile(localPath(safeKey));
}

export async function objectExists(key: string): Promise<boolean> {
  const safeKey = assertSafeKey(key);
  try {
    if (DRIVER === "s3") {
      const { module, client } = await s3();
      await client.send(new module.HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: safeKey }));
      return true;
    }
    await fs.access(localPath(safeKey));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const safeKey = assertSafeKey(key);
  if (DRIVER === "s3") {
    const { module, client } = await s3();
    await client.send(new module.DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: safeKey }));
    return;
  }
  await fs.rm(localPath(safeKey), { force: true });
}

/** Short-lived presigned URL for object storage; null for the local driver. */
export async function presignedDownloadUrl(
  key: string,
  filename: string,
  ttlSeconds = env.UPLOAD_LINK_TTL_MINUTES * 60,
): Promise<string | null> {
  if (DRIVER !== "s3") return null;
  const { module, client } = await s3();
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const dispositionFilename = sanitizeFilename(filename).replace(/["\\\r\n]/g, "");
  return getSignedUrl(
    client,
    new module.GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: assertSafeKey(key),
      ResponseContentDisposition: `attachment; filename="${dispositionFilename}"`,
    }),
    { expiresIn: Math.min(3600, Math.max(30, ttlSeconds)) },
  );
}

/**
 * Stores an attachment under an organization-scoped key.
 * The organization id must come from server-side tenant context.
 */
export async function saveAttachmentForOrganization(
  buffer: Buffer,
  filename: string,
  organizationId: string,
  options: { now?: Date } = {},
): Promise<{ storedName: string; storagePath: string; sha256: string; sizeBytes: number }> {
  if (!organizationId) throw new Error("A tenant is required to store a file.");
  const extension = path.extname(filename).slice(0, 8);
  const objectName = crypto.randomBytes(16).toString("hex");
  const month = (options.now ?? new Date()).toISOString().slice(0, 7);
  const key = buildTenantAttachmentKey(organizationId, objectName, month, extension);
  const stored = await saveBuffer(buffer, key);
  return { storedName: path.basename(key), storagePath: stored.storagePath, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
}

export async function readAttachment(storagePath: string): Promise<Buffer> {
  return readBuffer(storagePath);
}

/** Verifies the storage driver can write, read back and delete a probe object. */
export async function testStorage(): Promise<{ ok: boolean; detail: string }> {
  const readiness = storageReadiness();
  if (!readiness.ok) return { ok: false, detail: readiness.detail };
  const key = `system/health/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.txt`;
  try {
    await saveBuffer(Buffer.from("ok"), key, "text/plain");
    const read = await readBuffer(key);
    await deleteObject(key);
    if (read.toString("utf8") !== "ok") return { ok: false, detail: "Stored file could not be read back." };
    return {
      ok: true,
      detail:
        DRIVER === "s3"
          ? "Object storage is writable and readable."
          : "Local storage volume is writable and readable.",
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Storage test failed.",
    };
  }
}

/** Expiring, HMAC-signed download links so attachment URLs cannot be guessed. */
export function signDownloadToken(attachmentId: string, ttlMinutes = env.UPLOAD_LINK_TTL_MINUTES): string {
  const expires = Date.now() + ttlMinutes * 60 * 1000;
  const payload = `${attachmentId}.${expires}`;
  const sig = crypto.createHmac("sha256", env.AUTH_SECRET).update(payload).digest("base64url");
  return `${expires}.${sig}`;
}

export function verifyDownloadToken(attachmentId: string, token: string): boolean {
  const [expiresRaw, sig] = token.split(".");
  const expires = Number(expiresRaw);
  if (!expires || !sig || Number.isNaN(expires) || expires < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", env.AUTH_SECRET)
    .update(`${attachmentId}.${expires}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
