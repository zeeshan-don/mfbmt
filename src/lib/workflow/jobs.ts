import { db } from "../db";
import { stringifyJson } from "../json";
import { env } from "../env";
import { JOB_TYPES } from "../constants";

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Durable job queue with leases.
 *
 * A job is claimed atomically (SELECT … FOR UPDATE SKIP LOCKED), receives a
 * lease, and must renew that lease while it runs. A worker whose lease expired
 * can no longer complete or fail the job, so a long-running task is never
 * executed twice with both results written.
 */

export const LEASE_MS = () => Math.max(60_000, env.WORKER_STALE_MS);

export async function enqueueJob(input: {
  type: JobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAfter?: Date;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const existing = await db.backgroundJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { id: existing.id, created: false };
  try {
    const job = await db.backgroundJob.create({
      data: {
        type: input.type,
        payloadJson: stringifyJson(input.payload),
        idempotencyKey: input.idempotencyKey,
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 4,
      },
    });
    return { id: job.id, created: true };
  } catch {
    // Another process inserted the same key first; that is the intended outcome.
    const job = await db.backgroundJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (!job) throw new Error("Could not enqueue the background job.");
    return { id: job.id, created: false };
  }
}

/** Recovers jobs whose worker died. Exhausted attempts are dead-lettered, not retried forever. */
export async function releaseExpiredJobs(): Promise<{ requeued: number; failed: number }> {
  const now = new Date();
  const requeued = await db.backgroundJob.updateMany({
    where: {
      status: "PROCESSING",
      OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null, lockedAt: { lt: new Date(now.getTime() - LEASE_MS()) } }],
      attempts: { lt: 4 },
    },
    data: { status: "QUEUED", lockedAt: null, lockedBy: null, leaseExpiresAt: null, heartbeatAt: null },
  });
  const failed = await db.$executeRaw`
    UPDATE "BackgroundJob"
       SET status = 'FAILED',
           "deadLetteredAt" = now(),
           "lastError" = COALESCE("lastError", 'The worker stopped before this job finished.'),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL
     WHERE status = 'PROCESSING'
       AND (("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < now())
            OR ("leaseExpiresAt" IS NULL AND "lockedAt" < now() - interval '10 minutes'))
       AND attempts >= 4
  `;
  return { requeued: requeued.count, failed: Number(failed) };
}

export type ClaimedJob = {
  id: string;
  type: string;
  payloadJson: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
};

/** Atomically claims the next due job and gives this worker the lease. */
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const leaseSeconds = Math.round(LEASE_MS() / 1000);
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "BackgroundJob"
       SET status = 'PROCESSING',
           "lockedBy" = ${workerId},
           "lockedAt" = now(),
           "heartbeatAt" = now(),
           "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds}),
           attempts = attempts + 1
     WHERE id = (
       SELECT id FROM "BackgroundJob"
        WHERE status = 'QUEUED' AND "runAfter" <= now()
        ORDER BY "runAfter" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  const job = await db.backgroundJob.findUnique({ where: { id } });
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    payloadJson: job.payloadJson,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lockedBy: workerId,
  };
}

/** Extends the lease. Returns false when this worker no longer owns the job. */
export async function heartbeatJob(jobId: string, workerId: string): Promise<boolean> {
  const leaseSeconds = Math.round(LEASE_MS() / 1000);
  const result = await db.$executeRaw`
    UPDATE "BackgroundJob"
       SET "heartbeatAt" = now(),
           "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds})
     WHERE id = ${jobId} AND status = 'PROCESSING' AND "lockedBy" = ${workerId}
  `;
  return Number(result) > 0;
}

export async function completeJob(jobId: string, workerId: string, progress?: string): Promise<boolean> {
  const result = await db.backgroundJob.updateMany({
    where: { id: jobId, status: "PROCESSING", lockedBy: workerId },
    data: {
      status: "COMPLETED",
      progress: progress ?? "Done",
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: null,
    },
  });
  return result.count > 0;
}

export async function failJob(jobId: string, workerId: string, error: string): Promise<"retry" | "failed" | "lost"> {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "PROCESSING" || job.lockedBy !== workerId) return "lost";
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(15 * 60 * 1000, 20_000 * Math.pow(2, Math.max(0, job.attempts - 1)));
  await db.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: exhausted ? "FAILED" : "QUEUED",
      lastError: error.slice(0, 900),
      runAfter: exhausted ? job.runAfter : new Date(Date.now() + backoffMs),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      deadLetteredAt: exhausted ? new Date() : null,
      progress: exhausted ? "Failed — needs manual retry" : `Will retry (attempt ${job.attempts + 1})`,
    },
  });
  return exhausted ? "failed" : "retry";
}

/** Owner-initiated retry of a dead-lettered job. */
export async function retryJob(jobId: string, actor: string) {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if (job.status === "PROCESSING") throw new Error("This job is currently running.");
  await db.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: "QUEUED",
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      progress: `Retried by ${actor}`,
    },
  });
}

export async function cancelJob(jobId: string) {
  await db.backgroundJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "FAILED"] } },
    data: { status: "CANCELLED", lockedAt: null, lockedBy: null, progress: "Cancelled" },
  });
}

export async function queueStats() {
  const [queued, processing, failed, completed] = await Promise.all([
    db.backgroundJob.count({ where: { status: "QUEUED" } }),
    db.backgroundJob.count({ where: { status: "PROCESSING" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
    db.backgroundJob.count({ where: { status: "COMPLETED" } }),
  ]);
  return { queued, processing, failed, completed };
}

export async function recentJobs(limit = 40) {
  return db.backgroundJob.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}
