import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { timingSafeEqual } from "@/lib/crypto";
import { syncEmailIntake } from "@/lib/email/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for email intake polling.
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