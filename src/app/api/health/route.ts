import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storageDriver, testStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe.
 *
 * Reports only facts it can verify: the database answers, how much work is
 * queued or failed, and when the worker last renewed a lease. `?deep=1` also
 * performs a real storage round-trip. It never reports a provider as connected
 * just because credentials exist.
 */
export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  try {
    await db.$queryRaw`SELECT 1`;
    const [queued, failed, oldest, lastHeartbeat] = await Promise.all([
      db.backgroundJob.count({ where: { status: { in: ["QUEUED", "RETRYING"] } } }),
      db.backgroundJob.count({ where: { status: { in: ["FAILED", "DEAD_LETTER"] } } }),
      db.backgroundJob.findFirst({
        where: { status: { in: ["QUEUED", "RETRYING"] } },
        orderBy: { runAfter: "asc" },
        select: { runAfter: true },
      }),
      db.backgroundJob.findFirst({
        where: { heartbeatAt: { not: null } },
        orderBy: { heartbeatAt: "desc" },
        select: { heartbeatAt: true },
      }),
    ]);

    const storage = deep ? await testStorage() : { ok: true, detail: `driver=${storageDriver} (not probed; use ?deep=1)` };

    return NextResponse.json(
      {
        status: "ok",
        database: "reachable",
        storage,
        queue: {
          queued,
          failed,
          oldestQueuedAt: oldest?.runAfter ?? null,
        },
        worker: {
          lastHeartbeatAt: lastHeartbeat?.heartbeatAt ?? null,
          stale: lastHeartbeat?.heartbeatAt
            ? Date.now() - lastHeartbeat.heartbeatAt.getTime() > env.WORKER_STALE_MS * 2
            : true,
        },
        demoMode: env.DEMO_MODE === "true",
        time: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { status: "error", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
