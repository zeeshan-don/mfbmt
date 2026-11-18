import { enqueueJob } from "../src/lib/workflow/jobs";
import { db } from "../src/lib/db";
async function main() {
  const job = await enqueueJob({ type: "PURGE_EXPIRED", payload: {}, idempotencyKey: `verify-worker-${Date.now()}`, maxAttempts: 1 });
  console.log("ENQUEUED", job.id);
  await db.$disconnect();
}
main();
