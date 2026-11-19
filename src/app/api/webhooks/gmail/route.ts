import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { timingSafeEqual, sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { resolveEmailOrganization } from "@/lib/email/routing";
import { runWithTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PubSubPush = {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
};

/**
 * Gmail Pub/Sub push endpoint.
 *
 * The push subscription is configured with `?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>`
 * so an arbitrary caller cannot trigger mailbox reads. The notification body is
 * only a hint: it records the receipt durably and queues a history sync in the
 * owning organization's context. The sync uses that company's stored cursor and
 * mailbox credentials, so a replayed notification cannot skip messages or read
 * another company's mail.
 */
export async function POST(request: Request) {
  if (!env.GMAIL_PUBSUB_VERIFICATION_TOKEN) {
    return NextResponse.json({ error: "Gmail push is not configured." }, { status: 503 });
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!timingSafeEqual(token, env.GMAIL_PUBSUB_VERIFICATION_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: PubSubPush;
  try {
    payload = (await request.json()) as PubSubPush;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const encoded = payload.message?.data;
  if (!encoded) return NextResponse.json({ ok: true, ignored: "no message data" });

  let notification: { emailAddress?: string; historyId?: string } = {};
  try {
    notification = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      emailAddress?: string;
      historyId?: string;
    };
  } catch {
    return NextResponse.json({ error: "Invalid notification payload." }, { status: 400 });
  }

  const organizationId = await resolveEmailOrganization("GMAIL", notification.emailAddress ?? null);
  if (!organizationId) {
    console.warn("[gmail] notification could not be routed to a company", { emailAddress: notification.emailAddress });
    return new NextResponse(null, { status: 204 });
  }

  const externalId = `gmail:${notification.historyId ?? payload.message?.messageId ?? sha256(encoded).slice(0, 32)}`;

  try {
    return await runWithTenant({ organizationId, source: "webhook" }, async () => {
      try {
        await db.webhookEvent.create({
          data: {
            provider: "GMAIL",
            externalId,
            payloadHash: sha256(encoded),
            status: "RECEIVED",
          },
        });
      } catch {
        // Duplicate notification: the queued sync already covers it.
        return new NextResponse(null, { status: 204 });
      }

      try {
        await enqueueJob({
          type: JOB_TYPES.SYNC_EMAIL,
          payload: { trigger: "push" },
          // One sync per notification batch; the cursor keeps it incremental.
          idempotencyKey: `email-sync-push:${externalId}`,
          maxAttempts: 4,
        });
        await db.webhookEvent.updateMany({
          where: { provider: "GMAIL", externalId },
          data: { status: "QUEUED", processedAt: new Date() },
        });
      } catch (error) {
        await db.webhookEvent
          .updateMany({
            where: { provider: "GMAIL", externalId },
            data: { status: "FAILED", error: error instanceof Error ? error.message.slice(0, 300) : "queue failed" },
          })
          .catch(() => undefined);
        return NextResponse.json({ error: "Could not queue the mailbox sync." }, { status: 503 });
      }

      return new NextResponse(null, { status: 204 });
    });
  } catch (error) {
    console.error("[gmail] notification handling failed", error);
    return NextResponse.json({ error: "Could not handle the notification." }, { status: 503 });
  }
}
