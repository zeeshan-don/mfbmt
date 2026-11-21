import { createServer, type Server } from "node:http";
import { env } from "./env";

/**
 * Liveness endpoint served by the worker process itself (Vercel livenessProbe).
 * It deliberately exposes no secrets, queue contents or tenant data.
 */
let startedAt = Date.now();
let lastLoopAt = Date.now();
let currentJob = false;
let stopping = false;
let fatal = false;

export function markWorkerLoop(working: boolean): void {
  lastLoopAt = Date.now();
  currentJob = working;
}

export function markWorkerStopping(): void {
  stopping = true;
}

export function markWorkerFatal(): void {
  fatal = true;
}

export function workerHealthPayload(now = Date.now()) {
  const age = now - lastLoopAt;
  const healthy = !fatal && !stopping && (currentJob || age <= env.WORKER_STALE_MS);
  return {
    status: healthy ? "ok" : "unhealthy",
    uptimeSeconds: Math.floor((now - startedAt) / 1000),
    lastLoopAgoMs: age,
    currentJob,
    stopping,
  };
}

export function startWorkerHealthServer(): Server {
  startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || (request.url !== "/health" && request.url !== "/ready")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const payload = workerHealthPayload();
    response.writeHead(payload.status === "ok" ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  server.on("error", (error) => {
    fatal = true;
    console.error("[worker] health server error", error instanceof Error ? error.message : error);
  });
  server.listen(env.WORKER_HEALTH_PORT, env.WORKER_HEALTH_HOST, () => {
    console.log(`[worker] health server on ${env.WORKER_HEALTH_HOST}:${env.WORKER_HEALTH_PORT}/health`);
  });
  return server;
}
