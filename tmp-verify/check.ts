import { db } from "../src/lib/db";
async function main() {
  const jobs = await db.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: "verify-worker-" } }, orderBy: { createdAt: "desc" }, take: 1 });
  console.log("JOB_STATE", JSON.stringify(jobs.map((j) => ({ status: j.status, attempts: j.attempts, progress: j.progress, error: j.lastError }))));
  await db.$disconnect();
}
main();
