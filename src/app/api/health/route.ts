import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const pendingJobs = await db.backgroundJob.count({ where: { status: "QUEUED" } });
    return NextResponse.json({
      status: "ok",
      database: "reachable",
      pendingJobs,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", detail: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}
