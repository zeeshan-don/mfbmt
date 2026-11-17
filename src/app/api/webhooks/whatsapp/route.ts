import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { parseWhatsAppWebhook, verifyWhatsAppSignature, downloadWhatsAppMedia } from "@/lib/intake/whatsapp";
import { ingestInboundMessage } from "@/lib/workflow/enquiry";
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
 * Inbound messages. The raw body is verified before parsing; message ids are
 * stored uniquely so Meta retries cannot create duplicates.
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

  const messages = parseWhatsAppWebhook(payload as Parameters<typeof parseWhatsAppWebhook>[0]);
  const results: Array<{ id: string; outcome: string }> = [];

  for (const message of messages) {
    try {
      const attachments: Array<{ filename: string; buffer: Buffer }> = [];
      if (message.media) {
        try {
          const buffer = await downloadWhatsAppMedia(message.media.id);
          const extension =
            message.media.mimeType.split("/")[1]?.split(";")[0] ??
            (message.media.mimeType.includes("pdf") ? "pdf" : "bin");
          attachments.push({
            filename: message.media.filename ?? `whatsapp-${message.externalId}.${extension}`,
            buffer,
          });
        } catch (error) {
          await writeAudit({
            action: "whatsapp.media_failed",
            entityType: "Message",
            entityId: message.externalId,
            actorLabel: "system",
            meta: { error: error instanceof Error ? error.message : "download failed" },
          });
        }
      }

      const result = await ingestInboundMessage({
        channel: "WHATSAPP",
        externalMessageId: message.externalId,
        from: message.from,
        fromName: message.fromName ?? null,
        body: message.text,
        receivedAt: message.timestamp,
        attachments,
      });
      results.push({ id: message.externalId, outcome: result.duplicate ? "duplicate" : result.ignored ? "ignored" : "accepted" });
    } catch (error) {
      console.error("[whatsapp] ingest failed", error);
      results.push({ id: message.externalId, outcome: "failed" });
    }
  }

  return NextResponse.json({ received: true, processed: results }, { status: 200 });
}
