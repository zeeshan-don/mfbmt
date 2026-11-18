import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  releaseExpiredJobs,
  retryJob,
  recordWorkerHeartbeat,
  workerLiveness,
} from "../src/lib/workflow/jobs";

async function makeJob(maxAttempts = 4) {
  return enqueueJob({
    type: "EXTRACT_ENQUIRY",
    payload: { enquiryId: randomUUID() },
    idempotencyKey: `job-${randomUUID()}`,
    maxAttempts,
  });
}

function expireLease(jobId: string) {
  return db.backgroundJob.update({
    where: { id: jobId },
    data: {
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lockedAt: new Date(Date.now() - 120_000),
    },
  });
}

beforeEach(async () => {
  await db.backgroundJob.deleteMany();
  await db.workerHeartbeat.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("durable queue concurrency", () => {
  it("treats only the real unique-key conflict as a duplicate enqueue", async () => {
    const key = `dup-${randomUUID()}`;
    const [first, second] = await Promise.all([
      enqueueJob({ type: "EXTRACT_ENQUIRY", payload: {}, idempotencyKey: key }),
      enqueueJob({ type: "EXTRACT_ENQUIRY", payload: {}, idempotencyKey: key }),
    ]);
    expect(first.id).toBe(second.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await db.backgroundJob.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("never lets two concurrent workers claim the same job", async () => {
    const jobs = await Promise.all([makeJob(), makeJob(), makeJob(), makeJob()]);
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) => claimJob(`worker-${index}`)),
    );
    const claimed = claims.filter((claim): claim is NonNullable<typeof claim> => claim != null);
    expect(claimed).toHaveLength(jobs.length);
    expect(new Set(claimed.map((job) => job.id)).size).toBe(jobs.length);
    const processing = await db.backgroundJob.count({ where: { status: "PROCESSING" } });
    expect(processing).toBe(jobs.length);
  });

  it("lets only one of two concurrent completions write the result", async () => {
    const job = await makeJob();
    await claimJob("worker-a");
    const results = await Promise.all([
      completeJob(job.id, "worker-a", "one"),
      completeJob(job.id, "worker-a", "two"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses completion from a worker whose lease expired and was reclaimed", async () => {
    const job = await makeJob();
    await claimJob("worker-a");
    await expireLease(job.id);
    const recovered = await releaseExpiredJobs();
    expect(recovered.requeued).toBeGreaterThanOrEqual(1);

    const claimedByB = await claimJob("worker-b");
    expect(claimedByB?.id).toBe(job.id);

    const completed = await completeJob(job.id, "worker-a", "stale result");
    expect(completed).toBe(false);
    const current = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(current?.status).toBe("PROCESSING");
    expect(current?.lockedBy).toBe("worker-b");
  });

  it("refuses a failure from a stale worker and does not disturb the new owner", async () => {
    const job = await makeJob();
    await claimJob("worker-a");
    await expireLease(job.id);
    await releaseExpiredJobs();
    await claimJob("worker-b");

    const outcome = await failJob(job.id, "worker-a", "stale failure");
    expect(outcome).toBe("lost");
    const current = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(current?.status).toBe("PROCESSING");
    expect(current?.lockedBy).toBe("worker-b");
    expect(current?.lastError).toBeNull();
  });

  it("honours each job's own maxAttempts when a lease expires", async () => {
    const single = await makeJob(1);
    await claimJob("worker-a");
    await expireLease(single.id);
    await releaseExpiredJobs();
    const failed = await db.backgroundJob.findUnique({ where: { id: single.id } });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.deadLetteredAt).not.toBeNull();

    const generous = await makeJob(5);
    await claimJob("worker-a");
    await expireLease(generous.id);
    await releaseExpiredJobs();
    const requeued = await db.backgroundJob.findUnique({ where: { id: generous.id } });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.attempts).toBe(1);

    await claimJob("worker-b");
    await expireLease(generous.id);
    await releaseExpiredJobs();
    const again = await db.backgroundJob.findUnique({ where: { id: generous.id } });
    expect(again?.status).toBe("QUEUED");
    expect(again?.attempts).toBe(2);
  });

  it("dead-letters a job only after its configured attempts are exhausted", async () => {
    const job = await makeJob(2);
    await claimJob("worker-a");
    const first = await failJob(job.id, "worker-a", "boom");
    expect(first).toBe("retry");
    await db.backgroundJob.update({ where: { id: job.id }, data: { runAfter: new Date(Date.now() - 1000) } });
    await claimJob("worker-a");
    const second = await failJob(job.id, "worker-a", "boom again");
    expect(second).toBe("failed");
    const row = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(2);
  });

  it("reports worker liveness from the heartbeat registry, not an empty queue", async () => {
    expect((await workerLiveness(60_000)).status).toBe("UNKNOWN");
    await recordWorkerHeartbeat("worker-healthy", { status: "idle" });
    const healthy = await workerLiveness(60_000);
    expect(healthy.status).toBe("HEALTHY");
    expect(healthy.workersSeen).toBe(1);

    await db.workerHeartbeat.update({
      where: { workerId: "worker-healthy" },
      data: { lastSeenAt: new Date(Date.now() - 120_000) },
    });
    expect((await workerLiveness(60_000)).status).toBe("STALE");
  });

  it("does not reopen completed or cancelled jobs through the retry path", async () => {
    const completed = await makeJob();
    await claimJob("worker-a");
    await completeJob(completed.id, "worker-a");
    await expect(retryJob(completed.id, "owner")).rejects.toThrow(/completed/i);

    const cancelled = await makeJob();
    await db.backgroundJob.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    await expect(retryJob(cancelled.id, "owner")).rejects.toThrow(/cancelled/i);
  });
});
