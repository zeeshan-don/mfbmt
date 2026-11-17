import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { timingSafeEqual } from "@/lib/crypto";
import { runNextJob } from "@/lib/workflow/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Optional HTTP worker trigger for hosts where a long-running worker process is
 * not available. Point a scheduler at this endpoint. Jobs still live in the
 * database, so no work is lost if the request is interrupted.
 */
export async function POST(request: Request) {
  if (!env.WORKER_SECRET) {
    return NextResponse.json({ error: "WORKER_SECRET is not configured." }, { status: 503 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(provided, env.WORKER_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let processed = 0;
  for (let i = 0; i < 5; i += 1) {
    const didWork = await runNextJob(`http-${process.pid}`);
    if (!didWork) break;
    processed += 1;
  }
  return NextResponse.json({ ok: true, processed });
}
