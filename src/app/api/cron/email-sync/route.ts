import { NextResponse } from "next/server";
import { cronOrQStashAuthorized } from "@/lib/qstash";
import { syncEmailIntake } from "@/lib/email/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PATH = "/api/cron/email-sync";

async function handle(request: Request) {
  const authorization = await cronOrQStashAuthorized(request, PATH);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  try {
    const result = await syncEmailIntake({ trigger: "poll" });
    return NextResponse.json({ ok: result.ok, processed: result.processed, skipped: result.skipped, failed: result.failed, detail: result.detail, source: authorization.source });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Email sync failed." },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
