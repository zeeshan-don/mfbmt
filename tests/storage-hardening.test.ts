import { describe, expect, it } from "vitest";
import {
  buildTenantAttachmentKey,
  isUnknownStorageDriver,
  storageConfigProblems,
  storageKeyOwnership,
} from "../src/lib/storage-config";

const R2 = {
  NODE_ENV: "production",
  STORAGE_DRIVER: "s3",
  S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_BUCKET: "private-files",
  S3_ACCESS_KEY_ID: "placeholder",
  S3_SECRET_ACCESS_KEY: "placeholder",
};

describe("storage configuration", () => {
  it("refuses ephemeral local disk in production without an explicit volume opt-in", () => {
    const problems = storageConfigProblems({ NODE_ENV: "production", STORAGE_DRIVER: "local" });
    expect(problems.map((problem) => problem.variable)).toContain("STORAGE_DRIVER");
    expect(problems[0].problem).toMatch(/ephemeral|STORAGE_ALLOW_LOCAL_VOLUME/i);
  });

  it("allows local storage on an explicitly configured persistent volume", () => {
    expect(
      storageConfigProblems({
        NODE_ENV: "production",
        STORAGE_DRIVER: "local",
        STORAGE_ALLOW_LOCAL_VOLUME: "true",
      }),
    ).toHaveLength(0);
  });

  it("accepts a Cloudflare R2 configuration with the auto region and account endpoint", () => {
    expect(storageConfigProblems(R2)).toHaveLength(0);
  });

  it("accepts AWS S3 with a real region and no custom endpoint", () => {
    expect(
      storageConfigProblems({
        ...R2,
        S3_ENDPOINT: "",
        S3_REGION: "eu-central-1",
      }),
    ).toHaveLength(0);
  });

  it("rejects AWS S3 with an empty endpoint and the R2 auto region", () => {
    const problems = storageConfigProblems({ ...R2, S3_ENDPOINT: "", S3_REGION: "auto" });
    expect(problems.map((problem) => problem.variable)).toContain("S3_REGION");
  });

  it("rejects an unknown driver instead of silently using local disk", () => {
    expect(isUnknownStorageDriver({ STORAGE_DRIVER: "gcs" })).toBe(true);
    const problems = storageConfigProblems({ NODE_ENV: "production", STORAGE_DRIVER: "gcs" });
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/never silently fall back/i);
  });

  it("requires bucket, key and secret for object storage", () => {
    const problems = storageConfigProblems({ ...R2, S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" });
    expect(problems.map((problem) => problem.variable)).toEqual(
      expect.arrayContaining(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
    );
  });

  it("rejects a non-URL endpoint and an invalid path-style flag", () => {
    const problems = storageConfigProblems({ ...R2, S3_ENDPOINT: "account.r2.cloudflarestorage.com", S3_FORCE_PATH_STYLE: "yes" });
    expect(problems.map((problem) => problem.variable)).toEqual(
      expect.arrayContaining(["S3_ENDPOINT", "S3_FORCE_PATH_STYLE"]),
    );
  });
});

describe("tenant-scoped attachment keys", () => {
  it("builds an opaque organization-scoped key", () => {
    const key = buildTenantAttachmentKey("org_ogs", "0123456789abcdef0123456789abcdef", "2026-11", ".PDF");
    expect(key).toBe("organizations/org_ogs/attachments/2026-11/0123456789abcdef0123456789abcdef.pdf");
    expect(storageKeyOwnership(key, "org_ogs")).toBe("owned");
    expect(storageKeyOwnership(key, "org_mfbmt")).toBe("foreign");
  });

  it("refuses an invalid organization id and traversal-shaped object name", () => {
    expect(() => buildTenantAttachmentKey("../org_ogs", "0123456789abcdef", "2026-11", ".pdf")).toThrow();
    expect(() => buildTenantAttachmentKey("org_ogs", "../../../etc/passwd", "2026-11", ".pdf")).toThrow();
    expect(() => buildTenantAttachmentKey("org_ogs", "0123456789abcdef", "2026-13", ".pdf")).toThrow();
  });

  it("drops a dangerous extension instead of appending it", () => {
    const key = buildTenantAttachmentKey("org_ogs", "0123456789abcdef", "2026-11", ".exe");
    expect(key.endsWith("0123456789abcdef")).toBe(true);
  });

  it("treats pre-tenant keys as legacy, never as another tenant's key", () => {
    expect(storageKeyOwnership("attachments/2026-11/abc.pdf", "org_ogs")).toBe("legacy");
  });
});
