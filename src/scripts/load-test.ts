/**
 * Repeatable synthetic load test.
 *
 * Safety:
 *   * Requires an explicitly named, local/isolated PostgreSQL database whose
 *     name contains "test" or "load". Production and Neon hosts are refused.
 *   * Requires LOAD_TEST_CONFIRM=YES.
 *   * Forces every outbound provider to a mock/off state before importing app
 *     modules: no AI, email, WhatsApp, web search or exchange-rate request.
 *   * Runs against a dedicated database; it does not clean production data and
 *     refuses to run against a remote host.
 *
 * Usage (dedicated database):
 *   LOAD_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_load_test \
 *   LOAD_TEST_CONFIRM=YES LOAD_TEST_COUNT=30 npx tsx src/scripts/load-test.ts
 *
 * The measurements are real for this machine and database. They are not a
 * production capacity guarantee; see docs/LOAD_TESTING.md.
 */

type IngestFn = typeof import("../lib/workflow/enquiry")["ingestInboundMessage"];
type RunNextJobFn = typeof import("../lib/workflow/process")["runNextJob"];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function guard() {
  const url = (process.env.LOAD_TEST_DATABASE_URL ?? "").trim();
  if (!url) throw new Error("LOAD_TEST_DATABASE_URL is required. Never point this at production.");
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error("LOAD_TEST_DATABASE_URL must be a PostgreSQL URL.");
  if (/neon\.tech|amazonaws\.com|supabase|render\.com|vercel/i.test(url)) {
    throw new Error("Refusing to run a load test against a hosted/production database.");
  }
  if (!/(localhost|127\.0\.0\.1|::1)/.test(url)) throw new Error("Refusing to run a load test against a non-local host.");
  if (!/(test|load)/i.test(url)) throw new Error('The database name must contain "test" or "load".');
  if ((process.env.LOAD_TEST_CONFIRM ?? "").toUpperCase() !== "YES") {
    throw new Error("Set LOAD_TEST_CONFIRM=YES to confirm this isolated synthetic run.");
  }
  const count = Number(process.env.LOAD_TEST_COUNT ?? "30");
  if (!Number.isInteger(count) || count < 1 || count > 300) {
    throw new Error("LOAD_TEST_COUNT must be an integer between 1 and 300.");
  }
  if (/mfbmt\.vercel\.app/i.test(process.env.APP_URL ?? "")) {
    throw new Error("Refusing to run with the production APP_URL.");
  }
  return { url, count };
}

async function main() {
  const { url, count } = guard();

  // Force mock providers BEFORE app modules read the environment.
  process.env.DATABASE_URL = url;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.AI_PROVIDER = "none";
  process.env.AI_API_KEY = "";
  process.env.EMAIL_INTAKE_PROVIDER = "none";
  process.env.WEB_SEARCH_PROVIDER = "none";
  process.env.TAVILY_API_KEY = "";
  process.env.SERPER_API_KEY = "";
  process.env.BRAVE_SEARCH_API_KEY = "";
  process.env.EXCHANGE_RATE_PROVIDER = "fixed";
  process.env.WHATSAPP_ACCESS_TOKEN = "";
  process.env.META_APP_ID = "";
  process.env.META_APP_SECRET = "";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_ROOT = "./storage-load-test";
  process.env.DEMO_MODE = "false";

  const { rawDb } = await import("../lib/db-base");
  const { runWithTenant } = await import("../lib/tenant");
  const { ingestInboundMessage } = (await import("../lib/workflow/enquiry")) as { ingestInboundMessage: IngestFn };
  const { runNextJob } = (await import("../lib/workflow/process")) as { runNextJob: RunNextJobFn };
  const { queueStats } = await import("../lib/workflow/jobs");

  const organization = await rawDb.organization.findUnique({ where: { slug: process.env.LOAD_TEST_ORG_SLUG ?? "ogs" } });
  if (!organization) throw new Error("The load-test organization does not exist in this database.");

  const runId = `LOAD-${Date.now().toString(36).toUpperCase()}`;
  const startedAt = new Date();
  const categories = ["Pipes", "Valves", "Flanges", "Fittings", "Chemicals", "Industrial Spares"];

  const requests = Array.from({ length: count }, (_, index) => ({
    externalMessageId: `${runId}-${index}`,
    from: index % 2 === 0 ? `+97150${String(1000000 + index)}` : `load-${index}@example.com`,
    channel: (index % 2 === 0 ? "WHATSAPP" : "EMAIL") as "WHATSAPP" | "EMAIL",
    category: categories[index % categories.length],
    body:
      index % 7 === 0
        ? `Please quote 10 pcs 1 inch SS316 elbow for ${categories[index % categories.length]} and 5 pcs gate valve Class 150.\nDelivery to Dubai.`
        : `Please quote ${5 + (index % 20)} pcs ${categories[index % categories.length]} item ${index}, SS316 Class 150.`,
  }));

  const ingestLatencies: number[] = [];
  const ingestFailures: string[] = [];

  // Burst: all intake requests start together.
  await Promise.all(
    requests.map((request) =>
      runWithTenant({ organizationId: organization.id, source: "test" }, async () => {
        const start = performance.now();
        try {
          await ingestInboundMessage({
            channel: request.channel,
            externalMessageId: request.externalMessageId,
            from: request.from,
            body: request.body,
            receivedAt: new Date(),
          });
        } catch (error) {
          ingestFailures.push(error instanceof Error ? error.message : "ingest failed");
        } finally {
          ingestLatencies.push(performance.now() - start);
        }
      }),
    ),
  );

  // Process the queue with the configured worker path, one job at a time (the
  // real worker count is a deployment decision, not something this script fakes).
  const workerId = `load-test-${runId}`;
  let processed = 0;
  let jobFailures = 0;
  const maxJobs = count * 8;
  const jobStart = performance.now();
  while (processed + jobFailures < maxJobs) {
    const ran = await runNextJob(workerId);
    if (!ran) break;
    processed += 1;
    const failed = await rawDb.backgroundJob.count({ where: { organizationId: organization.id, lockedBy: workerId, status: "FAILED" } });
    jobFailures = failed;
  }
  const jobDuration = performance.now() - jobStart;

  const jobs = await rawDb.backgroundJob.findMany({
    where: { organizationId: organization.id, createdAt: { gte: startedAt } },
    select: { status: true, createdAt: true, lockedAt: true, updatedAt: true, attempts: true },
  });
  const waits = jobs.filter((job) => job.lockedAt).map((job) => job.lockedAt!.getTime() - job.createdAt.getTime());
  const completions = jobs
    .filter((job) => job.status === "COMPLETED" && job.lockedAt)
    .map((job) => job.updatedAt.getTime() - job.lockedAt!.getTime());

  const summary = {
    runId,
    organization: organization.slug,
    requestedEnquiries: count,
    ingested: requests.length - ingestFailures.length,
    ingestFailures,
    ingestLatencyMs: {
      p50: percentile(ingestLatencies, 50),
      p95: percentile(ingestLatencies, 95),
      max: Math.round(Math.max(0, ...ingestLatencies)),
    },
    worker: {
      jobsSeen: jobs.length,
      completed: jobs.filter((job) => job.status === "COMPLETED").length,
      failed: jobs.filter((job) => job.status === "FAILED").length,
      processing: jobs.filter((job) => job.status === "PROCESSING").length,
      queued: jobs.filter((job) => job.status === "QUEUED").length,
      totalWallMs: Math.round(jobDuration),
      queueWaitMs: { p50: percentile(waits, 50), p95: percentile(waits, 95) },
      completionMs: { p50: percentile(completions, 50), p95: percentile(completions, 95) },
    },
    // Queue stats read through the tenant-scoped client, so they must run inside
    // the same organization context as the synthetic workload.
    queueAfter: await runWithTenant({ organizationId: organization.id, source: "test" }, () => queueStats()),
    note: "Synthetic data only. AI, email, WhatsApp and search providers were mocked/disabled. Times are specific to this machine and database.",
  };

  console.log(JSON.stringify(summary, null, 2));
  await rawDb.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
