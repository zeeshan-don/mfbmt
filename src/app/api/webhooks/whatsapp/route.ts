import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from "@/lib/intake/whatsapp";
import { ingestInboundMessage, isSenderExcluded } from "@/lib/workflow/enquiry";
import { resolveWhatsAppOrganization } from "@/lib/integrations/whatsapp";
import { writeAudit } from "@/lib/audit";
import { runWithTenant } from "@/lib/tenant";
import { broadcastOrgRefresh } from "@/lib/realtime";

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
 * Inbound WhatsApp messages for every connected company.
 *
 * The raw body is verified with Meta's app secret before parsing. Each delivery
 * is then routed by the receiving Phone Number ID to the owning organization;
 * an unconnected number is acknowledged so Meta stops retrying, but nothing is
 * ingested and no other company's account is used.
 *
 * A message is acknowledged only after its durable receipt row exists. Media is
 * downloaded by the worker, not inside the webhook request. If durable intake
 * fails the webhook returns 503 so Meta retries instead of losing the message.
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
  const payloadHash = sha256(raw);
  const results: Array<{ id: string; outcome: string; organizationId?: string }> = [];
  const orgCache = new Map<string, string | null>();

  const organizationFor = async (phoneNumberId: string | null | undefined): Promise<string | null> => {
    if (!phoneNumberId) return null;
    if (!orgCache.has(phoneNumberId)) {
      orgCache.set(phoneNumberId, await resolveWhatsAppOrganization(phoneNumberId));
    }
    return orgCache.get(phoneNumberId) ?? null;
  };

  for (const status of parsed.statuses) {
    const organizationId = await organizationFor(status.phoneNumberId);
    if (!organizationId) {
      console.warn("[whatsapp] status for an unconnected number", { phoneNumberId: status.phoneNumberId });
      continue;
    }
    await runWithTenant({ organizationId, source: "webhook" }, async () => {
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
        return; // Duplicate status delivery; nothing to do.
      }
      await writeAudit({
        action: `whatsapp.status_${status.status}`,
        entityType: "Message",
        entityId: status.messageId,
        actorLabel: "system",
        meta: { recipient: status.recipient, errorCode: status.errorCode, error: status.errorMessage ?? null },
      });
    });
  }

  // Log coexistence-specific webhook fields once per affected tenant.
  const rawPayload = payload as { entry?: Array<{ changes?: Array<{ field?: string }> }> };
  const extraFields = new Set<string>();
  for (const entry of rawPayload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const field = change.field ?? "unknown";
      if (field !== "messages" && field !== "message_template_status_update") extraFields.add(field);
    }
  }

  for (const message of parsed.messages) {
    const organizationId = await organizationFor(message.toPhoneNumberId);
    if (!organizationId) {
      console.warn("[whatsapp] message for an unconnected number", { phoneNumberId: message.toPhoneNumberId });
      results.push({ id: message.externalId, outcome: "unrouted_number" });
      continue;
    }

    try {
      const outcome = await runWithTenant({ organizationId, source: "webhook" }, async () => {
        // 1. Durable receipt. The unique (organization, provider, externalId)
        //    makes Meta retries idempotent. Checking first avoids logging a
        //    constraint error on every legitimate retry.
        const seen = await db.webhookEvent.findFirst({
          where: { provider: "WHATSAPP", externalId: message.externalId },
        });
        if (seen) return "duplicate";
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
          return "duplicate";
        }

        for (const field of extraFields) {
          await writeAudit({
            action: `whatsapp.webhook_${field}`,
            entityType: "Integration",
            entityId: "WHATSAPP",
            actorLabel: "system",
            meta: { field, phoneNumberId: message.toPhoneNumberId },
          });
        }

        // 2. An excluded contact's content is never fetched: no media download,
        //    no body storage.
        const exclusion = await isSenderExcluded({ channel: "WHATSAPP", from: message.from });

        const result = await ingestInboundMessage({
          channel: "WHATSAPP",
          externalMessageId: message.externalId,
          from: message.from,
          fromName: message.fromName ?? null,
          to: message.toPhoneNumberId ?? null,
          toPhoneNumberId: message.toPhoneNumberId ?? null,
          body: exclusion.excluded ? "" : message.text,
          receivedAt: message.timestamp,
          mediaRefs: exclusion.excluded ? [] : message.media ? [message.media] : [],
        });

        if (!result.duplicate && !result.ignored) {
          await broadcastOrgRefresh(organizationId, "whatsapp");
        }

        await db.webhookEvent.updateMany({
          where: { provider: "WHATSAPP", externalId: message.externalId },
          data: {
            status: result.duplicate ? "PROCESSED" : "QUEUED",
            processedAt: new Date(),
          },
        });
        return result.duplicate ? "duplicate" : result.ignored ? "excluded" : "accepted";
      });
      results.push({ id: message.externalId, outcome, organizationId });
    } catch (error) {
      // Durable intake failed: keep the receipt so a retry is still deduplicated,
      // record the failure, and ask Meta to retry.
      const detail = error instanceof Error ? error.message : "Ingest failed";
      await runWithTenant({ organizationId, source: "webhook" }, async () => {
        await db.webhookEvent
          .updateMany({
            where: { provider: "WHATSAPP", externalId: message.externalId },
            data: { status: "FAILED", error: detail.slice(0, 500) },
          })
          .catch(() => undefined);
      }).catch(() => undefined);
      console.error("[whatsapp] durable intake failed", { externalId: message.externalId, detail });
      return NextResponse.json({ error: "Intake failed; retry." }, { status: 503 });
    }
  }

  return NextResponse.json({ received: true, processed: results }, { status: 200 });
}
