import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@upstash/qstash", () => {
  const Receiver = vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockResolvedValue(true),
  }));
  return { Receiver };
});

import { qstashAuthorized, cronOrQStashAuthorized } from "../src/lib/qstash";
import { env } from "../src/lib/env";

describe("QStash authorization", () => {
  beforeEach(() => {
    env.QSTASH_CURRENT_SIGNING_KEY = "test-current-signing-key";
    env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
    env.APP_URL = "http://localhost:3000";
    env.CRON_SECRET = "";
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a request with a valid signature", async () => {
    const req = new Request("http://localhost:3000/api/cron/process-jobs", {
      method: "POST",
      headers: { "upstash-signature": "valid.sig.here", "upstash-region": "us-east-1" },
      body: "{}",
    });
    const result = await qstashAuthorized(req, "/api/cron/process-jobs");
    expect(result.ok).toBe(true);
  });

  it("rejects a request with an invalid signature", async () => {
    const { Receiver } = await import("@upstash/qstash");
    (Receiver as any).mockImplementationOnce(() => ({
      verify: vi.fn().mockRejectedValue(new Error("bad signature")),
    }));
    const req = new Request("http://localhost:3000/api/cron/process-jobs", {
      method: "POST",
      headers: { "upstash-signature": "invalid.sig" },
      body: "{}",
    });
    const result = await qstashAuthorized(req, "/api/cron/process-jobs");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 503 when signing keys are not configured", async () => {
    env.QSTASH_CURRENT_SIGNING_KEY = "";
    env.QSTASH_NEXT_SIGNING_KEY = "";
    const req = new Request("http://localhost:3000/api/cron/process-jobs", { method: "POST" });
    const result = await qstashAuthorized(req, "/api/cron/process-jobs");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("rejects when the signature header is missing but keys are configured", async () => {
    const req = new Request("http://localhost:3000/api/cron/process-jobs", { method: "POST", body: "{}" });
    const result = await qstashAuthorized(req, "/api/cron/process-jobs");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("cronOrQStashAuthorized accepts a valid bearer token fallback", async () => {
    env.CRON_SECRET = "test-cron-secret-value-long-enough";
    const req = new Request("http://localhost:3000/api/cron/process-jobs", {
      method: "GET",
      headers: { authorization: "Bearer test-cron-secret-value-long-enough" },
    });
    const result = await cronOrQStashAuthorized(req, "/api/cron/process-jobs");
    expect(result.ok).toBe(true);
  });
});
