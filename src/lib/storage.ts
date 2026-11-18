import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * File storage with two drivers:
 *  - `local`  persistent server volume (development, or a VPS with a mounted disk)
 *  - `s3`     any S3-compatible object store (Cloudflare R2, AWS S3, MinIO)
 *
 * Objects are private. Downloads go through the application (authenticated or
 * HMAC-signed) or a short-lived presigned URL; there is no public bucket URL.
 */

const STORAGE_ROOT = path.resolve(process.cwd(), env.STORAGE_ROOT);
const DRIVER = env.STORAGE_DRIVER === "s3" ? "s3" : "local";

export const storageDriver = DRIVER;

export const ALLOWED_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.ms-excel": "excel",
  "text/csv": "csv",
  "text/plain": "text",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/heic": "image",
  "image/heif": "image",
} as const;

export type FileFamily = "pdf" | "excel" | "csv" | "text" | "image" | "other";

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
    const text = buffer.subarray(0, Math.min(buffer.length, 4000)).toString("latin1");
    if (text.includes("xl/worksheets") || text.includes("[Content_Types].xml")) {
      return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "excel" };
    }
    return { mime: "application/zip", family: "other" };
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
    normalized.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("Invalid storage key.");
  }
  return normalized;
}

export function assertAllowedUpload(
  buffer: Buffer,
  declaredName: string,
): { ok: true; mime: string; family: FileFamily; filename: string } | { ok: false; error: string } {
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (buffer.length === 0) return { ok: false, error: "The file is empty." };
  if (buffer.length > maxBytes) {
    return { ok: false, error: `The file is larger than ${env.MAX_UPLOAD_MB} MB.` };
  }
  const sniffed = sniffType(buffer);
  const allowedFamilies: FileFamily[] = ["pdf", "excel", "csv", "text", "image"];
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

async function s3(): Promise<{ module: S3Module; client: InstanceType<S3Module["S3Client"]> }> {
  if (!s3Module) s3Module = await import("@aws-sdk/client-s3");
  if (!s3Client) {
    s3Client = new s3Module.S3Client({
      region: env.S3_REGION || "auto",
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
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

/** Writes an object and returns its key. */
export async function saveBuffer(
  buffer: Buffer,
  key: string,
  contentType = "application/octet-stream",
): Promise<{ storagePath: string; sha256: string; sizeBytes: number }> {
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
        ServerSideEncryption: env.S3_ENDPOINT.includes("amazonaws.com") ? "AES256" : undefined,
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
  try {
    await readBuffer(key);
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
  return getSignedUrl(
    client,
    new module.GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: assertSafeKey(key),
      ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
    }),
    { expiresIn: Math.max(30, ttlSeconds) },
  );
}

export async function saveAttachment(
  buffer: Buffer,
  filename: string,
): Promise<{ storedName: string; storagePath: string; sha256: string; sizeBytes: number }> {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const ext = path.extname(filename).slice(0, 8);
  const storedName = `${sha256.slice(0, 24)}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const month = new Date().toISOString().slice(0, 7);
  const stored = await saveBuffer(buffer, `attachments/${month}/${storedName}`);
  return { storedName, storagePath: stored.storagePath, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
}

export async function readAttachment(storagePath: string): Promise<Buffer> {
  return readBuffer(storagePath);
}

/** Verifies the storage driver can write and read back. */
export async function testStorage(): Promise<{ ok: boolean; detail: string }> {
  const key = `health/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  try {
    await saveBuffer(Buffer.from("ok"), key, "text/plain");
    const read = await readBuffer(key);
    await deleteObject(key);
    if (read.toString("utf8") !== "ok") return { ok: false, detail: "Stored file could not be read back." };
    return {
      ok: true,
      detail:
        DRIVER === "s3"
          ? `Object storage ${env.S3_BUCKET} is writable and readable.`
          : `Local storage ${env.STORAGE_ROOT} is writable and readable.`,
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
