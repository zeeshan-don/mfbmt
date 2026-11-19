import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from "@/lib/intake/whatsapp";
import { ingestInboundMessage, isSenderExcluded } from "@/lib/workflow/enquiry";
import { getWhatsAppCredentials } from "@/lib/integrations/whatsapp";
import { writeAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta webhook subscription verification. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    return NextResponse.json({ error: "WhatsApp is not configured." }, { status: 503 });
  }
  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.json({ error: "Verification failed." }, { status: 403 });
}

/**
 * Inbound WhatsApp messages.
 *
 * The raw body is verified before parsing. A message is acknowledged only after
 * its durable receipt row exists; media is downloaded by the worker, not inside
 * the webhook request. If durable intake fails the webhook returns 503 so Meta
 * retries instead of losing the message.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWhatsAppSignature(raw, signature)) {
    await writeAudit({
      action: "whatsapp.webhook_rejected",
      entityType: "Integration",
      entityId: "WHATSAPP",
      actorLabel: "system",
      meta: { reason: signature ? "bad signature" : "missing signature" },
    });
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const parsed = parseWhatsAppWebhook(payload as Parameters<typeof parseWhatsAppWebhook>[0]);
  const credentials = await getWhatsAppCredentials();
  const payloadHash = sha256(raw);
  const results: Array<{ id: string; outcome: string }> = [];

  // Log coexistence-specific webhook events for debugging and audit.
  const rawPayload = payload as { entry?: Array<{ changes?: Array<{ field?: string }> }> };
  for (const entry of rawPayload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const field = change.field ?? "unknown";
      if (field !== "messages" && field !== "message_template_status_update") {
        console.log("[whatsapp] coexistence webhook field:", field);
        await writeAudit({
          action: `whatsapp.webhook_${field}`,
          entityType: "Integration",
          entityId: "WHATSAPP",
          actorLabel: "system",
          meta: { field },
        }).catch(() => undefined);
      }
    }
  }

  for (const status of parsed.statuses) {
    try {
      await db.webhookEvent.create({
        data: {
          provider: "WHATSAPP",
          externalId: `status:${status.messageId}:${status.status}`,
          payloadHash,
          status: "PROCESSED",
          processedAt: new Date(),
          error: status.errorMessage ?? null,
        },
      });
    } catch {
      // Duplicate status delivery; nothing to do.
      continue;
    }
    await writeAudit({
      action: `whatsapp.status_${status.status}`,
      entityType: "Message",
      entityId: status.messageId,
      actorLabel: "system",
      meta: { recipient: status.recipient, errorCode: status.errorCode, error: status.errorMessage ?? null },
    });
  }

  for (const message of parsed.messages) {
    // 1. Durable receipt. A unique (provider, externalId) makes Meta retries
    //    idempotent. Checking first avoids logging a constraint error on every
    //    legitimate Meta retry; the catch still covers the concurrent case.
    const seen = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: "WHATSAPP", externalId: message.externalId } },
    });
    if (seen) {
      results.push({ id: message.externalId, outcome: "duplicate" });
      continue;
    }
    try {
      await db.webhookEvent.create({
        data: {
          provider: "WHATSAPP",
          externalId: message.externalId,
          payloadHash,
          status: "RECEIVED",
        },
      });
    } catch {
      results.push({ id: message.externalId, outcome: "duplicate" });
      continue;
    }

    // 2. Route by receiving number. A message for another WABA/number is not
    //    silently mis-attributed to this account.
    if (
      credentials?.phoneNumberId &&
      message.toPhoneNumberId &&
      message.toPhoneNumberId !== credentials.phoneNumberId
    ) {
      await db.webhookEvent.updateMany({
        where: { provider: "WHATSAPP", externalId: message.externalId },
        data: { status: "FAILED", error: "Received for a phone number that is not connected.", processedAt: new Date() },
      });
      results.push({ id: message.externalId, outcome: "wrong_number" });
      continue;
    }

    // 3. An excluded contact's content is never fetched: no media download, no body storage.
    const exclusion = await isSenderExcluded({ channel: "WHATSAPP", from: message.from });

    try {
      const result = await ingestInboundMessage({
        channel: "WHATSAPP",
        externalMessageId: message.externalId,
        from: message.from,
        fromName: message.fromName ?? null,
        to: credentials?.phoneNumberId ?? null,
        toPhoneNumberId: message.toPhoneNumberId ?? null,
        body: exclusion.excluded ? "" : message.text,
        receivedAt: message.timestamp,
        mediaRefs: exclusion.excluded ? [] : message.media ? [message.media] : [],
      });

      await db.webhookEvent.updateMany({
        where: { provider: "WHATSAPP", externalId: message.externalId },
        data: {
          status: result.duplicate ? "PROCESSED" : "QUEUED",
          processedAt: new Date(),
        },
      });
      results.push({
        id: message.externalId,
        outcome: result.duplicate ? "duplicate" : result.ignored ? "excluded" : "accepted",
      });
    } catch (error) {
      // Durable intake failed: keep the receipt so a retry is still deduplicated,
      // record the failure, and ask Meta to retry.
      const detail = error instanceof Error ? error.message : "Ingest failed";
      await db.webhookEvent
        .updateMany({
          where: { provider: "WHATSAPP", externalId: message.externalId },
          data: { status: "FAILED", error: detail.slice(0, 500) },
        })
        .catch(() => undefined);
      console.error("[whatsapp] durable intake failed", { externalId: message.externalId, detail });
      return NextResponse.json({ error: "Intake failed; retry." }, { status: 503 });
    }
  }

  return NextResponse.json({ received: true, processed: results }, { status: 200 });
}
