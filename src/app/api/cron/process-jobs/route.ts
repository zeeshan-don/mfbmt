import { NextResponse } from "next/server";
import { cronOrQStashAuthorized } from "@/lib/qstash";
import { runNextJob } from "@/lib/workflow/process";
import { ensureOpsJobs } from "@/lib/ops-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PATH = "/api/cron/process-jobs";

async function handle(request: Request) {
  const authorization = await cronOrQStashAuthorized(request, PATH);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  let processed = 0;
  try {
    await ensureOpsJobs();
    for (let i = 0; i < 10; i += 1) {
      const didWork = await runNextJob(`cron-${process.pid}`);
      if (!didWork) break;
      processed += 1;
    }
    return NextResponse.json({ ok: true, processed, source: authorization.source });
  } catch (error) {
    return NextResponse.json(
      { ok: false, processed, error: error instanceof Error ? error.message : "Job processing failed." },
      { status: 500 },
    );
  }
}

/** Vercel/manual operators (GET) and QStash schedules (POST) share this handler. */
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
