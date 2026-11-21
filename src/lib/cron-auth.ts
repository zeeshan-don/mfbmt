import { env } from "./env";
import { timingSafeEqual } from "./crypto";

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Manual operators may
 * continue to use WORKER_SECRET for the same endpoints. If neither is set the
 * endpoint returns 503 instead of running unauthenticated work.
 */
export function cronAuthorized(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = env.CRON_SECRET || env.WORKER_SECRET;
  if (!secret) {
    return { ok: false, status: 503, error: "CRON_SECRET (or WORKER_SECRET) is not configured." };
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (!provided || !timingSafeEqual(provided, secret)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}
