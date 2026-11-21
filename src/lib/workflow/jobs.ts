import { db } from "../db";
import { rawDb } from "../db-base";
import { stringifyJson } from "../json";
import { env } from "../env";
import { JOB_STATUS, JOB_TYPES } from "../constants";
import { getTenantId, requireTenantId } from "../tenant";

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Durable job queue with leases.
 *
 * Every job belongs to an organization. The worker claims work across tenants
 * through the unscoped client, then executes it inside the owning tenant's
 * context so every query, integration lookup and audit entry is scoped.
 *
 * A job is claimed atomically (SELECT … FOR UPDATE SKIP LOCKED), receives a
 * lease, and must renew that lease while it runs. Every terminal transition is
 * a compare-and-set on (id, status, lockedBy, unexpired lease), so a worker
 * whose lease lapsed can never overwrite a job that another worker reclaimed.
 */

export const LEASE_MS = () => Math.max(60_000, env.WORKER_STALE_MS);

export async function enqueueJob(input: {
  type: JobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAfter?: Date;
  maxAttempts?: number;
}): Promise<{ id: string; created: boolean }> {
  const organizationId = await requireTenantId();
  // ON CONFLICT DO NOTHING on (organizationId, idempotencyKey) is the only
  // duplicate path. Any connection/write failure still throws instead of
  // looking like an existing job.
  const inserted = await db.backgroundJob.createMany({
    data: [
      {
        organizationId,
        type: input.type,
        payloadJson: stringifyJson(input.payload),
        idempotencyKey: input.idempotencyKey,
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 4,
      },
    ],
    skipDuplicates: true,
  });
  const job = await db.backgroundJob.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: input.idempotencyKey } },
  });
  if (!job) throw new Error("Could not enqueue the background job.");
  return { id: job.id, created: inserted.count > 0 };
}

/**
 * Recovers jobs whose worker died. The per-job `maxAttempts` is authoritative;
 * there is no second hard-coded retry count. Exhausted jobs are dead-lettered.
 * This is a system-wide sweep, so it intentionally uses the unscoped client.
 */
export async function releaseExpiredJobs(): Promise<{ requeued: number; failed: number }> {
  const requeued = await rawDb.$executeRaw`
    UPDATE "BackgroundJob"
       SET status = 'QUEUED',
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "heartbeatAt" = NULL,
           progress = 'Recovered after the previous worker stopped'
     WHERE status = 'PROCESSING'
       AND attempts < "maxAttempts"
       AND COALESCE("leaseExpiresAt", "lockedAt" + make_interval(secs => ${Math.round(LEASE_MS() / 1000)})) < now()
  `;
  const failed = await rawDb.$executeRaw`
    UPDATE "BackgroundJob"
       SET status = 'FAILED',
           "deadLetteredAt" = now(),
           "lastError" = COALESCE("lastError", 'The worker stopped before this job finished.'),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "heartbeatAt" = NULL,
           progress = 'Stopped before this job finished — needs a manual retry'
     WHERE status = 'PROCESSING'
       AND attempts >= "maxAttempts"
       AND COALESCE("leaseExpiresAt", "lockedAt" + make_interval(secs => ${Math.round(LEASE_MS() / 1000)})) < now()
  `;
  return { requeued: Number(requeued), failed: Number(failed) };
}

export type ClaimedJob = {
  id: string;
  organizationId: string;
  type: string;
  payloadJson: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
};

/** Atomically claims the next due job across all organizations. */
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const leaseSeconds = Math.round(LEASE_MS() / 1000);
  const rows = await rawDb.$queryRaw<Array<{ id: string }>>`
    UPDATE "BackgroundJob"
       SET status = 'PROCESSING',
           "lockedBy" = ${workerId},
           "lockedAt" = now(),
           "heartbeatAt" = now(),
           "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds}),
           attempts = attempts + 1
     WHERE id = (
       SELECT id FROM "BackgroundJob"
        WHERE status = 'QUEUED' AND "runAfter" <= now() AND attempts < "maxAttempts"
        ORDER BY "runAfter" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  const job = await rawDb.backgroundJob.findUnique({ where: { id } });
  if (!job) return null;
  return {
    id: job.id,
    organizationId: job.organizationId,
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
  const result = await rawDb.$executeRaw`
    UPDATE "BackgroundJob"
       SET "heartbeatAt" = now(),
           "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds})
     WHERE id = ${jobId}
       AND status = 'PROCESSING'
       AND "lockedBy" = ${workerId}
       AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" > now())
  `;
  return Number(result) > 0;
}

/** Marks the job complete only if this worker still owns an unexpired lease. */
export async function completeJob(jobId: string, workerId: string, progress?: string): Promise<boolean> {
  const result = await rawDb.backgroundJob.updateMany({
    where: {
      id: jobId,
      status: JOB_STATUS.PROCESSING,
      lockedBy: workerId,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } }],
    },
    data: {
      status: JOB_STATUS.COMPLETED,
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

/**
 * Records a failure in one conditional statement. A stale worker (expired lease,
 * or a job already reclaimed by someone else) returns `"lost"` and mutates
 * nothing, so the new owner's state is preserved.
 */
export async function failJob(jobId: string, workerId: string, error: string): Promise<"retry" | "failed" | "lost"> {
  const rows = await rawDb.$queryRaw<Array<{ status: string }>>`
    UPDATE "BackgroundJob"
       SET status = CASE WHEN attempts >= "maxAttempts" THEN 'FAILED' ELSE 'QUEUED' END,
           "lastError" = ${error.slice(0, 900)},
           "runAfter" = CASE
             WHEN attempts >= "maxAttempts" THEN "runAfter"
             ELSE now() + make_interval(secs => LEAST(900, (20 * power(2, GREATEST(attempts - 1, 0)))::int))
           END,
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "heartbeatAt" = NULL,
           "deadLetteredAt" = CASE WHEN attempts >= "maxAttempts" THEN now() ELSE NULL END,
           progress = CASE
             WHEN attempts >= "maxAttempts" THEN 'Failed — needs manual retry'
             ELSE 'Will retry (attempt ' || (attempts + 1)::text || ')'
           END
     WHERE id = ${jobId}
       AND status = 'PROCESSING'
       AND "lockedBy" = ${workerId}
       AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" > now())
     RETURNING status
  `;
  const status = rows[0]?.status;
  if (!status) return "lost";
  return status === JOB_STATUS.FAILED ? "failed" : "retry";
}

/**
 * Releases every job still owned by a worker that is shutting down. Used after
 * the graceful-drain deadline. The same conditional lease rules apply, so a job
 * already reclaimed by another worker is never touched.
 */
export async function releaseJobsForWorker(workerId: string): Promise<number> {
  const rows = await rawDb.$queryRaw<Array<{ id: string }>>`
    UPDATE "BackgroundJob"
       SET status = CASE WHEN attempts >= "maxAttempts" THEN 'FAILED' ELSE 'QUEUED' END,
           "lastError" = COALESCE("lastError", 'Worker shut down before this job finished.'),
           "deadLetteredAt" = CASE WHEN attempts >= "maxAttempts" THEN now() ELSE NULL END,
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "heartbeatAt" = NULL,
           progress = CASE WHEN attempts >= "maxAttempts" THEN 'Failed — needs manual retry' ELSE 'Released by a graceful worker shutdown' END
     WHERE "lockedBy" = ${workerId}
       AND status = 'PROCESSING'
     RETURNING id
  `;
  return rows.length;
}

/** Owner-initiated retry of a dead-lettered job within the owner's company. */
export async function retryJob(jobId: string, actor: string) {
  const organizationId = await requireTenantId();
  const job = await db.backgroundJob.findFirst({ where: { id: jobId, organizationId } });
  if (!job) throw new Error("Job not found");
  if (job.status === JOB_STATUS.PROCESSING) throw new Error("This job is currently running.");
  if (job.status === JOB_STATUS.COMPLETED) throw new Error("This job already completed; there is nothing to retry.");
  if (job.status === JOB_STATUS.CANCELLED) throw new Error("This job was cancelled. Queue a new job instead.");
  if (job.status !== JOB_STATUS.FAILED) throw new Error("Only a failed job can be retried.");
  const result = await db.backgroundJob.updateMany({
    where: { id: jobId, organizationId, status: JOB_STATUS.FAILED },
    data: {
      status: JOB_STATUS.QUEUED,
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      deadLetteredAt: null,
      progress: `Retried by ${actor}`,
    },
  });
  if (result.count === 0) throw new Error("The job changed while it was being retried. Reload and try again.");
}

export async function cancelJob(jobId: string) {
  const organizationId = await requireTenantId();
  await db.backgroundJob.updateMany({
    where: { id: jobId, organizationId, status: { in: [JOB_STATUS.QUEUED, JOB_STATUS.FAILED] } },
    data: {
      status: JOB_STATUS.CANCELLED,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      progress: "Cancelled",
    },
  });
}

export async function queueStats() {
  const [queued, processing, failed, completed, cancelled] = await Promise.all([
    db.backgroundJob.count({ where: { status: JOB_STATUS.QUEUED } }),
    db.backgroundJob.count({ where: { status: JOB_STATUS.PROCESSING } }),
    db.backgroundJob.count({ where: { status: JOB_STATUS.FAILED } }),
    db.backgroundJob.count({ where: { status: JOB_STATUS.COMPLETED } }),
    db.backgroundJob.count({ where: { status: JOB_STATUS.CANCELLED } }),
  ]);
  return { queued, processing, failed, completed, cancelled };
}

export async function recentJobs(limit = 40) {
  return db.backgroundJob.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

// ── Worker liveness ─────────────────────────────────────────────────────────

/** Written by the worker on every poll and while a job runs. */
export async function recordWorkerHeartbeat(workerId: string, meta: Record<string, unknown> = {}) {
  const now = new Date();
  await rawDb.workerHeartbeat.upsert({
    where: { workerId },
    update: { lastSeenAt: now, metaJson: stringifyJson(meta) },
    create: {
      workerId,
      processName: process.env.pm_id ? `pm2:${process.env.pm_id}` : `pid:${process.pid}`,
      lastSeenAt: now,
      metaJson: stringifyJson(meta),
    },
  });
}

export type WorkerLiveness = {
  status: "HEALTHY" | "STALE" | "UNKNOWN";
  lastSeenAt: Date | null;
  staleAfterMs: number;
  workersSeen: number;
};

/**
 * Liveness comes from the worker registry, never from `BackgroundJob.heartbeatAt`
 * (which is cleared when a job completes). An empty registry is UNKNOWN, not healthy.
 */
export async function workerLiveness(staleAfterMs = env.WORKER_STALE_MS): Promise<WorkerLiveness> {
  const latest = await rawDb.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: "desc" } });
  if (!latest) return { status: "UNKNOWN", lastSeenAt: null, staleAfterMs, workersSeen: 0 };
  const workersSeen = await rawDb.workerHeartbeat.count({
    where: { lastSeenAt: { gte: new Date(Date.now() - staleAfterMs) } },
  });
  const age = Date.now() - latest.lastSeenAt.getTime();
  return {
    status: age <= staleAfterMs && workersSeen > 0 ? "HEALTHY" : "STALE",
    lastSeenAt: latest.lastSeenAt,
    staleAfterMs,
    workersSeen,
  };
}

/** Tenants with queued work, used by the worker's recurring-job planner. */
export async function activeTenantIds(): Promise<string[]> {
  const organizations = await rawDb.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return organizations.map((organization) => organization.id);
}

export function hasTenantContext(): boolean {
  return Boolean(getTenantId());
}
