import { db } from "../db";
import { stringifyJson } from "../json";
import { JOB_TYPES } from "../constants";

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

const STALE_LOCK_MS = 10 * 60 * 1000;

export async function enqueueJob(input: {
  type: JobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAfter?: Date;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const existing = await db.backgroundJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { id: existing.id, created: false };
  const job = await db.backgroundJob.create({
    data: {
      type: input.type,
      payloadJson: stringifyJson(input.payload),
      idempotencyKey: input.idempotencyKey,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
    },
  });
  return { id: job.id, created: true };
}

/** Recovers jobs whose worker died mid-processing. */
export async function releaseStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const result = await db.backgroundJob.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: { status: "QUEUED", lockedAt: null, lockedBy: null },
  });
  return result.count;
}

export async function claimJob(workerId: string) {
  const job = await db.backgroundJob.findFirst({
    where: { status: "QUEUED", runAfter: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return null;
  const claimed = await db.backgroundJob.updateMany({
    where: { id: job.id, status: "QUEUED" },
    data: {
      status: "PROCESSING",
      lockedAt: new Date(),
      lockedBy: workerId,
      attempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return db.backgroundJob.findUnique({ where: { id: job.id } });
}

export async function completeJob(jobId: string, progress?: string) {
  await db.backgroundJob.update({
    where: { id: jobId },
    data: { status: "COMPLETED", progress: progress ?? "Done", lockedAt: null, lockedBy: null, lastError: null },
  });
}

export async function failJob(jobId: string, error: string) {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(5 * 60 * 1000, 15_000 * Math.pow(2, Math.max(0, job.attempts - 1)));
  await db.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: exhausted ? "FAILED" : "QUEUED",
      lastError: error.slice(0, 900),
      runAfter: exhausted ? job.runAfter : new Date(Date.now() + backoffMs),
      lockedAt: null,
      lockedBy: null,
      progress: exhausted ? "Failed" : `Will retry (attempt ${job.attempts + 1})`,
    },
  });
}

export async function retryJob(jobId: string, actor: string) {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  await db.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: "QUEUED",
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      progress: `Retried by ${actor}`,
    },
  });
}

export async function cancelJob(jobId: string) {
  await db.backgroundJob.update({
    where: { id: jobId },
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
