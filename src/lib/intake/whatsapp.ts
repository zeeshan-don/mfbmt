import crypto from "node:crypto";
import { env } from "../env";

/**
 * WhatsApp Business Platform (Meta Cloud API) adapter.
 * Only official Cloud API endpoints are used; no browser automation or
 * personal-account access.
 */

export type ParsedWhatsAppMessage = {
  externalId: string;
  from: string;
  fromName?: string;
  timestamp: Date;
  type: string;
  text: string;
  media?: { id: string; mimeType: string; filename?: string; caption?: string; sha256?: string };
  contactName?: string;
};

type WebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
      };
    }>;
  }>;
};

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!env.META_APP_SECRET) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", env.META_APP_SECRET).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseWhatsAppWebhook(payload: WebhookPayload): ParsedWhatsAppMessage[] {
  const out: ParsedWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;
      const contactName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages) {
        const type = String(message.type ?? "unknown");
        const externalId = String(message.id ?? "");
        const from = String(message.from ?? "");
        if (!externalId || !from) continue;
        const timestampRaw = Number(message.timestamp ?? 0);
        const timestamp = timestampRaw ? new Date(timestampRaw * 1000) : new Date();

        let text = "";
        let media: ParsedWhatsAppMessage["media"];
        if (type === "text") {
          text = String((message.text as { body?: string } | undefined)?.body ?? "");
        } else if (type === "image" || type === "document" || type === "audio" || type === "video") {
          const mediaObj = message[type] as
            | { id?: string; mime_type?: string; filename?: string; caption?: string; sha256?: string }
            | undefined;
          if (mediaObj?.id) {
            media = {
              id: mediaObj.id,
              mimeType: mediaObj.mime_type ?? "application/octet-stream",
              filename: mediaObj.filename,
              caption: mediaObj.caption,
              sha256: mediaObj.sha256,
            };
            text = mediaObj.caption ?? "";
          }
        } else if (type === "button" || type === "interactive") {
          text = JSON.stringify(message[type] ?? "");
        }

        out.push({
          externalId,
          from,
          fromName: contactName,
          contactName,
          timestamp,
          type,
          text,
          media,
        });
      }
    }
  }
  return out;
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path.replace(/^\//, "")}`;
}

/** Real connection test used by Settings. Never marks connected on key presence alone. */
export async function testWhatsAppConnection(): Promise<{
  ok: boolean;
  detail: string;
  account?: string;
}> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, detail: "Access token or phone number ID is missing." };
  }
  try {
    const response = await fetch(
      graphUrl(
        `${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
      ),
      { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, cache: "no-store" },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error as { message?: string } | undefined;
      return { ok: false, detail: error?.message ?? `Meta returned HTTP ${response.status}.` };
    }
    return {
      ok: true,
      detail: `Connected to ${payload.verified_name ?? "business number"} (${payload.display_phone_number ?? "unknown"}).`,
      account: String(payload.display_phone_number ?? ""),
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Network error" };
  }
}

/** Downloads media through the official two-step media API. */
export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer> {
  if (!env.WHATSAPP_ACCESS_TOKEN) throw new Error("WhatsApp access token is not configured.");
  const metaResponse = await fetch(graphUrl(mediaId), {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    cache: "no-store",
  });
  if (!metaResponse.ok) throw new Error(`Meta media lookup failed with HTTP ${metaResponse.status}.`);
  const meta = (await metaResponse.json()) as { url?: string; file_size?: number };
  if (!meta.url) throw new Error("Meta did not return a media URL.");
  if (meta.file_size && meta.file_size > env.MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Media is larger than the ${env.MAX_UPLOAD_MB} MB limit.`);
  }
  const fileResponse = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    cache: "no-store",
  });
  if (!fileResponse.ok) throw new Error(`Media download failed with HTTP ${fileResponse.status}.`);
  const arrayBuffer = await fileResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Sends a text message. Callers must have owner approval before invoking this
 * for business communication.
 */
export async function sendWhatsAppText(to: string, body: string): Promise<{ ok: boolean; detail: string }> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return { ok: false, detail: "WhatsApp is not configured." };
  }
  const response = await fetch(graphUrl(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/[^\d]/g, ""),
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    messages?: Array<{ id: string }>;
  };
  if (!response.ok) return { ok: false, detail: payload.error?.message ?? `HTTP ${response.status}` };
  return { ok: true, detail: `Message accepted by Meta (id ${payload.messages?.[0]?.id ?? "unknown"}).` };
}

export function whatsAppStatus() {
  const missing: string[] = [];
  if (!env.META_APP_SECRET) missing.push("META_APP_SECRET");
  if (!env.WHATSAPP_ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!env.WHATSAPP_PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!env.WHATSAPP_VERIFY_TOKEN) missing.push("WHATSAPP_VERIFY_TOKEN");
  return { configured: missing.length === 0, missing };
}
