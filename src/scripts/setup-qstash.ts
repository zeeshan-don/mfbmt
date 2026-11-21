import { Client } from "@upstash/qstash";
import { env } from "../lib/env";

/**
 * Reproducible QStash schedule setup.
 *
 * Creates (or updates) two schedules that replace the former Vercel crons:
 *   - /api/cron/process-jobs  every 5 minutes
 *   - /api/cron/email-sync     every 5 minutes
 *
 * Stable schedule IDs are used so re-running this script is idempotent:
 * an existing schedule with the same id is updated rather than duplicated.
 *
 * Usage:
 *   QSTASH_TOKEN=... APP_URL=https://... npx tsx src/scripts/setup-qstash.ts
 *
 * No production schedules are created unless QSTASH_TOKEN and APP_URL are set.
 */
const SCHEDULES = [
  { scheduleId: "mfbmt-process-jobs", path: "/api/cron/process-jobs", cron: "*/5 * * * *" },
  { scheduleId: "mfbmt-email-sync", path: "/api/cron/email-sync", cron: "*/5 * * * *" },
];

async function main() {
  if (!env.QSTASH_TOKEN) {
    console.error("QSTASH_TOKEN is required.");
    process.exit(1);
  }
  if (!env.APP_URL || !/^https:\/\//i.test(env.APP_URL)) {
    console.error("APP_URL must be a public https URL.");
    process.exit(1);
  }

  const client = new Client({ token: env.QSTASH_TOKEN });
  const origin = env.APP_URL.replace(/\/$/, "");

  for (const schedule of SCHEDULES) {
    const destination = `${origin}${schedule.path}`;
    try {
      const result = await client.schedules.create({
        scheduleId: schedule.scheduleId,
        destination,
        cron: schedule.cron,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      console.log(`Schedule ${schedule.scheduleId}: ${result.scheduleId} -> ${destination} (${schedule.cron})`);
    } catch (error) {
      console.error(`Failed to create schedule ${schedule.scheduleId}:`, error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
