import { env } from "./lib/env";
import { db } from "./lib/db";
import { runNextJob } from "./lib/workflow/process";

/**
 * Long-running background worker. Start with `npm run worker`.
 * Jobs live in the database, so the web server can restart freely and work
 * resumes after a crash.
 */
const workerId = `worker-${process.pid}`;
let stopping = false;

async function main() {
  console.log(`[worker] ${workerId} started, polling every ${env.WORKER_POLL_MS}ms`);
  while (!stopping) {
    let didWork = false;
    try {
      didWork = await runNextJob(workerId);
    } catch (error) {
      console.error("[worker] loop error", error);
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
    console.log(`[worker] ${signal} received, finishing current job`);
    stopping = true;
  });
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
