import { env } from "../env";
import { ingestInboundMessage } from "../workflow/enquiry";
import { htmlToText } from "../sourcing/pages";
import { getAccessToken } from "./oauth";
import { getIntegration } from "../integrations/store";
import { parseJson } from "../json";
import { assertAllowedUpload } from "../storage";

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function header(part: GmailPart, name: string): string | null {
  return part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function collectParts(part: GmailPart, acc: { text: string; attachments: Array<{ filename: string; attachmentId: string }> }) {
  if (part.mimeType === "text/plain" && part.body?.data) {
    acc.text += decodeBase64Url(part.body.data).toString("utf8");
  } else if (part.mimeType === "text/html" && part.body?.data && !acc.text) {
    acc.text += htmlToText(decodeBase64Url(part.body.data).toString("utf8"));
  }
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId });
  }
  for (const child of part.parts ?? []) collectParts(child, acc);
}

/**
 * Pulls new messages from the connected mailbox. Only messages matching the
 * configured enquiry filter are read; personal folders are never fetched.
 */
export async function syncEmailIntake(): Promise<{
  ok: boolean;
  processed: number;
  skipped: number;
  detail: string;
}> {
  const provider = env.EMAIL_INTAKE_PROVIDER;
  if (provider !== "gmail" && provider !== "microsoft365") {
    return { ok: false, processed: 0, skipped: 0, detail: "No mailbox connected." };
  }
  const integration = await getIntegration(provider === "gmail" ? "GMAIL" : "MICROSOFT365");
  const config = parseJson<{ query?: string; label?: string; folder?: string }>(integration?.configJson ?? "{}", {});
  const token = await getAccessToken(provider === "gmail" ? "gmail" : "microsoft");
  if (!token) return { ok: false, processed: 0, skipped: 0, detail: "Mailbox authorisation expired. Reconnect." };

  let processed = 0;
  let skipped = 0;

  if (provider === "gmail") {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", config.query || env.EMAIL_FILTER);
    listUrl.searchParams.set("maxResults", "15");
    const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!listResponse.ok) {
      return { ok: false, processed, skipped, detail: `Gmail list failed (HTTP ${listResponse.status}).` };
    }
    const list = (await listResponse.json()) as { messages?: Array<{ id: string }> };
    for (const summary of list.messages ?? []) {
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${summary.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        skipped += 1;
        continue;
      }
      const message = (await response.json()) as {
        id: string;
        threadId?: string;
        internalDate?: string;
        payload?: GmailPart;
      };
      const payload = message.payload ?? {};
      const messageId = header(payload, "Message-ID") ?? `gmail-${message.id}`;
      const from = header(payload, "From") ?? "";
      const subject = header(payload, "Subject") ?? "";
      const acc = { text: "", attachments: [] as Array<{ filename: string; attachmentId: string }> };
      collectParts(payload, acc);

      const attachments: Array<{ filename: string; buffer: Buffer }> = [];
      for (const attachment of acc.attachments.slice(0, 5)) {
        const att = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}/attachments/${attachment.attachmentId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!att.ok) continue;
        const payloadJson = (await att.json()) as { data?: string };
        if (!payloadJson.data) continue;
        const buffer = decodeBase64Url(payloadJson.data);
        if (assertAllowedUpload(buffer, attachment.filename).ok) {
          attachments.push({ filename: attachment.filename, buffer });
        }
      }

      const result = await ingestInboundMessage({
        channel: "EMAIL",
        externalMessageId: messageId,
        from,
        subject,
        body: acc.text,
        receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : new Date(),
        conversationExternalId: message.threadId ?? null,
        attachments,
      });
      if (result.duplicate) skipped += 1;
      else processed += 1;
    }
    return { ok: true, processed, skipped, detail: `Checked ${list.messages?.length ?? 0} message(s) in Gmail.` };
  }

  const folder = config.folder || env.EMAIL_FOLDER;
  const graphUrl = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`);
  graphUrl.searchParams.set("$top", "15");
  graphUrl.searchParams.set("$select", "id,conversationId,internetMessageId,subject,from,receivedDateTime,body,hasAttachments");
  const response = await fetch(graphUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, processed, skipped, detail: `Microsoft Graph failed (HTTP ${response.status}).` };
  const data = (await response.json()) as {
    value?: Array<{
      id: string;
      conversationId?: string;
      internetMessageId?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
      receivedDateTime?: string;
      body?: { content?: string; contentType?: string };
      hasAttachments?: boolean;
    }>;
  };

  for (const message of data.value ?? []) {
    const attachments: Array<{ filename: string; buffer: Buffer }> = [];
    if (message.hasAttachments) {
      const attResponse = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${message.id}/attachments`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (attResponse.ok) {
        const attData = (await attResponse.json()) as {
          value?: Array<{ name?: string; contentBytes?: string; "@odata.type"?: string }>;
        };
        for (const attachment of (attData.value ?? []).slice(0, 5)) {
          if (!attachment.name || !attachment.contentBytes) continue;
          const buffer = Buffer.from(attachment.contentBytes, "base64");
          if (assertAllowedUpload(buffer, attachment.name).ok) {
            attachments.push({ filename: attachment.name, buffer });
          }
        }
      }
    }

    const bodyText =
      message.body?.contentType === "html"
        ? htmlToText(message.body?.content ?? "")
        : (message.body?.content ?? "");

    const result = await ingestInboundMessage({
      channel: "EMAIL",
      externalMessageId: message.internetMessageId ?? `graph-${message.id}`,
      from: message.from?.emailAddress?.address ?? "unknown@unknown",
      fromName: message.from?.emailAddress?.name ?? null,
      subject: message.subject ?? null,
      body: bodyText,
      receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date(),
      conversationExternalId: message.conversationId ?? null,
      attachments,
    });
    if (result.duplicate) skipped += 1;
    else processed += 1;
  }

  return { ok: true, processed, skipped, detail: `Checked ${data.value?.length ?? 0} message(s) in Outlook.` };
}
