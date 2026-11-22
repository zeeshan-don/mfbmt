"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Pusher from "pusher-js";

/**
 * Subscribes once for the whole app shell. Any mutation elsewhere in the same
 * company (another tab, the worker, a webhook) triggers a debounced
 * `router.refresh()`, so every page updates without a manual reload.
 */
export function RealtimeRefresh({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!key || !cluster) return;

    const channelName = `private-org-${organizationId}`;
    const pusher = new Pusher(key, {
      cluster,
      forceTLS: true,
      channelAuthorization: { endpoint: "/api/pusher/auth", transport: "ajax" },
    });

    const channel = pusher.subscribe(channelName);
    const scheduleRefresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 200);
    };
    channel.bind("refresh", scheduleRefresh);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      channel.unbind("refresh", scheduleRefresh);
      pusher.unsubscribe(channelName);
      pusher.disconnect();
    };
  }, [organizationId, router]);

  return null;
}
