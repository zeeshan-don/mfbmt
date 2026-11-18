import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { timingSafeEqual, sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Microsoft Graph change notifications.
 *
 * - Subscription validation: Graph sends `?validationToken=` and expects it
 *   echoed as text/plain within 10 seconds.
 * - Notifications: every entry carries the `clientState` we set when creating
 *   the subscription; a mismatch is rejected. A durable receipt is written and a
 *   delta sync is queued, so a dropped response does not lose the change.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!env.GRAPH_WEBHOOK_CLIENT_STATE) {
    return NextResponse.json({ error: "Microsoft Graph push is not configured." }, { status: 503 });
  }

  let payload: {
    value?: Array<{
      subscriptionId?: string;
      clientState?: string;
      changeType?: string;
      resource?: string;
      lifecycleEvent?: string;
    }>;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const notifications = payload.value ?? [];
  if (notifications.length === 0) return new NextResponse(null, { status: 202 });

  for (const notification of notifications) {
    if (!notification.clientState || !timingSafeEqual(notification.clientState, env.GRAPH_WEBHOOK_CLIENT_STATE)) {
      return NextResponse.json({ error: "Invalid client state." }, { status: 401 });
    }
  }

  const externalId = `graph:${sha256(JSON.stringify(notifications)).slice(0, 40)}`;
  try {
    await db.webhookEvent.create({
      data: {
        provider: "MICROSOFT365",
        externalId,
        payloadHash: sha256(JSON.stringify(payload)),
        status: "QUEUED",
        processedAt: new Date(),
      },
    });
  } catch {
    return new NextResponse(null, { status: 202 });
  }

  // A lifecycle event (reauthorizationRequired / subscriptionRemoved) is handled
  // by the renewal job rather than a mailbox sync.
  const lifecycle = notifications.some((notification) => Boolean(notification.lifecycleEvent));
  try {
    await enqueueJob({
      type: lifecycle ? JOB_TYPES.RENEW_EMAIL_WATCH : JOB_TYPES.SYNC_EMAIL,
      payload: lifecycle ? {} : { trigger: "push" },
      idempotencyKey: lifecycle ? `graph-lifecycle:${externalId}` : `email-sync-push:${externalId}`,
      maxAttempts: 3,
    });
  } catch (error) {
    await db.webhookEvent
      .updateMany({
        where: { provider: "MICROSOFT365", externalId },
        data: { status: "FAILED", error: error instanceof Error ? error.message.slice(0, 300) : "queue failed" },
      })
      .catch(() => undefined);
    return NextResponse.json({ error: "Could not queue the mailbox sync." }, { status: 503 });
  }

  return new NextResponse(null, { status: 202 });
}
