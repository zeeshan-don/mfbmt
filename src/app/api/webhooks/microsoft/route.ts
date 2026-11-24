import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { groupGraphNotifications, type GraphNotification } from "@/lib/email/routing";
import { runWithTenant } from "@/lib/tenant";
import { getIntegration } from "@/lib/integrations/store";
import { parseJson } from "@/lib/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Microsoft Graph change notifications.
 *
 * - Validation: echo `validationToken` as plain text.
 * - Notifications: a delivery may contain subscriptions from several MFBMT
 *   companies. Each entry is verified by its per-organisation clientState and
 *   its subscription id, then queued inside that company's tenant context. A
 *   notification is never routed to a different company.
 * - This route performs no mailbox scan and no AI work; the worker does that.
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

  let payload: { value?: GraphNotification[] };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const notifications = payload.value ?? [];
  if (notifications.length === 0) return new NextResponse(null, { status: 202 });

  const grouped = await groupGraphNotifications(notifications, env.GRAPH_WEBHOOK_CLIENT_STATE);
  if (!grouped.ok) return NextResponse.json({ error: grouped.error }, { status: grouped.status });
  if (grouped.groups.length === 0) return new NextResponse(null, { status: 202 });

  for (const group of grouped.groups) {
    const outcome = await runWithTenant({ organizationId: group.organizationId, source: "webhook" }, async () => {
      const integration = await getIntegration("MICROSOFT365");
      if (!integration || !["CONNECTED", "CONNECTING"].includes(integration.status)) {
        return { ok: false as const, status: 404, error: "This company has no connected Outlook mailbox." };
      }
      const config = parseJson<{ subscriptionId?: string; autoSyncEnabled?: boolean }>(integration.configJson, {});

      for (const notification of group.notifications) {
        // A subscription id proves which mailbox the event belongs to. If we
        // know our subscription and it differs, this event is not ours.
        if (
          notification.subscriptionId &&
          config.subscriptionId &&
          notification.subscriptionId !== config.subscriptionId
        ) {
          return { ok: false as const, status: 401, error: "Notification subscription does not match this mailbox." };
        }
      }

      // The owner can pause automatic processing without disconnecting.
      if (config.autoSyncEnabled === false) return { ok: true as const };

      const externalId = `graph:${sha256(JSON.stringify(group.notifications)).slice(0, 40)}`;
      const lifecycle = group.notifications.some((notification) => Boolean(notification.lifecycleEvent));

      // Persist the receipt idempotently, then queue durably. A retried delivery
      // still ensures the job exists instead of returning success with no work.
      await db.webhookEvent.createMany({
        data: [
          {
            provider: "MICROSOFT365",
            externalId,
            payloadHash: sha256(JSON.stringify(group.notifications)),
            status: "RECEIVED",
            processedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });

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
        return { ok: false as const, status: 503, error: "Could not queue the mailbox sync." };
      }

      await db.webhookEvent
        .updateMany({
          where: { provider: "MICROSOFT365", externalId },
          data: { status: "QUEUED", processedAt: new Date() },
        })
        .catch(() => undefined);

      return { ok: true as const };
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }
  }

  return new NextResponse(null, { status: 202 });
}
