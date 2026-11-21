import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runNextJob } from "@/lib/workflow/process";
import { ensureOpsJobs } from "@/lib/ops-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for background job processing.
 * Runs every 5 minutes (configured in vercel.json).
 * Requires CRON_SECRET (or WORKER_SECRET) as a Bearer token.
 */
export async function GET(request: Request) {
  const authorization = cronAuthorized(request);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  let processed = 0;
  try {
    // The cron is also the fallback scheduler: if a daemon is down, it makes
    // sure operational health/digest jobs exist before draining the queue.
    await ensureOpsJobs();
    for (let i = 0; i < 10; i += 1) {
      const didWork = await runNextJob(`vercel-cron-${process.pid}`);
      if (!didWork) break;
      processed += 1;
    }
    return NextResponse.json({ ok: true, processed });
  } catch (error) {
    return NextResponse.json(
      { ok: false, processed, error: error instanceof Error ? error.message : "Job processing failed." },
      { status: 500 },
    );
  }
}