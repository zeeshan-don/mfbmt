/**
 * Storage configuration validation, shared by env.ts (production safety) and
 * storage.ts (the driver). Kept dependency-free so neither module imports the
 * other and creates a cycle.
 *
 * Two mistakes are treated as configuration failures rather than silently
 * degrading:
 *   * an unknown STORAGE_DRIVER (never fall back to local disk), and
 *   * local disk in production without an explicit persistent-volume opt-in.
 *
 * S3 covers Cloudflare R2, AWS S3 and compatible providers. Their endpoint and
 * region conventions differ:
 *   * Cloudflare R2  endpoint https://<account>.r2.cloudflarestorage.com, region "auto"
 *   * AWS S3         no custom endpoint, a real region such as eu-central-1
 *   * MinIO/other    a custom endpoint and the region the server expects
 */

export type StorageEnvInput = {
  NODE_ENV?: string;
  STORAGE_DRIVER?: string;
  STORAGE_ALLOW_LOCAL_VOLUME?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
};

export type StorageProblem = { variable: string; problem: string };

export type StorageDriverName = "local" | "s3";

const FALSEY = new Set(["", "false", "0", "no", "off"]);

function truthy(value: string | undefined): boolean {
  return !FALSEY.has((value ?? "").trim().toLowerCase());
}

/** `s3` is the only remote driver; anything else is a configuration error. */
export function configuredRemoteDriver(input: StorageEnvInput): "s3" | null {
  const raw = (input.STORAGE_DRIVER ?? "local").trim().toLowerCase();
  return raw === "s3" ? "s3" : null;
}

export function isUnknownStorageDriver(input: StorageEnvInput): boolean {
  const raw = (input.STORAGE_DRIVER ?? "local").trim().toLowerCase();
  return raw !== "local" && raw !== "s3";
}

/** True when local disk is being used deliberately on a persistent volume. */
export function localVolumeAllowed(input: StorageEnvInput): boolean {
  return truthy(input.STORAGE_ALLOW_LOCAL_VOLUME);
}

export function storageConfigProblems(input: StorageEnvInput): StorageProblem[] {
  const problems: StorageProblem[] = [];
  const raw = (input.STORAGE_DRIVER ?? "local").trim().toLowerCase();

  if (isUnknownStorageDriver(input)) {
    problems.push({
      variable: "STORAGE_DRIVER",
      problem: `must be "local" or "s3" (got "${raw}"). Files can never silently fall back to local disk.`,
    });
    return problems;
  }

  const production = input.NODE_ENV === "production";

  if (raw === "local") {
    if (production && !localVolumeAllowed(input)) {
      problems.push({
        variable: "STORAGE_DRIVER",
        problem:
          "is local in production. Vercel's filesystem is ephemeral; uploads would be lost and could not be read by the worker. " +
          "Set STORAGE_DRIVER=s3, or set STORAGE_ALLOW_LOCAL_VOLUME=true only when a persistent volume is actually mounted.",
      });
    }
    return problems;
  }

  for (const name of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
    if (!input[name]?.trim()) {
      problems.push({ variable: name, problem: "is required when STORAGE_DRIVER=s3." });
    }
  }

  const endpoint = (input.S3_ENDPOINT ?? "").trim();
  const region = (input.S3_REGION ?? "").trim();
  const forcePathStyle = (input.S3_FORCE_PATH_STYLE ?? "").trim();

  if (endpoint) {
    if (!/^https?:\/\/[^\s]+$/i.test(endpoint)) {
      problems.push({ variable: "S3_ENDPOINT", problem: "must be an http(s) URL, for example https://<account>.r2.cloudflarestorage.com." });
    }
    if (region && region !== "auto" && !/^[a-z0-9-]{2,40}$/i.test(region)) {
      problems.push({ variable: "S3_REGION", problem: "is not a valid region name." });
    }
  } else {
    // No endpoint means AWS S3 itself, which needs a real region. "auto" is a
    // Cloudflare R2 convention and would sign requests for the wrong service.
    if (!region || region === "auto") {
      problems.push({
        variable: "S3_REGION",
        problem:
          "must be the real AWS region (for example eu-central-1) when S3_ENDPOINT is empty. " +
          '"auto" is only valid for Cloudflare R2, which always has an account endpoint.',
      });
    }
  }

  if (forcePathStyle && !/^(true|false)$/i.test(forcePathStyle)) {
    problems.push({ variable: "S3_FORCE_PATH_STYLE", problem: "must be true or false." });
  }

  return problems;
}

/** Whether a write/read may be attempted at all. */
export function storageConfigurationUsable(input: StorageEnvInput): boolean {
  return storageConfigProblems(input).length === 0;
}

/**
 * Tenant-scoped object key. The organization id must come from server-side
 * tenant context, never from a request body. The random object name makes the
 * URL unguessable even inside one tenant.
 */
export function buildTenantAttachmentKey(organizationId: string, randomId: string, month: string, extension: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(organizationId)) {
    throw new Error("A valid organization is required to store a file.");
  }
  const monthNumber = month.slice(5, 7);
  const monthName = month.slice(0, 4);
  if (!/^[0-9a-f]{16,64}$/.test(randomId)) {
    throw new Error("Invalid storage object name.");
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^\d{4}$/.test(monthName) || Number(monthNumber) > 12) {
    throw new Error("Invalid storage month.");
  }
  // Only known-safe extensions are kept for readability. An archive, script or
  // executable suffix is dropped rather than stored on the object name.
  const safeExtensions = new Set([".pdf", ".xlsx", ".xls", ".csv", ".txt", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".docx", ".doc", ".zip", ".xlsb"]);
  const safeExtension = safeExtensions.has(extension.toLowerCase()) ? extension.toLowerCase() : "";
  return `organizations/${organizationId}/attachments/${month}/${randomId}${safeExtension}`;
}

export function tenantKeyPrefix(organizationId: string): string {
  return `organizations/${organizationId}/`;
}

export type KeyOwnership = "owned" | "foreign" | "legacy";

/**
 * Classifies a stored key. `legacy` keys predate tenant prefixes and carry no
 * organization, so callers must verify ownership from the database record
 * instead. `foreign` keys must never be served to another tenant.
 */
export function storageKeyOwnership(key: string, organizationId: string): KeyOwnership {
  if (key.startsWith("organizations/")) {
    return key.startsWith(tenantKeyPrefix(organizationId)) ? "owned" : "foreign";
  }
  return "legacy";
}
