import { env, assertProductionConfig } from "./lib/env";
import { db } from "./lib/db";
import { runNextJob } from "./lib/workflow/process";
import { enqueueJob, recordWorkerHeartbeat } from "./lib/workflow/jobs";
import { JOB_TYPES } from "./lib/constants";
import { activeEmailProvider } from "./lib/email/send";

// Fail closed in production before doing any work.
assertProductionConfig();

/**
 * Long-running background worker. Start with `npm run worker`.
 *
 * Jobs live in the database with a lease, so the web server can restart freely
 * and a crashed worker's jobs are reclaimed instead of lost or double-run.
 */
const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let stopping = false;

async function ensureRecurringJobs() {
  const now = Date.now();
  // The connected mailbox is the source of truth, not EMAIL_INTAKE_PROVIDER:
  // a mailbox connected through OAuth must be polled even when the env flag
  // still says "none".
  const emailProvider = await activeEmailProvider();
  if (env.EMAIL_AUTO_SYNC === "true" && emailProvider !== "none") {
    await enqueueJob({
      type: JOB_TYPES.SYNC_EMAIL,
      payload: { trigger: "poll" },
      idempotencyKey: `email-sync:${Math.floor(now / env.EMAIL_POLL_INTERVAL_MS)}`,
      runAfter: new Date(Math.ceil(now / env.EMAIL_POLL_INTERVAL_MS) * env.EMAIL_POLL_INTERVAL_MS),
      maxAttempts: 3,
    });
    await enqueueJob({
      type: JOB_TYPES.RENEW_EMAIL_WATCH,
      payload: {},
      idempotencyKey: `email-watch-renew:${new Date().toISOString().slice(0, 13)}`,
      maxAttempts: 2,
    });
  }
  await enqueueJob({
    type: JOB_TYPES.PURGE_EXPIRED,
    payload: {},
    idempotencyKey: `purge-expired:${new Date().toISOString().slice(0, 13)}`,
    maxAttempts: 1,
  });
}

async function main() {
  console.log(`[worker] ${workerId} started, polling every ${env.WORKER_POLL_MS}ms`);
  let lastRecurring = 0;
  while (!stopping) {
    let didWork = false;
    try {
      // Durable liveness: the health endpoint and the app shell read this row.
      await recordWorkerHeartbeat(workerId, { status: "polling", pollMs: env.WORKER_POLL_MS });
      if (Date.now() - lastRecurring > 60_000) {
        lastRecurring = Date.now();
        await ensureRecurringJobs();
      }
      didWork = await runNextJob(workerId);
      await recordWorkerHeartbeat(workerId, {
        status: didWork ? "working" : "idle",
        pollMs: env.WORKER_POLL_MS,
      });
    } catch (error) {
      console.error("[worker] loop error", error instanceof Error ? error.message : error);
      await recordWorkerHeartbeat(workerId, { status: "error", pollMs: env.WORKER_POLL_MS }).catch(() => undefined);
    }
    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_MS));
    }
  }
  await db.$disconnect();
  console.log("[worker] stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, finishing the current job`);
    stopping = true;
  });
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
