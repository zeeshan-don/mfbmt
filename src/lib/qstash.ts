import { env } from "./env";
import { Receiver } from "@upstash/qstash";

/**
 * Verifies a QStash-signed request.
 *
 * QStash delivers messages as HTTP requests with an `upstash-signature` header
 * (a JWT signed with the account signing keys). We verify against the current
 * and next signing keys so key rotation does not break in-flight deliveries.
 *
 * The `url` is built from APP_URL + path so the signed subject (the destination
 * URL QStash signed for) is checked. Leaving it undefined would accept a
 * signature for any endpoint on the account.
 *
 * Returns ok:false with 503 when QStash is not configured, so callers can fall
 * back to the legacy CRON_SECRET bearer path.
 */
export type QStashAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export async function qstashAuthorized(
  request: Request,
  path: string,
): Promise<QStashAuthResult> {
  const current = env.QSTASH_CURRENT_SIGNING_KEY;
  const next = env.QSTASH_NEXT_SIGNING_KEY;
  if (!current && !next) {
    return { ok: false, status: 503, error: "QStash signing keys are not configured." };
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return { ok: false, status: 401, error: "Missing Upstash-Signature header." };
  }

  // Read the raw body once; verification needs the exact bytes QStash signed.
  let body = "";
  try {
    body = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Could not read request body." };
  }

  const url = `${env.APP_URL.replace(/\/$/, "")}${path}`;
  const region = request.headers.get("upstash-region") ?? undefined;

  const receiver = new Receiver({
    currentSigningKey: current || undefined,
    nextSigningKey: next || undefined,
    devMode: env.QSTASH_DEV === "true" || env.QSTASH_DEV === "1",
  });

  try {
    await receiver.verify({
      signature,
      body,
      url,
      upstashRegion: region,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      error: error instanceof Error ? error.message : "Invalid QStash signature.",
    };
  }
}

/**
 * Combined authorization for cron endpoints: accepts either a valid QStash
 * signature or the legacy CRON_SECRET/WORKER_SECRET bearer token. This keeps
 * manual operator access working while letting QStash drive the schedule.
 */
export async function cronOrQStashAuthorized(
  request: Request,
  path: string,
): Promise<{ ok: true; source: "qstash" | "bearer" } | { ok: false; status: number; error: string }> {
  // Try QStash first when signing keys are configured.
  if (env.QSTASH_CURRENT_SIGNING_KEY || env.QSTASH_NEXT_SIGNING_KEY) {
    const qs = await qstashAuthorized(request, path);
    if (qs.ok) return { ok: true, source: "qstash" };
    // If a signature header was present, do not fall through to bearer auth.
    if (request.headers.get("upstash-signature")) {
      return qs;
    }
  }

  // Fall back to bearer token (Vercel/manual operators).
  const { cronAuthorized } = await import("./cron-auth");
  const bearer = cronAuthorized(request);
  if (bearer.ok) return { ok: true, source: "bearer" };
  return bearer;
}
