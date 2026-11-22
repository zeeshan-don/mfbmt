import Pusher from "pusher";
import { env } from "./env";

/**
 * Pusher is an optional integration. When the four credentials are absent every
 * helper below becomes a no-op, so the app keeps working without realtime.
 */
let cached: Pusher | null | undefined;

export function realtimeConfigured(): boolean {
  return Boolean(env.PUSHER_APP_ID && env.PUSHER_KEY && env.PUSHER_SECRET && env.PUSHER_CLUSTER);
}

/** One private channel per company so tenants can never see each other's events. */
export function orgChannel(organizationId: string): string {
  return `private-org-${organizationId}`;
}

function client(): Pusher | null {
  if (cached !== undefined) return cached;
  if (!realtimeConfigured()) {
    cached = null;
    return cached;
  }
  cached = new Pusher({
    appId: env.PUSHER_APP_ID,
    key: env.PUSHER_KEY,
    secret: env.PUSHER_SECRET,
    cluster: env.PUSHER_CLUSTER,
    useTLS: true,
  });
  return cached;
}

/** Signs a private-channel subscription. Caller must verify org ownership. */
export function authorizeOrgChannel(socketId: string, channelName: string): { auth: string } | null {
  const pusher = client();
  if (!pusher) return null;
  return pusher.authorizeChannel(socketId, channelName);
}

/**
 * Tells every open tab in one company that server data changed so the page can
 * re-render without waiting for a manual refresh. Failures are logged and never
 * break the mutation that triggered them.
 */
export async function broadcastOrgRefresh(organizationId: string, reason = "data"): Promise<void> {
  const pusher = client();
  if (!pusher) return;
  try {
    await pusher.trigger(orgChannel(organizationId), "refresh", {
      reason,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[realtime] could not publish refresh", error instanceof Error ? error.message : error);
  }
}
