import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storageDriver, testStorage } from "@/lib/storage";
import { queueStats, workerLiveness } from "@/lib/workflow/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe.
 *
 * Public response contains only verified status: can the database answer, and is
 * there a real worker heartbeat inside the stale threshold. It never reports a
 * worker as healthy because the queue happens to be empty, and never includes
 * queue contents, configuration or provider details in the public body.
 * `?deep=1` adds queue/storage detail and requires WORKER_SECRET.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const wantsDeep = url.searchParams.get("deep") === "1";
  const token = request.headers.get("x-health-token") ?? "";
  const deep = wantsDeep && Boolean(env.WORKER_SECRET) && token === env.WORKER_SECRET;

  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json(
      { status: "error", checks: { database: "unreachable", worker: "unknown" }, time: new Date().toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const worker = await workerLiveness();
  const overall = worker.status === "HEALTHY" ? "ok" : worker.status === "STALE" ? "degraded" : "unknown";

  const body: Record<string, unknown> = {
    status: overall,
    checks: {
      database: "reachable",
      worker: worker.status.toLowerCase(),
    },
    worker: {
      lastSeenAt: worker.lastSeenAt ? worker.lastSeenAt.toISOString() : null,
      staleAfterSeconds: Math.round(worker.staleAfterMs / 1000),
    },
    time: new Date().toISOString(),
  };

  if (deep) {
    try {
      const [queue, storage] = await Promise.all([queueStats(), testStorage()]);
      body.queue = queue;
      body.storage = { driver: storageDriver, ok: storage.ok, detail: storage.detail };
      body.workers = worker.workersSeen;
    } catch {
      body.queue = null;
      body.storage = { driver: storageDriver, ok: false, detail: "Probe failed." };
    }
  }

  return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
}
