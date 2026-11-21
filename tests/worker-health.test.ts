import { describe, expect, it } from "vitest";
import { markWorkerLoop, workerHealthPayload } from "../src/lib/worker-health";
import { cronAuthorized } from "../src/lib/cron-auth";

describe("worker liveness", () => {
  it("reports healthy immediately after a loop and unhealthy when the loop is stale", () => {
    markWorkerLoop(false);
    const now = Date.now();
    expect(workerHealthPayload(now).status).toBe("ok");
    expect(workerHealthPayload(now + 10 * 60 * 1000).status).toBe("unhealthy");
  });

  it("treats an in-flight job as healthy even during a long handler", () => {
    markWorkerLoop(true);
    expect(workerHealthPayload(Date.now() + 10 * 60 * 1000).status).toBe("ok");
    markWorkerLoop(false);
  });
});

describe("cron authentication", () => {
  it("refuses a request with no configured secret and no bearer", () => {
    const result = cronAuthorized(new Request("http://localhost/api/cron/process-jobs"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect([401, 503]).toContain(result.status);
  });
});
