import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { timingSafeEqual } from "@/lib/crypto";
import { runNextJob } from "@/lib/workflow/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for background job processing.
 * Runs every 5 minutes (configured in vercel.json).
 * Requires WORKER_SECRET as Bearer token (set in Vercel env vars).
 */
export async function GET(request: Request) {
  if (!env.WORKER_SECRET) {
    return NextResponse.json({ error: "WORKER_SECRET is not configured." }, { status: 503 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(provided, env.WORKER_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let processed = 0;
  try {
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