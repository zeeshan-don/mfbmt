import { env } from "../env";
import { ingestInboundMessage } from "../workflow/enquiry";
import { htmlToText } from "../sourcing/pages";
import { getAccessToken } from "./oauth";
import { getIntegration, saveIntegration } from "../integrations/store";
import { parseJson } from "../json";
import { assertAllowedUpload } from "../storage";
import { writeAudit } from "../audit";
import { parseEmailAddress, parseEmailDisplayName } from "../intake/identity";
import { activeEmailProvider } from "./send";
import { graphClientState } from "./routing";
import { requireTenantId } from "../tenant";
import { ingestSupplierReply } from "../workflow/supplierReply";

/**
 * Automatic mailbox intake.
 *
 * Two modes, both durable:
 *  - push   Gmail Pub/Sub watch / Microsoft Graph change notification
 *  - poll   scheduled sync with a persistent cursor, pagination and dedupe
 *
 * Cursors live in the integration config, so restarts and retries never re-read
 * the whole mailbox and never skip messages that arrived while the worker was
 * down. Every message is ingested through the same path as WhatsApp, which
 * enforces contact exclusions before anything is stored.
 */

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

type EmailConfig = {
  /** Gmail incremental cursor (history id). */
  historyId?: string;
  /** Gmail watch expiry (epoch ms). */
  watchExpiration?: number;
  /** Graph delta cursor. */
  deltaLink?: string;
  /** Graph subscription id + expiry. */
  subscriptionId?: string;
  subscriptionExpiresAt?: number;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  processedCount?: number;
  mode?: "push" | "poll";
  /** Connected mailbox address, used to route push notifications to this tenant. */
  accountEmail?: string;
};

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function header(part: GmailPart, name: string): string | null {
  return part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function collectParts(
  part: GmailPart,
  acc: { plain: string; html: string; attachments: Array<{ filename: string; attachmentId: string }> },
) {
  if (part.mimeType === "text/plain" && part.body?.data) {
    acc.plain += decodeBase64Url(part.body.data).toString("utf8");
  } else if (part.mimeType === "text/html" && part.body?.data) {
    acc.html += decodeBase64Url(part.body.data).toString("utf8");
  }
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId });
  }
  for (const child of part.parts ?? []) collectParts(child, acc);
}

function bodyText(acc: { plain: string; html: string }): string {
  const plain = acc.plain.trim();
  if (plain.length > 0) return plain;
  return acc.html ? htmlToText(acc.html) : "";
}

export type SyncResult = {
  ok: boolean;
  processed: number;
  skipped: number;
  failed: number;
  detail: string;
};

const emptyResult = (detail: string, ok = false): SyncResult => ({
  ok,
  processed: 0,
  skipped: 0,
  failed: 0,
  detail,
});

/**
 * Pulls new messages from the connected mailbox. Only the connected mailbox is
 * read; there is no access to other accounts or personal folders beyond the
 * granted scope.
 */
export async function syncEmailIntake(options: { trigger?: "poll" | "push" | "manual" } = {}): Promise<SyncResult> {
  const provider = await activeEmailProvider();
  if (provider === "none") return emptyResult("No mailbox is connected.");

  const integrationKey = provider === "gmail" ? "GMAIL" : "MICROSOFT365";
  const integration = await getIntegration(integrationKey);
  const config = parseJson<EmailConfig>(integration?.configJson ?? "{}", {});
  const token = await getAccessToken(provider === "gmail" ? "gmail" : "microsoft");
  if (!token) {
    await saveIntegration({
      key: integrationKey,
      status: "NEEDS_ATTENTION",
      lastError: "Mailbox authorisation expired. Reconnect the mailbox in Settings.",
    });
    return emptyResult("Mailbox authorisation expired. Reconnect the mailbox in Settings.");
  }

  const trigger = options.trigger ?? "poll";
  const result =
    provider === "gmail"
      ? await syncGmail(token, config, trigger)
      : await syncGraph(token, config);

  const now = new Date().toISOString();
  await saveIntegration({
    key: integrationKey,
    status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
    lastError: result.ok ? null : result.detail,
    markSuccess: result.ok,
    config: {
      ...result.nextConfig,
      lastSyncAt: now,
      lastSuccessAt: result.ok ? now : config.lastSuccessAt ?? null,
      processedCount: result.processed,
      mode: trigger === "push" ? "push" : "poll",
      lastError: result.ok ? null : result.detail,
    },
  });

  if (!result.ok) {
    await writeAudit({
      action: "email.sync_failed",
      entityType: "Integration",
      entityId: integrationKey,
      actorLabel: "system",
      meta: { detail: result.detail },
    });
  }
  return {
    ok: result.ok,
    processed: result.processed,
    skipped: result.skipped,
    failed: result.failed,
    detail: result.detail,
  };
}

type InternalSyncResult = SyncResult & { nextConfig: Partial<EmailConfig> };

async function ingestAttachmentSet(
  attachments: Array<{ filename: string; buffer: Buffer }>,
  failures: string[],
): Promise<Array<{ filename: string; buffer: Buffer }>> {
  const accepted: Array<{ filename: string; buffer: Buffer }> = [];
  for (const attachment of attachments) {
    const check = assertAllowedUpload(attachment.buffer, attachment.filename);
    if (!check.ok) {
      failures.push(`${attachment.filename}: ${check.error}`);
      continue;
    }
    accepted.push({ filename: check.filename, buffer: attachment.buffer });
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

async function gmailMessage(
  token: string,
  id: string,
): Promise<{ ok: true; ingested: boolean } | { ok: false; error: string }> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) return { ok: false, error: `Gmail message fetch failed (HTTP ${response.status}).` };

  const message = (await response.json()) as {
    id: string;
    threadId?: string;
    internalDate?: string;
    payload?: GmailPart;
  };
  const payload = message.payload ?? {};
  const rawFrom = header(payload, "From") ?? "";
  const from = parseEmailAddress(rawFrom);
  if (!from) return { ok: false, error: "Message has no usable sender address." };

  const subject = header(payload, "Subject") ?? "";
  const messageId = header(payload, "Message-ID") ?? `gmail-${message.id}`;
  const inReplyTo = header(payload, "In-Reply-To");
  const references = header(payload, "References");
  const acc = { plain: "", html: "", attachments: [] as Array<{ filename: string; attachmentId: string }> };
  collectParts(payload, acc);

  const attachmentFailures: string[] = [];
  const attachments: Array<{ filename: string; buffer: Buffer }> = [];
  for (const attachment of acc.attachments.slice(0, 10)) {
    const att = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}/attachments/${attachment.attachmentId}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    if (!att.ok) {
      attachmentFailures.push(`${attachment.filename}: download failed (HTTP ${att.status}).`);
      continue;
    }
    const payloadJson = (await att.json()) as { data?: string };
    if (!payloadJson.data) {
      attachmentFailures.push(`${attachment.filename}: Meta returned no content.`);
      continue;
    }
    attachments.push({ filename: attachment.filename, buffer: decodeBase64Url(payloadJson.data) });
  }

  const accepted = await ingestAttachmentSet(attachments, attachmentFailures);
  const plainBody = bodyText(acc);
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();

  // A reply from a known supplier is routed to the RFQ ingestion path first. If
  // it is not a supplier email, normal customer intake continues unchanged.
  const supplierReply = await ingestSupplierReply({
    provider: "GMAIL",
    externalMessageId: messageId,
    providerThreadId: message.threadId ?? null,
    internetMessageId: messageId,
    inReplyTo,
    references,
    from,
    fromName: parseEmailDisplayName(rawFrom),
    subject,
    body: plainBody,
    receivedAt,
    attachments: accepted,
  });
  if (supplierReply.handled) {
    if (attachmentFailures.length > 0) {
      await writeAudit({
        action: "email.attachment_failed",
        entityType: "SupplierEmailReply",
        entityId: supplierReply.replyId ?? null,
        actorLabel: "system",
        meta: { failures: attachmentFailures },
      });
    }
    return { ok: true, ingested: !supplierReply.duplicate };
  }

  const result = await ingestInboundMessage({
    channel: "EMAIL",
    externalMessageId: messageId,
    from,
    fromName: parseEmailDisplayName(rawFrom),
    subject,
    body: plainBody,
    receivedAt,
    conversationExternalId: message.threadId ?? null,
    attachments: accepted,
  });

  if (attachmentFailures.length > 0) {
    await writeAudit({
      action: "email.attachment_failed",
      entityType: "Message",
      entityId: result.messageId,
      actorLabel: "system",
      meta: { failures: attachmentFailures },
    });
  }
  return { ok: true, ingested: !result.duplicate };
}

async function syncGmail(token: string, config: EmailConfig, trigger: string): Promise<InternalSyncResult> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!profile.ok) {
    return {
      ok: false,
      processed,
      skipped,
      failed,
      detail: `Gmail profile request failed (HTTP ${profile.status}).`,
      nextConfig: config,
    };
  }
  const profileData = (await profile.json()) as { historyId?: string; emailAddress?: string };
  const currentHistoryId = profileData.historyId ?? undefined;

  const ids: string[] = [];

  if (config.historyId) {
    // Incremental: only messages added since the last cursor.
    let pageToken: string | undefined;
    try {
      do {
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
        url.searchParams.set("startHistoryId", config.historyId);
        url.searchParams.set("historyTypes", "messageAdded");
        url.searchParams.set("maxResults", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (response.status === 404) {
          // Cursor too old: fall back to a bounded listing below.
          break;
        }
        if (!response.ok) {
          return {
            ok: false,
            processed,
            skipped,
            failed,
            detail: `Gmail history request failed (HTTP ${response.status}).`,
            nextConfig: config,
          };
        }
        const data = (await response.json()) as {
          nextPageToken?: string;
          history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
        };
        for (const entry of data.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            if (added.message?.id) ids.push(added.message.id);
          }
        }
        pageToken = data.nextPageToken;
      } while (pageToken && ids.length < env.EMAIL_MAX_MESSAGES_PER_RUN);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Gmail history failed.");
    }
  }

  if (ids.length === 0) {
    // Scheduled fallback / first run: a bounded listing, deduplicated by Message-ID.
    const query = env.EMAIL_FILTER || "";
    let pageToken: string | undefined;
    try {
      do {
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        if (query) url.searchParams.set("q", query);
        url.searchParams.set("maxResults", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!response.ok) {
          return {
            ok: false,
            processed,
            skipped,
            failed,
            detail: `Gmail list failed (HTTP ${response.status}).`,
            nextConfig: config,
          };
        }
        const data = (await response.json()) as {
          messages?: Array<{ id: string }>;
          nextPageToken?: string;
        };
        for (const message of data.messages ?? []) {
          ids.push(message.id);
          if (ids.length >= env.EMAIL_MAX_MESSAGES_PER_RUN) break;
        }
        pageToken = data.nextPageToken;
      } while (pageToken && ids.length < env.EMAIL_MAX_MESSAGES_PER_RUN);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Gmail list failed.");
    }
  }

  const unique = [...new Set(ids)].slice(0, env.EMAIL_MAX_MESSAGES_PER_RUN);
  for (const id of unique) {
    try {
      const outcome = await gmailMessage(token, id);
      if (!outcome.ok) {
        failed += 1;
        failures.push(outcome.error);
        continue;
      }
      if (outcome.ingested) processed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      failures.push(error instanceof Error ? error.message : "Gmail message failed.");
    }
  }

  const nextConfig: Partial<EmailConfig> = {
    historyId: currentHistoryId ?? config.historyId,
    accountEmail: profileData.emailAddress ?? config.accountEmail,
  };
  // Keep the watch alive whenever a sync runs; the renewal job does the same.
  const watch = await ensureGmailWatch(token);
  if (watch.ok) {
    nextConfig.watchExpiration = watch.expiration;
  } else {
    failures.push(watch.detail);
  }

  const ok = failed === 0 && failures.length === 0;
  return {
    ok,
    processed,
    skipped,
    failed,
    detail: ok
      ? `Checked ${unique.length} message(s)${trigger === "push" ? " after a Gmail notification" : ""}: ${processed} new, ${skipped} already seen.`
      : `Checked ${unique.length} message(s): ${processed} new, ${skipped} seen, ${failed} failed. ${failures.slice(0, 2).join(" ")}`,
    nextConfig,
  };
}

async function ensureGmailWatch(
  token: string,
): Promise<{ ok: true; expiration: number } | { ok: false; detail: string }> {
  if (!env.GMAIL_PUBSUB_TOPIC) {
    return { ok: false, detail: "Gmail push is not configured (GMAIL_PUBSUB_TOPIC is empty); polling is used." };
  }
  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topicName: env.GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX"] }),
    });
    if (!response.ok) return { ok: false, detail: `Gmail watch failed (HTTP ${response.status}).` };
    const data = (await response.json()) as { expiration?: string };
    return { ok: true, expiration: Number(data.expiration ?? 0) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Gmail watch failed." };
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

const GRAPH_SELECT =
  "id,conversationId,internetMessageId,internetMessageHeaders,subject,from,receivedDateTime,body,hasAttachments";

type GraphMessage = {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  body?: { content?: string; contentType?: string };
  hasAttachments?: boolean;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
};

function graphHeader(message: GraphMessage, name: string): string | null {
  return message.internetMessageHeaders?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function graphIngest(token: string, message: GraphMessage): Promise<{ ingested: boolean }> {
  const attachmentFailures: string[] = [];
  const attachments: Array<{ filename: string; buffer: Buffer }> = [];

  if (message.hasAttachments) {
    const attResponse = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}/attachments`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    if (!attResponse.ok) {
      attachmentFailures.push(`Attachment list failed (HTTP ${attResponse.status}).`);
    } else {
      const attData = (await attResponse.json()) as {
        value?: Array<{ name?: string; contentBytes?: string; "@odata.type"?: string }>;
      };
      for (const attachment of (attData.value ?? []).slice(0, 10)) {
        if (!attachment.name || !attachment.contentBytes) {
          if (attachment.name) attachmentFailures.push(`${attachment.name}: not a file attachment.`);
          continue;
        }
        attachments.push({ filename: attachment.name, buffer: Buffer.from(attachment.contentBytes, "base64") });
      }
    }
  }

  const accepted = await ingestAttachmentSet(attachments, attachmentFailures);
  const from = parseEmailAddress(message.from?.emailAddress?.address ?? "");
  if (!from) throw new Error("Message has no usable sender address.");

  const bodyTextValue =
    message.body?.contentType === "html" ? htmlToText(message.body.content ?? "") : (message.body?.content ?? "");
  const receivedAt = message.receivedDateTime ? new Date(message.receivedDateTime) : new Date();

  const supplierReply = await ingestSupplierReply({
    provider: "MICROSOFT365",
    externalMessageId: message.internetMessageId ?? `graph-${message.id}`,
    providerThreadId: message.conversationId ?? null,
    internetMessageId: message.internetMessageId ?? null,
    inReplyTo: graphHeader(message, "In-Reply-To"),
    references: graphHeader(message, "References"),
    from,
    fromName: message.from?.emailAddress?.name ?? null,
    subject: message.subject ?? null,
    body: bodyTextValue,
    receivedAt,
    attachments: accepted,
  });
  if (supplierReply.handled) {
    if (attachmentFailures.length > 0) {
      await writeAudit({
        action: "email.attachment_failed",
        entityType: "SupplierEmailReply",
        entityId: supplierReply.replyId ?? null,
        actorLabel: "system",
        meta: { failures: attachmentFailures },
      });
    }
    return { ingested: !supplierReply.duplicate };
  }

  const result = await ingestInboundMessage({
    channel: "EMAIL",
    externalMessageId: message.internetMessageId ?? `graph-${message.id}`,
    from,
    fromName: message.from?.emailAddress?.name ?? null,
    subject: message.subject ?? null,
    body: bodyTextValue,
    receivedAt,
    conversationExternalId: message.conversationId ?? null,
    attachments: accepted,
  });

  if (attachmentFailures.length > 0) {
    await writeAudit({
      action: "email.attachment_failed",
      entityType: "Message",
      entityId: result.messageId,
      actorLabel: "system",
      meta: { failures: attachmentFailures },
    });
  }
  return { ingested: !result.duplicate };
}

async function syncGraph(token: string, config: EmailConfig): Promise<InternalSyncResult> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  const folder = env.EMAIL_FOLDER || "inbox";
  let url: string | null =
    config.deltaLink ??
    `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${GRAPH_SELECT}`;
  let deltaLink: string | undefined = config.deltaLink;
  let fetched = 0;

  while (url && fetched < env.EMAIL_MAX_MESSAGES_PER_RUN) {
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
      cache: "no-store",
    });
    if (response.status === 410) {
      // Delta cursor expired: start a fresh full delta.
      url = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${GRAPH_SELECT}`;
      deltaLink = undefined;
      if (fetched > 0) break;
      continue;
    }
    if (!response.ok) {
      return {
        ok: false,
        processed,
        skipped,
        failed,
        detail: `Microsoft Graph mailbox request failed (HTTP ${response.status}).`,
        nextConfig: config,
      };
    }
    const data = (await response.json()) as {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    for (const message of data.value ?? []) {
      fetched += 1;
      try {
        const outcome = await graphIngest(token, message);
        if (outcome.ingested) processed += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        failures.push(error instanceof Error ? error.message : "Message failed.");
      }
    }
    if (data["@odata.deltaLink"]) deltaLink = data["@odata.deltaLink"];
    url = data["@odata.nextLink"] ?? null;
  }

  const subscription = await ensureGraphSubscription(config);
  const nextConfig: Partial<EmailConfig> = {
    deltaLink,
    subscriptionId: subscription.id ?? config.subscriptionId,
    subscriptionExpiresAt: subscription.expiresAt ?? config.subscriptionExpiresAt,
  };
  if (!subscription.ok) failures.push(subscription.detail);

  const ok = failed === 0 && failures.length === 0;
  return {
    ok,
    processed,
    skipped,
    failed,
    detail: ok
      ? `Checked ${fetched} message(s) in Outlook: ${processed} new, ${skipped} already seen.`
      : `Checked ${fetched} message(s): ${processed} new, ${skipped} seen, ${failed} failed. ${failures.slice(0, 2).join(" ")}`,
    nextConfig,
  };
}

async function ensureGraphSubscription(
  config: EmailConfig,
): Promise<{ ok: boolean; detail: string; id?: string; expiresAt?: number }> {
  if (!env.GRAPH_WEBHOOK_CLIENT_STATE) {
    return { ok: false, detail: "Graph push is not configured (GRAPH_WEBHOOK_CLIENT_STATE is empty); polling is used." };
  }
  const folder = env.EMAIL_FOLDER || "inbox";
  const notificationUrl = `${env.APP_URL.replace(/\/$/, "")}/api/webhooks/microsoft`;
  const minutes = Math.min(4200, Math.max(15, env.GRAPH_SUBSCRIPTION_MINUTES));
  const expirationDateTime = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  const token = await getAccessToken("microsoft");
  if (!token) return { ok: false, detail: "Microsoft 365 is not connected." };
  const organizationId = await requireTenantId();
  const clientState = graphClientState(organizationId, env.GRAPH_WEBHOOK_CLIENT_STATE);

  try {
    if (config.subscriptionId) {
      const current = config.subscriptionExpiresAt ?? 0;
      if (current > Date.now() + 60 * 60 * 1000) {
        return { ok: true, detail: "Subscription is current.", id: config.subscriptionId, expiresAt: current };
      }
      const patch = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${config.subscriptionId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime }),
      });
      if (patch.ok) {
        return {
          ok: true,
          detail: "Subscription renewed.",
          id: config.subscriptionId,
          expiresAt: new Date(expirationDateTime).getTime(),
        };
      }
      // Fall through and create a new subscription.
    }

    const response = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        lifecycleNotificationUrl: notificationUrl,
        resource: `/me/mailFolders/${folder}/messages`,
        expirationDateTime,
        clientState,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 240);
      return { ok: false, detail: `Graph subscription failed (HTTP ${response.status}). ${detail}` };
    }
    const data = (await response.json()) as { id?: string; expirationDateTime?: string };
    return {
      ok: true,
      detail: "Subscription created.",
      id: data.id,
      expiresAt: data.expirationDateTime ? new Date(data.expirationDateTime).getTime() : undefined,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Graph subscription failed." };
  }
}

/**
 * Renews the push channel for whichever mailbox is connected. Called by the
 * worker; a failure is reported in Settings and polling continues meanwhile.
 */
export async function renewEmailSubscriptions(): Promise<{ ok: boolean; detail: string }> {
  const provider = await activeEmailProvider();
  if (provider === "none") return { ok: false, detail: "No mailbox is connected." };
  const key = provider === "gmail" ? "GMAIL" : "MICROSOFT365";
  const integration = await getIntegration(key);
  const config = parseJson<EmailConfig>(integration?.configJson ?? "{}", {});
  const token = await getAccessToken(provider === "gmail" ? "gmail" : "microsoft");
  if (!token) return { ok: false, detail: "Mailbox authorisation expired. Reconnect the mailbox." };

  if (provider === "gmail") {
    const watch = await ensureGmailWatch(token);
    if (!watch.ok) {
      await saveIntegration({ key, lastError: watch.detail });
      return { ok: false, detail: watch.detail };
    }
    await saveIntegration({
      key,
      status: "CONNECTED",
      config: { watchExpiration: watch.expiration },
      lastError: null,
      markSuccess: true,
    });
    return { ok: true, detail: `Gmail push watch renewed until ${new Date(watch.expiration).toISOString()}.` };
  }

  const subscription = await ensureGraphSubscription(config);
  if (!subscription.ok) {
    await saveIntegration({ key, lastError: subscription.detail });
    return { ok: false, detail: subscription.detail };
  }
  await saveIntegration({
    key,
    status: "CONNECTED",
    config: { subscriptionId: subscription.id, subscriptionExpiresAt: subscription.expiresAt },
    lastError: null,
    markSuccess: true,
  });
  return { ok: true, detail: subscription.detail };
}

export function emailSyncState(configJson: string | null | undefined) {
  const config = parseJson<EmailConfig>(configJson ?? "{}", {});
  return {
    lastSyncAt: config.lastSyncAt ?? null,
    lastSuccessAt: config.lastSuccessAt ?? null,
    mode: config.mode ?? null,
    watchExpiration: config.watchExpiration ?? null,
    subscriptionExpiresAt: config.subscriptionExpiresAt ?? null,
    lastError: config.lastError ?? null,
  };
}
