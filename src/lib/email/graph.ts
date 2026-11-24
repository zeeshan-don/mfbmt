import { MAX_UPLOAD_MB } from "../env";

/**
 * Minimal Microsoft Graph client.
 *
 * Continuation URLs (`@odata.nextLink`, `@odata.deltaLink`) are opaque: callers
 * must use them exactly as returned. This module only adds bounded retries for
 * throttling and transient failures, a request timeout and safe error text.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const GRAPH_MAX_ATTACHMENTS = 10;
export const GRAPH_MAX_ATTACHMENT_PAGES = 4;
/** Combined attachment budget per message, never above the per-file upload cap times four. */
export const GRAPH_MAX_TOTAL_ATTACHMENT_BYTES = Math.min(MAX_UPLOAD_MB * 4, 40) * 1024 * 1024;

export function graphMessageUrl(path: string): string {
  return `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Delay for a throttled/transient Graph response. `Retry-After` wins. */
export function graphRetryDelayMs(response: Pick<Response, "headers">, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000));
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(60_000, Math.max(1_000, date - Date.now()));
  }
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

export function isRetryableGraphStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

/** Sanitised Graph error text. Never includes request headers or tokens. */
export async function graphErrorDetail(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { error?: { code?: string; message?: string } };
    const code = data.error?.code ? `${data.error.code}: ` : "";
    return `${code}${(data.error?.message ?? "").slice(0, 200)}`.trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type GraphFetchOptions = { attempts?: number; timeoutMs?: number };

/**
 * Fetches a Graph URL with bounded retries. Network errors and HTTP 429/503/504
 * are retried with exponential backoff (or `Retry-After`); other statuses are
 * returned to the caller unchanged so it can handle 401/403/410 precisely.
 */
export async function graphFetch(
  url: string,
  token: string,
  init: RequestInit = {},
  options: GraphFetchOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, Math.min(5, options.attempts ?? 3));
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!isRetryableGraphStatus(response.status) || attempt === attempts - 1) return response;
      await sleep(graphRetryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Microsoft Graph could not be reached.");
}

export type GraphMailboxProfile = {
  id: string;
  displayName: string | null;
  mailboxEmail: string;
  userPrincipalName: string | null;
};

/** The authenticated mailbox identity, as reported by Graph (never user input). */
export async function graphMailboxProfile(token: string): Promise<GraphMailboxProfile> {
  const response = await graphFetch(
    graphMessageUrl("/me?$select=id,displayName,mail,userPrincipalName"),
    token,
  );
  if (!response.ok) {
    throw new Error(`Microsoft Graph identity request failed (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as {
    id?: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const mailboxEmail = (data.mail ?? data.userPrincipalName ?? "").trim();
  if (!data.id || !mailboxEmail) {
    throw new Error("Microsoft Graph returned no mailbox address for this account.");
  }
  return {
    id: data.id,
    displayName: data.displayName ?? null,
    mailboxEmail,
    userPrincipalName: data.userPrincipalName ?? null,
  };
}

export type GraphAttachmentRecord = {
  "@odata.type"?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
};

export type GraphAttachmentResult = {
  attachments: Array<{ filename: string; buffer: Buffer; mimeType: string }>;
  failures: string[];
  unsupported: string[];
  skippedInline: number;
  pages: number;
};

function attachmentSize(attachment: GraphAttachmentRecord): number {
  if (typeof attachment.size === "number" && attachment.size >= 0) return attachment.size;
  const length = attachment.contentBytes?.length ?? 0;
  return Math.ceil((length * 3) / 4);
}

/**
 * Downloads file attachments for one message with pagination and hard limits.
 * Item and reference attachments are reported, never silently treated as files.
 * Inline signature images are skipped. Returning failures lets the caller record
 * them without losing the email.
 */
export async function downloadGraphAttachments(
  token: string,
  messageId: string,
): Promise<GraphAttachmentResult> {
  const result: GraphAttachmentResult = {
    attachments: [],
    failures: [],
    unsupported: [],
    skippedInline: 0,
    pages: 0,
  };

  let url: string | null = graphMessageUrl(
    `/me/messages/${encodeURIComponent(messageId)}/attachments?$top=50`,
  );
  let totalBytes = 0;

  while (url && result.pages < GRAPH_MAX_ATTACHMENT_PAGES) {
    let response: Response;
    try {
      response = await graphFetch(url, token);
    } catch (error) {
      result.failures.push(
        error instanceof Error ? `Attachment list failed: ${error.message}` : "Attachment list failed.",
      );
      break;
    }
    if (!response.ok) {
      result.failures.push(`Attachment list failed (HTTP ${response.status}).`);
      break;
    }
    result.pages += 1;
    const data = (await response.json()) as {
      value?: GraphAttachmentRecord[];
      "@odata.nextLink"?: string;
    };

    for (const attachment of data.value ?? []) {
      const type = attachment["@odata.type"] ?? "";
      if (type === "#microsoft.graph.itemAttachment" || type === "#microsoft.graph.referenceAttachment") {
        result.unsupported.push(attachment.name ?? type.replace("#microsoft.graph.", "").replace("Attachment", " attachment"));
        continue;
      }
      if (attachment.isInline) {
        result.skippedInline += 1;
        continue;
      }
      if (!attachment.name || !attachment.contentBytes) {
        if (attachment.name) result.failures.push(`${attachment.name}: not a readable file attachment.`);
        continue;
      }
      if (result.attachments.length >= GRAPH_MAX_ATTACHMENTS) {
        result.failures.push(
          `Only the first ${GRAPH_MAX_ATTACHMENTS} attachments of this email were read. The rest are listed for review.`,
        );
        break;
      }
      const size = attachmentSize(attachment);
      if (size > MAX_UPLOAD_MB * 1024 * 1024) {
        result.failures.push(`${attachment.name}: larger than the ${MAX_UPLOAD_MB} MB limit.`);
        continue;
      }
      if (totalBytes + size > GRAPH_MAX_TOTAL_ATTACHMENT_BYTES) {
        result.failures.push(`${attachment.name}: attachment size limit for one email reached.`);
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(attachment.contentBytes, "base64");
      } catch {
        result.failures.push(`${attachment.name}: the file content could not be decoded.`);
        continue;
      }
      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_MB * 1024 * 1024) {
        result.failures.push(`${attachment.name}: the file content is empty or too large.`);
        continue;
      }
      totalBytes += buffer.length;
      result.attachments.push({
        filename: attachment.name,
        buffer,
        mimeType: attachment.contentType ?? "application/octet-stream",
      });
    }

    url = data["@odata.nextLink"] ?? null;
  }

  if (url && result.pages >= GRAPH_MAX_ATTACHMENT_PAGES) {
    result.failures.push("The attachment list was too long to read completely. Open the email to check it.");
  }

  return result;
}
