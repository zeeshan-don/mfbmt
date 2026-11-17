import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

const STORAGE_ROOT = path.resolve(process.cwd(), env.STORAGE_ROOT);

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
  if (head.subarray(4, 12).toString("latin1").includes("ftyphei") || head.subarray(4, 12).toString("latin1").includes("ftypmif1")) {
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
      error: "This file type is not supported. Use PDF, Excel, CSV, text or an image.",
    };
  }
  return { ok: true, mime: sniffed.mime, family: sniffed.family, filename: sanitizeFilename(declaredName) };
}

export async function saveAttachment(
  buffer: Buffer,
  filename: string,
): Promise<{ storedName: string; storagePath: string; sha256: string; sizeBytes: number }> {
  const dir = path.join(STORAGE_ROOT, new Date().toISOString().slice(0, 7));
  await fs.mkdir(dir, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const ext = path.extname(filename).slice(0, 8);
  const storedName = `${sha256.slice(0, 24)}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const target = path.join(dir, storedName);
  await fs.writeFile(target, buffer, { mode: 0o600 });
  return {
    storedName,
    storagePath: path.relative(STORAGE_ROOT, target).split(path.sep).join("/"),
    sha256,
    sizeBytes: buffer.length,
  };
}

export async function readAttachment(storagePath: string): Promise<Buffer> {
  const resolved = path.resolve(STORAGE_ROOT, storagePath);
  if (!resolved.startsWith(STORAGE_ROOT)) throw new Error("Invalid attachment path");
  return fs.readFile(resolved);
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
