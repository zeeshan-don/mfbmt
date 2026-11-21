import { env, isDemoMode } from "../env";
import { getAccessToken } from "./oauth";
import { getIntegration } from "../integrations/store";
import { getCurrentOrganization } from "../organization";

export type OutgoingAttachment = { filename: string; content: Buffer; contentType: string };

/** Which mailbox is actually connected, independent of a stale env setting. */
export async function activeEmailProvider(): Promise<"gmail" | "microsoft365" | "none"> {
  const [gmail, microsoft] = await Promise.all([
    getIntegration("GMAIL"),
    getIntegration("MICROSOFT365"),
  ]);
  const gmailReady = gmail?.status === "CONNECTED" && Boolean(env.GMAIL_CLIENT_ID);
  const microsoftReady = microsoft?.status === "CONNECTED" && Boolean(env.MICROSOFT_CLIENT_ID);
  if (env.EMAIL_INTAKE_PROVIDER === "gmail" && gmailReady) return "gmail";
  if (env.EMAIL_INTAKE_PROVIDER === "microsoft365" && microsoftReady) return "microsoft365";
  if (gmailReady) return "gmail";
  if (microsoftReady) return "microsoft365";
  return "none";
}

function encodeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 900);
}

/**
 * Builds a MIME message. Attachments are base64 encoded; no external dependency
 * is needed for the text + attachments case this app actually sends.
 */
function buildMime(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
}): string {
  const boundary = `mfbmt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${encodeHeader(input.from)}`,
    `To: ${encodeHeader(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  if (input.attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(input.text).toString("base64"),
    ].join("\r\n");
  }

  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.text).toString("base64"),
  ];

  for (const attachment of input.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${encodeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename)}"`,
      "",
      attachment.content.toString("base64"),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

/** Sends through the connected company mailbox. Returns a real error, never a fake success. */
export type SendEmailResult =
  | { ok: true; simulated?: boolean; providerIds?: { messageId?: string; threadId?: string } }
  | { ok: false; error: string };

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
}): Promise<SendEmailResult> {
  // Demo mode is an adapter, not a warning: no provider request is made.
  if (isDemoMode) return { ok: true, simulated: true };
  const provider = await activeEmailProvider();
  if (provider === "none") {
    return { ok: false, error: "No company email account is connected. Connect Gmail or Microsoft 365 in Settings." };
  }
  // The sender identifies the company that owns this request. Never fall back
  // to another tenant's mailbox: the integration lookup above is tenant-scoped.
  const organization = await getCurrentOrganization().catch(() => null);
  const fromAddress = organization?.email || env.COMPANY_EMAIL_FROM || "me";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
    return { ok: false, error: "The recipient email address is not valid." };
  }

  try {
    if (provider === "gmail") {
      const token = await getAccessToken("gmail");
      if (!token) return { ok: false, error: "Gmail needs to be reconnected in Settings." };
      const raw = Buffer.from(
        buildMime({
          from: fromAddress,
          to: input.to,
          subject: input.subject,
          text: input.text,
          attachments: input.attachments ?? [],
        }),
      ).toString("base64url");
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, error: detail.error?.message ?? `Gmail returned HTTP ${response.status}.` };
      }
      const data = (await response.json().catch(() => ({}))) as { id?: string; threadId?: string };
      return { ok: true, providerIds: { messageId: data.id, threadId: data.threadId } };
    }

    const token = await getAccessToken("microsoft");
    if (!token) return { ok: false, error: "Microsoft 365 needs to be reconnected in Settings." };
    const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: "Text", content: input.text },
          toRecipients: [{ emailAddress: { address: input.to } }],
          attachments: (input.attachments ?? []).map((attachment) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: attachment.filename,
            contentType: attachment.contentType,
            contentBytes: attachment.content.toString("base64"),
          })),
        },
        saveToSentItems: true,
      }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, error: detail.error?.message ?? `Microsoft Graph returned HTTP ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Email send failed." };
  }
}

export async function testEmailConnection(): Promise<{ ok: boolean; detail: string; account?: string }> {
  const provider = await activeEmailProvider();
  if (provider === "none") {
    return {
      ok: false,
      detail: "No mailbox is connected. Connect Gmail or Microsoft 365, or use the forwarding endpoint.",
    };
  }
  if (provider === "gmail") {
    const token = await getAccessToken("gmail");
    if (!token) return { ok: false, detail: "Gmail is not connected or its authorisation expired." };
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { ok: false, detail: `Gmail returned HTTP ${response.status}.` };
    const profile = (await response.json()) as { emailAddress?: string };
    return { ok: true, detail: `Connected to ${profile.emailAddress ?? "the mailbox"}.`, account: profile.emailAddress };
  }
  const token = await getAccessToken("microsoft");
  if (!token) return { ok: false, detail: "Microsoft 365 is not connected or its authorisation expired." };
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { ok: false, detail: `Microsoft Graph returned HTTP ${response.status}.` };
  const profile = (await response.json()) as { mail?: string; userPrincipalName?: string };
  return {
    ok: true,
    detail: `Connected to ${profile.mail ?? profile.userPrincipalName ?? "the mailbox"}.`,
    account: profile.mail,
  };
}
