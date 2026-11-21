import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { syncEmailIntake } from "@/lib/email/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for email intake polling.
 * Runs every 5 minutes (configured in vercel.json).
 * Requires CRON_SECRET (or WORKER_SECRET) as a Bearer token.
 */
export async function GET(request: Request) {
  const authorization = cronAuthorized(request);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  try {
    const result = await syncEmailIntake({ trigger: "poll" });
    return NextResponse.json({ ok: result.ok, processed: result.processed, skipped: result.skipped, failed: result.failed, detail: result.detail });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Email sync failed." },
      { status: 500 },
    );
  }
}