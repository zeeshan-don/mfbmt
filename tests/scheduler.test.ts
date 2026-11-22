import { describe, expect, it } from "vitest";
import { EMAIL_SYNC_SCHEDULE_REMOVED, QSTASH_SCHEDULES } from "../src/lib/scheduling";

describe("scheduling architecture", () => {
  it("schedules only the job-processing watchdog", () => {
    expect(QSTASH_SCHEDULES).toHaveLength(1);
    expect(QSTASH_SCHEDULES[0].path).toBe("/api/cron/process-jobs");
    expect(QSTASH_SCHEDULES.some((schedule) => schedule.path.includes("email-sync"))).toBe(false);
  });

  it("marks the tenant-less email-sync schedule as removed", () => {
    expect(EMAIL_SYNC_SCHEDULE_REMOVED).toBe(true);
  });
});
