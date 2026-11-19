import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { timingSafeEqual, sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { parseGraphClientState, resolveEmailOrganization } from "@/lib/email/routing";
import { runWithTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Microsoft Graph change notifications.
 *
 * - Subscription validation: Graph sends `?validationToken=` and expects it
 *   echoed as text/plain within 10 seconds.
 * - Notifications: every entry carries the `clientState` we set when creating
 *   the subscription. It is `org:<organizationId>:<shared secret>`, so a valid
 *   notification is routed to its company and cannot be replayed against
 *   another. A durable receipt is written and a delta sync is queued.
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

  const organizationIds = new Set<string>();
  for (const notification of notifications) {
    const parsed = notification.clientState ? parseGraphClientState(notification.clientState) : null;
    if (parsed) {
      if (!timingSafeEqual(parsed.secret, env.GRAPH_WEBHOOK_CLIENT_STATE)) {
        return NextResponse.json({ error: "Invalid client state." }, { status: 401 });
      }
      organizationIds.add(parsed.organizationId);
      continue;
    }
    // Backwards compatibility for a subscription created before per-tenant
    // state: accept only when exactly one company has Microsoft connected.
    if (!notification.clientState || !timingSafeEqual(notification.clientState, env.GRAPH_WEBHOOK_CLIENT_STATE)) {
      return NextResponse.json({ error: "Invalid client state." }, { status: 401 });
    }
    const organizationId = await resolveEmailOrganization("MICROSOFT365", null);
    if (!organizationId) return NextResponse.json({ error: "Notification cannot be routed." }, { status: 422 });
    organizationIds.add(organizationId);
  }

  if (organizationIds.size !== 1) {
    return NextResponse.json({ error: "Notification spans more than one workspace." }, { status: 400 });
  }
  const organizationId = [...organizationIds][0];

  const externalId = `graph:${sha256(JSON.stringify(notifications)).slice(0, 40)}`;
  const lifecycle = notifications.some((notification) => Boolean(notification.lifecycleEvent));

  try {
    return await runWithTenant({ organizationId, source: "webhook" }, async () => {
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
    });
  } catch (error) {
    console.error("[microsoft] notification handling failed", error);
    return NextResponse.json({ error: "Could not handle the notification." }, { status: 503 });
  }
}
