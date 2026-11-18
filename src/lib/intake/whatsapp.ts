import { env, isDemoMode, MAX_UPLOAD_MB } from "../env";
import { verifyHmacSignature } from "../crypto";
import { getWhatsAppCredentials } from "../integrations/whatsapp";

/**
 * WhatsApp Business Platform (Meta Cloud API) adapter.
 *
 * Only official Cloud API endpoints are used. Credentials come from the
 * per-account connection stored by Embedded Signup, never from a shared static
 * token, and every call reports the provider's real answer.
 */

export type WhatsAppMediaRef = {
  id: string;
  mimeType: string;
  filename?: string | null;
  caption?: string | null;
  sha256?: string | null;
};

export type ParsedWhatsAppMessage = {
  externalId: string;
  from: string;
  fromName?: string;
  toPhoneNumberId?: string | null;
  timestamp: Date;
  type: string;
  text: string;
  media?: WhatsAppMediaRef;
  contactName?: string;
  isStatusUpdate?: false;
};

export type ParsedStatusUpdate = {
  isStatusUpdate: true;
  messageId: string;
  status: string;
  recipient: string;
  timestamp: Date;
  errorCode?: number | null;
  errorMessage?: string | null;
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

/** Signature over the raw request body. Never verify a re-serialized payload. */
export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!env.META_APP_SECRET) return false;
  return verifyHmacSignature(env.META_APP_SECRET, rawBody, signatureHeader);
}

function interactiveText(value: unknown): string {
  const obj = value as
    | {
        button_reply?: { title?: string; id?: string };
        list_reply?: { title?: string; id?: string };
        type?: string;
      }
    | undefined;
  if (!obj) return "";
  const reply = obj.button_reply ?? obj.list_reply;
  if (reply?.title) return reply.title;
  return "";
}

export function parseWhatsAppWebhook(payload: WebhookPayload): {
  messages: ParsedWhatsAppMessage[];
  statuses: ParsedStatusUpdate[];
  phoneNumberIds: string[];
} {
  const messages: ParsedWhatsAppMessage[] = [];
  const statuses: ParsedStatusUpdate[] = [];
  const phoneNumberIds = new Set<string>();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const receivingPhoneNumberId = value.metadata?.phone_number_id ?? null;
      if (receivingPhoneNumberId) phoneNumberIds.add(receivingPhoneNumberId);

      for (const status of value.statuses ?? []) {
        const messageId = String(status.id ?? "");
        if (!messageId) continue;
        const errors = status.errors as Array<{ code?: number; title?: string; message?: string }> | undefined;
        statuses.push({
          isStatusUpdate: true,
          messageId,
          status: String(status.status ?? "unknown"),
          recipient: String(status.recipient_id ?? ""),
          timestamp: new Date(Number(status.timestamp ?? 0) * 1000 || Date.now()),
          errorCode: errors?.[0]?.code ?? null,
          errorMessage: errors?.[0]?.message ?? errors?.[0]?.title ?? null,
        });
      }

      const contactName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages ?? []) {
        const type = String(message.type ?? "unknown");
        const externalId = String(message.id ?? "");
        const from = String(message.from ?? "");
        if (!externalId || !from) continue;
        const timestampRaw = Number(message.timestamp ?? 0);
        const timestamp = timestampRaw ? new Date(timestampRaw * 1000) : new Date();

        let text = "";
        let media: WhatsAppMediaRef | undefined;

        if (type === "text") {
          text = String((message.text as { body?: string } | undefined)?.body ?? "");
        } else if (type === "image" || type === "document" || type === "audio" || type === "video" || type === "sticker") {
          const mediaObj = message[type] as
            | { id?: string; mime_type?: string; filename?: string; caption?: string; sha256?: string }
            | undefined;
          if (mediaObj?.id) {
            media = {
              id: mediaObj.id,
              mimeType: mediaObj.mime_type ?? "application/octet-stream",
              filename: mediaObj.filename ?? null,
              caption: mediaObj.caption ?? null,
              sha256: mediaObj.sha256 ?? null,
            };
            text = mediaObj.caption ?? "";
          }
        } else if (type === "button") {
          text = String((message.button as { text?: string } | undefined)?.text ?? "");
        } else if (type === "interactive") {
          text = interactiveText(message.interactive);
        } else if (type === "reaction") {
          text = "";
        } else if (type === "location") {
          const location = message.location as { latitude?: number; longitude?: number; name?: string } | undefined;
          text = location ? `Location: ${location.name ?? ""} ${location.latitude},${location.longitude}`.trim() : "";
        } else if (type === "contacts") {
          text = "";
        }

        messages.push({
          externalId,
          from,
          fromName: contactName,
          contactName,
          toPhoneNumberId: receivingPhoneNumberId,
          timestamp,
          type,
          text,
          media,
        });
      }
    }
  }

  return { messages, statuses, phoneNumberIds: [...phoneNumberIds] };
}

/** Two-step media download through the official API. */
export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer> {
  const credentials = await getWhatsAppCredentials();
  if (!credentials) throw new Error("WhatsApp is not connected, so media cannot be downloaded.");
  const metaResponse = await fetch(
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${credentials.accessToken}` }, cache: "no-store" },
  );
  if (!metaResponse.ok) throw new Error(`Meta media lookup failed with HTTP ${metaResponse.status}.`);
  const meta = (await metaResponse.json()) as { url?: string; file_size?: number };
  if (!meta.url) throw new Error("Meta did not return a media URL.");
  if (meta.file_size && meta.file_size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Media is larger than the ${MAX_UPLOAD_MB} MB limit.`);
  }
  const fileResponse = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${credentials.accessToken}` },
    cache: "no-store",
  });
  if (!fileResponse.ok) throw new Error(`Media download failed with HTTP ${fileResponse.status}.`);
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Media is larger than the ${MAX_UPLOAD_MB} MB limit.`);
  }
  return buffer;
}

/** Retries a transient media download. Permanent failures are returned, never swallowed. */
export async function downloadWhatsAppMediaWithRetry(
  mediaId: string,
  attempts = 3,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string; permanent: boolean }> {
  let lastError = "Media download failed.";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, buffer: await downloadWhatsAppMedia(mediaId) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Media download failed.";
      const permanent = /larger than|not connected|404|400/.test(lastError);
      if (permanent) return { ok: false, error: lastError, permanent };
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
      }
    }
  }
  return { ok: false, error: lastError, permanent: false };
}

export type SendResult = {
  ok: boolean;
  detail: string;
  messageId?: string;
  /** True when no provider call was made because this is the demo environment. */
  simulated?: boolean;
  /** True when Meta rejected a free-form message outside the 24-hour service window. */
  outsideServiceWindow?: boolean;
};

/**
 * Sends a free-form text message. Callers must have owner approval before
 * invoking this for any business communication.
 *
 * Meta only allows free-form text within 24 hours of the customer's last
 * message; outside that window an approved template is required and this
 * function reports that instead of pretending the message was delivered.
 */
export async function sendWhatsAppText(to: string, body: string): Promise<SendResult> {
  if (isDemoMode) {
    return { ok: true, simulated: true, detail: "Demo simulation — no WhatsApp message was sent.", messageId: "demo-simulated" };
  }
  const credentials = await getWhatsAppCredentials();
  if (!credentials) {
    return { ok: false, detail: "WhatsApp is not connected. Connect the business account in Settings." };
  }
  const digits = to.replace(/[^\d]/g, "");
  if (digits.length < 8) return { ok: false, detail: "The recipient number is not valid." };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: digits,
          type: "text",
          text: { preview_url: false, body: body.slice(0, 4096) },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
      messages?: Array<{ id: string }>;
    };
    if (!response.ok) {
      const code = payload.error?.code;
      const outsideWindow = code === 131047 || payload.error?.error_subcode === 2018278;
      return {
        ok: false,
        outsideServiceWindow: outsideWindow,
        detail: outsideWindow
          ? "Meta rejected the free-form message because the 24-hour customer service window is closed. An approved template is required to start the conversation."
          : (payload.error?.message ?? `Meta returned HTTP ${response.status}.`),
      };
    }
    return {
      ok: true,
      detail: `Message accepted by Meta (id ${payload.messages?.[0]?.id ?? "unknown"}).`,
      messageId: payload.messages?.[0]?.id,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "WhatsApp send failed." };
  }
}

/**
 * Uploads a document and sends it as a WhatsApp document message.
 * Business-initiated documents outside the 24-hour window still require an
 * approved template; Meta's rejection is returned rather than hidden.
 */
export async function sendWhatsAppDocument(input: {
  to: string;
  filename: string;
  buffer: Buffer;
  caption?: string;
  mimeType?: string;
}): Promise<SendResult> {
  if (isDemoMode) {
    return { ok: true, simulated: true, detail: "Demo simulation — no WhatsApp document was sent.", messageId: "demo-simulated" };
  }
  const credentials = await getWhatsAppCredentials();
  if (!credentials) {
    return { ok: false, detail: "WhatsApp is not connected. Connect the business account in Settings." };
  }
  const digits = input.to.replace(/[^\d]/g, "");
  if (digits.length < 8) return { ok: false, detail: "The recipient number is not valid." };
  const mimeType = input.mimeType ?? "application/pdf";

  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append(
      "file",
      new Blob([new Uint8Array(input.buffer)], { type: mimeType }),
      input.filename,
    );

    const upload = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      },
    );
    const uploadPayload = (await upload.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!upload.ok || !uploadPayload.id) {
      return {
        ok: false,
        detail: uploadPayload.error?.message ?? `Media upload failed with HTTP ${upload.status}.`,
      };
    }

    const response = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: digits,
          type: "document",
          document: {
            id: uploadPayload.id,
            filename: input.filename.slice(0, 120),
            caption: input.caption?.slice(0, 900),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
      messages?: Array<{ id: string }>;
    };
    if (!response.ok) {
      const outsideWindow = payload.error?.code === 131047 || payload.error?.error_subcode === 2018278;
      return {
        ok: false,
        outsideServiceWindow: outsideWindow,
        detail: outsideWindow
          ? "Meta rejected the document because the 24-hour customer service window is closed. An approved template is required first."
          : (payload.error?.message ?? `Meta returned HTTP ${response.status}.`),
      };
    }
    return {
      ok: true,
      detail: "Document delivered to Meta.",
      messageId: payload.messages?.[0]?.id,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "WhatsApp document send failed." };
  }
}
