import { env } from "../env";
import { getAccessToken } from "./oauth";

function encodeMime(to: string, subject: string, text: string): string {
  const from = env.COMPANY_EMAIL_FROM || "me";
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

/** Sends through the connected company mailbox. Returns a real error, never a fake success. */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (env.EMAIL_INTAKE_PROVIDER === "none") {
    return { ok: false, error: "No company email account is connected." };
  }

  try {
    if (env.EMAIL_INTAKE_PROVIDER === "gmail") {
      const token = await getAccessToken("gmail");
      if (!token) return { ok: false, error: "Gmail needs to be reconnected in Settings." };
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: encodeMime(input.to, input.subject, input.text) }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, error: detail.error?.message ?? `Gmail returned HTTP ${response.status}.` };
      }
      return { ok: true };
    }

    if (env.EMAIL_INTAKE_PROVIDER === "microsoft365") {
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
          },
          saveToSentItems: true,
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, error: detail.error?.message ?? `Microsoft Graph returned HTTP ${response.status}.` };
      }
      return { ok: true };
    }

    return {
      ok: false,
      error: "Only Gmail and Microsoft 365 can send mail from this app. Use the download and send it from your own mailbox.",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Email send failed." };
  }
}

export async function testEmailConnection(): Promise<{ ok: boolean; detail: string; account?: string }> {
  const provider = env.EMAIL_INTAKE_PROVIDER;
  if (provider === "none") {
    return { ok: false, detail: "No email provider selected. Choose Gmail or Microsoft 365 and connect a mailbox." };
  }
  if (provider === "gmail") {
    const token = await getAccessToken("gmail");
    if (!token) return { ok: false, detail: "Gmail is not connected." };
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { ok: false, detail: `Gmail returned HTTP ${response.status}.` };
    const profile = (await response.json()) as { emailAddress?: string };
    return { ok: true, detail: `Connected to ${profile.emailAddress ?? "the mailbox"}.`, account: profile.emailAddress };
  }
  if (provider === "microsoft365") {
    const token = await getAccessToken("microsoft");
    if (!token) return { ok: false, detail: "Microsoft 365 is not connected." };
    const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { ok: false, detail: `Microsoft Graph returned HTTP ${response.status}.` };
    const profile = (await response.json()) as { mail?: string; userPrincipalName?: string };
    return { ok: true, detail: `Connected to ${profile.mail ?? profile.userPrincipalName ?? "the mailbox"}.`, account: profile.mail };
  }
  return { ok: false, detail: "Forwarding intake uses a shared secret; test it by sending a test email." };
}
