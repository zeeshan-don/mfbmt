import crypto from "node:crypto";
import { env } from "../env";
import { getIntegration, readSecrets, readSecretsDetailed, saveIntegration } from "../integrations/store";
import { parseJson } from "../json";
import { signPayload, verifySignedPayload, timingSafeEqual } from "../crypto";
import { graphErrorDetail, graphFetch, graphMailboxProfile } from "./graph";

/**
 * OAuth for the company mailbox.
 *
 * Microsoft uses the Authorization Code flow with PKCE. The state value is
 * high-entropy, single-use and bound to the initiating organisation and owner by
 * a signed, HttpOnly cookie. No token is ever placed in a URL or browser state.
 *
 * The initial connection is READ-ONLY (Mail.Read). Sending is a separate,
 * explicitly requested consent (Mail.Send) and an existing mailbox that already
 * has it never loses it during a read-only reconnect.
 */
export const SCOPES = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "openid", "email"],
  microsoft: ["offline_access", "User.Read", "Mail.Read", "Mail.Send"],
} as const;

/** Scopes requested on first connection. Read-only. */
export const MICROSOFT_READ_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
] as const;

/** Additional delegated scope requested only when the owner enables sending. */
export const MICROSOFT_SEND_SCOPE = "Mail.Send";

/** Documented but not requested: this pass does not claim shared-mailbox support. */
export const MICROSOFT_SHARED_SCOPE = "Mail.Read.Shared";

export type MicrosoftOAuthIntent = "read" | "send";

export function microsoftScopes(intent: MicrosoftOAuthIntent): string[] {
  return intent === "send"
    ? [...MICROSOFT_READ_SCOPES, MICROSOFT_SEND_SCOPE]
    : [...MICROSOFT_READ_SCOPES];
}

// ── OAuth state and PKCE ────────────────────────────────────────────────────

export type MicrosoftOAuthState = {
  provider: "microsoft";
  organizationId: string;
  userId: string;
  nonce: string;
  verifier: string;
  intent: MicrosoftOAuthIntent;
};

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** Short-lived, HMAC-signed state stored only in an HttpOnly cookie. */
export function createMicrosoftOAuthState(input: {
  organizationId: string;
  userId: string;
  intent: MicrosoftOAuthIntent;
}): { state: string; cookieValue: string; verifier: string; challenge: string } {
  const { verifier, challenge } = createPkcePair();
  const nonce = crypto.randomBytes(24).toString("base64url");
  const payload: MicrosoftOAuthState = {
    provider: "microsoft",
    organizationId: input.organizationId,
    userId: input.userId,
    nonce,
    verifier,
    intent: input.intent,
  };
  return {
    state: nonce,
    cookieValue: signPayload(payload, 600),
    verifier,
    challenge,
  };
}

/**
 * Validates the callback state against the signed cookie and the owner who is
 * currently signed in. The cookie is deleted by the caller before this runs, so
 * a replayed callback has nothing to match.
 */
export function verifyMicrosoftOAuthState(input: {
  cookieValue: string | undefined;
  returnedState: string | null;
  organizationId: string;
  userId: string;
}):
  | { ok: true; data: MicrosoftOAuthState }
  | { ok: false; error: string } {
  if (!input.cookieValue) return { ok: false, error: "The sign-in attempt expired. Start again." };
  if (!input.returnedState) return { ok: false, error: "Microsoft did not return a sign-in state." };
  const verified = verifySignedPayload<MicrosoftOAuthState>(input.cookieValue);
  if (!verified.ok) return { ok: false, error: "The sign-in attempt expired. Start again." };
  const data = verified.data;
  if (data.provider !== "microsoft") return { ok: false, error: "This sign-in attempt is not valid." };
  if (!timingSafeEqual(data.nonce, input.returnedState)) {
    return { ok: false, error: "The sign-in state did not match. Start again." };
  }
  if (data.organizationId !== input.organizationId) {
    return { ok: false, error: "This sign-in attempt belongs to a different company. Start again." };
  }
  if (data.userId !== input.userId) {
    return { ok: false, error: "This sign-in attempt was started by a different user. Start again." };
  }
  if (data.intent !== "read" && data.intent !== "send") {
    return { ok: false, error: "This sign-in attempt is not valid." };
  }
  return { ok: true, data };
}

export function microsoftAuthorizeUrl(input: {
  state: string;
  codeChallenge: string;
  intent: MicrosoftOAuthIntent;
  loginHint?: string | null;
}): string {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(env.MICROSOFT_TENANT_ID || "common")}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.MICROSOFT_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", microsoftScopes(input.intent).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Show the permissions being granted, and make incremental consent explicit.
  url.searchParams.set("prompt", "consent");
  const hint = (input.loginHint ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint)) url.searchParams.set("login_hint", hint);
  return url.toString();
}

export function microsoftConfigured(): boolean {
  return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
}

// ── Gmail (unchanged behaviour) ─────────────────────────────────────────────

export function buildAuthUrl(provider: "gmail" | "microsoft", state: string): string | null {
  if (provider === "gmail") {
    if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) return null;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GMAIL_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.GMAIL_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.gmail.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }
  if (!microsoftConfigured()) return null;
  // Legacy callers must use createMicrosoftOAuthState + microsoftAuthorizeUrl.
  return null;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function requestToken(provider: "gmail" | "microsoft", body: Record<string, string>): Promise<TokenResponse> {
  const endpoint =
    provider === "gmail"
      ? "https://oauth2.googleapis.com/token"
      : `https://login.microsoftonline.com/${encodeURIComponent(env.MICROSOFT_TENANT_ID || "common")}/oauth2/v2.0/token`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  return (await response.json()) as TokenResponse;
}

/** Gmail only. Microsoft connections use exchangeMicrosoftCode. */
export async function exchangeCode(provider: "gmail" | "microsoft", code: string, _state: string) {
  if (provider === "microsoft") {
    return { ok: false as const, error: "Use the Microsoft sign-in flow to connect Outlook." };
  }
  const tokens = await requestToken("gmail", {
    code,
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    redirect_uri: env.GMAIL_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (!tokens.access_token) {
    return { ok: false as const, error: tokens.error_description ?? tokens.error ?? "Token exchange failed." };
  }
  await saveIntegration({
    key: "GMAIL",
    status: "CONNECTED",
    secrets: {
      ACCESS_TOKEN: tokens.access_token,
      REFRESH_TOKEN: tokens.refresh_token ?? "",
      EXPIRES_AT: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    },
    lastError: null,
  });
  return { ok: true as const };
}

// ── Microsoft connection ────────────────────────────────────────────────────

export type MicrosoftTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  grantedScopes: string[];
  tenantId: string | null;
};

function idTokenClaims(idToken?: string): { tid?: string } {
  if (!idToken) return {};
  const part = idToken.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { tid?: string };
  } catch {
    return {};
  }
}

function parseScopeList(scope: string | undefined, fallback: string[]): string[] {
  const list = (scope ?? "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : fallback;
}

export function microsoftOAuthErrorMessage(raw: string | undefined): string {
  const text = (raw ?? "").slice(0, 400);
  if (/AADSTS65001|consent_required|admin consent/i.test(text)) {
    return "Your Microsoft administrator must approve MFBMT for this company before the mailbox can be connected.";
  }
  if (/access_denied|user cancelled|user_cancelled/i.test(text)) {
    return "The Microsoft sign-in was cancelled or access was not granted.";
  }
  if (/AADSTS50020|AADSTS700016|unauthorized_client/i.test(text)) {
    return "Microsoft rejected the sign-in for this mailbox. Ask your Microsoft administrator to check the MFBMT app registration.";
  }
  if (/invalid_grant|expired|interaction_required/i.test(text)) {
    return "The Microsoft sign-in expired. Please start again.";
  }
  return "Microsoft could not complete the sign-in. Please try again.";
}

export type MicrosoftConnectResult =
  | {
      ok: true;
      accountEmail: string;
      displayName: string | null;
      graphUserId: string;
      tenantId: string | null;
      grantedScopes: string[];
      sendingEnabled: boolean;
      folder: string;
    }
  | { ok: false; error: string; needsAdminConsent?: boolean };

/**
 * Exchanges the authorization code with its PKCE verifier, then verifies the
 * real mailbox identity and mailbox access against Microsoft Graph. The email
 * address typed by the browser is never trusted as identity.
 */
export async function exchangeMicrosoftCode(input: {
  code: string;
  codeVerifier: string;
  intent: MicrosoftOAuthIntent;
}): Promise<MicrosoftConnectResult> {
  const requestedScopes = microsoftScopes(input.intent);
  const tokens = await requestToken("microsoft", {
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    code: input.code,
    redirect_uri: env.MICROSOFT_REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
    scope: requestedScopes.join(" "),
  });
  if (!tokens.access_token) {
    const raw = tokens.error_description ?? tokens.error;
    return {
      ok: false,
      error: microsoftOAuthErrorMessage(raw),
      needsAdminConsent: /AADSTS65001|consent_required|admin consent/i.test(raw ?? ""),
    };
  }

  const profile = await graphMailboxProfile(tokens.access_token).catch(() => null);
  if (!profile) {
    return { ok: false, error: "Microsoft Graph did not return the signed-in mailbox identity. Please try again." };
  }

  const folder = env.EMAIL_FOLDER || "inbox";
  try {
    const mailboxCheck = await graphFetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}?$select=id,displayName`,
      tokens.access_token,
    );
    if (!mailboxCheck.ok) {
      if (mailboxCheck.status === 404) {
        const inbox = await graphFetch(
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id,displayName",
          tokens.access_token,
        );
        if (!inbox.ok) {
          return {
            ok: false,
            error:
              inbox.status === 403
                ? "Microsoft did not grant permission to read this mailbox. Approve the mailbox read permission and try again."
                : `The mailbox could not be opened (HTTP ${inbox.status}). ${await graphErrorDetail(inbox)}`,
          };
        }
      } else if (mailboxCheck.status === 403) {
        return {
          ok: false,
          error:
            "Microsoft did not grant permission to read this mailbox. Approve the mailbox read permission and try again.",
        };
      } else {
        return {
          ok: false,
          error: `The mailbox could not be opened (HTTP ${mailboxCheck.status}). ${await graphErrorDetail(mailboxCheck)}`,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `The mailbox could not be reached: ${error.message}` : "The mailbox could not be reached.",
    };
  }

  const existing = await getIntegration("MICROSOFT365");
  const existingConfig = parseJson<MicrosoftConfigShape>(existing?.configJson ?? "{}", {});
  const existingSecrets = await readSecrets("MICROSOFT365");
  // A pre-upgrade connection requested Mail.Send as part of its only consent.
  // Its stored config has no scope list, so preserve that capability explicitly.
  const previousScopes = Array.isArray(existingConfig.grantedScopes)
    ? existingConfig.grantedScopes
    : existing?.status === "CONNECTED"
      ? [...MICROSOFT_READ_SCOPES, MICROSOFT_SEND_SCOPE]
      : [];
  const hasPreviousConnection = Boolean(existingConfig.graphUserId);

  // Enabling sending must never swap the connected mailbox for another account.
  if (input.intent === "send" && hasPreviousConnection && existingConfig.graphUserId !== profile.id) {
    return {
      ok: false,
      error: "This Microsoft account does not match the mailbox already connected. Sign in with the connected mailbox.",
    };
  }

  // An existing Mail.Send grant is preserved on a read-only reconnect.
  const mergedScopes = [...new Set([...parseScopeList(tokens.scope, requestedScopes), ...previousScopes])];
  const sendingEnabled = mergedScopes.includes(MICROSOFT_SEND_SCOPE);

  await saveIntegration({
    key: "MICROSOFT365",
    status: "CONNECTED",
    accountLabel: profile.mailboxEmail,
    lastError: null,
    markSuccess: true,
    secrets: {
      ACCESS_TOKEN: tokens.access_token,
      REFRESH_TOKEN: tokens.refresh_token || existingSecrets.REFRESH_TOKEN || "",
      EXPIRES_AT: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      GRANTED_SCOPES: mergedScopes.join(" "),
    },
    config: {
      provider: "microsoft365",
      accountEmail: profile.mailboxEmail,
      displayName: profile.displayName,
      graphUserId: profile.id,
      userPrincipalName: profile.userPrincipalName,
      tenantId: idTokenClaims(tokens.id_token).tid ?? existingConfig.tenantId ?? null,
      mailboxMode: "user",
      folder,
      grantedScopes: mergedScopes,
      sendingEnabled,
      syncStatus: input.intent === "send" ? (existingConfig.syncStatus ?? "IDLE") : "CONNECTING",
      connectionStatus: "CONNECTED",
      connectedAt: new Date().toISOString(),
      lastError: null,
    },
  });

  return {
    ok: true,
    accountEmail: profile.mailboxEmail,
    displayName: profile.displayName,
    graphUserId: profile.id,
    tenantId: idTokenClaims(tokens.id_token).tid ?? null,
    grantedScopes: mergedScopes,
    sendingEnabled,
    folder,
  };
}

/** Non-secret mailbox configuration persisted in Integration.configJson. */
export type MicrosoftConfigShape = {
  provider?: string;
  accountEmail?: string;
  displayName?: string | null;
  graphUserId?: string;
  userPrincipalName?: string | null;
  tenantId?: string | null;
  mailboxMode?: "user" | "shared";
  folder?: string;
  grantedScopes?: string[];
  sendingEnabled?: boolean;
  syncStatus?: string;
  connectionStatus?: string;
  connectedAt?: string;
  initialSyncDays?: number;
  initialSyncCompleted?: boolean;
  stats?: {
    messagesScanned?: number;
    enquiriesCreated?: number;
    supplierReplies?: number;
    messagesIgnored?: number;
    attachmentsProcessed?: number;
    attachmentsFailed?: number;
  };
  lastError?: string | null;
};

export function microsoftConnectionState(
  configJson: string | null | undefined,
  status: string | null | undefined,
) {
  const config = parseJson<MicrosoftConfigShape>(configJson ?? "{}", {});
  const grantedScopes = Array.isArray(config.grantedScopes) ? config.grantedScopes : [];
  // Mailboxes connected before this upgrade already hold Mail.Send (it was the
  // only consent the old flow requested), so sending is not silently lost.
  const legacySending = !Array.isArray(config.grantedScopes) && status === "CONNECTED";
  const stats = config.stats ?? {};
  const syncStatus = config.syncStatus ?? (status === "CONNECTED" ? "IDLE" : "NOT_CONNECTED");
  return {
    connected: status === "CONNECTED",
    status: status ?? "NOT_CONFIGURED",
    accountEmail: config.accountEmail ?? null,
    displayName: config.displayName ?? null,
    graphUserId: config.graphUserId ?? null,
    tenantId: config.tenantId ?? null,
    mailboxMode: config.mailboxMode ?? "user",
    folder: config.folder ?? env.EMAIL_FOLDER,
    grantedScopes,
    sendingEnabled: legacySending || Boolean(config.sendingEnabled && grantedScopes.includes(MICROSOFT_SEND_SCOPE)),
    syncStatus,
    initialSyncCompleted: Boolean(config.initialSyncCompleted),
    initialSyncDays: config.initialSyncDays ?? env.EMAIL_INITIAL_SYNC_DAYS,
    stats: {
      messagesScanned: stats.messagesScanned ?? 0,
      enquiriesCreated: stats.enquiriesCreated ?? 0,
      supplierReplies: stats.supplierReplies ?? 0,
      messagesIgnored: stats.messagesIgnored ?? 0,
      attachmentsProcessed: stats.attachmentsProcessed ?? 0,
      attachmentsFailed: stats.attachmentsFailed ?? 0,
    },
  };
}

/** True only when this mailbox explicitly granted Mail.Send. */
export async function microsoftSendingEnabled(): Promise<boolean> {
  const integration = await getIntegration("MICROSOFT365");
  if (integration?.status !== "CONNECTED") return false;
  const config = parseJson<MicrosoftConfigShape>(integration.configJson, {});
  if (!Array.isArray(config.grantedScopes)) {
    // Legacy connection created by the old flow, which requested Mail.Send.
    // The provider response at send time remains the final authority.
    return true;
  }
  return Boolean(config.sendingEnabled && config.grantedScopes.includes(MICROSOFT_SEND_SCOPE));
}

/**
 * Returns a valid access token. Microsoft tokens are refreshed with the granted
 * scopes; revoked or expired consent marks the integration as needing the
 * owner's attention instead of returning a broken token.
 */
export async function getAccessToken(
  provider: "gmail" | "microsoft",
  options: { force?: boolean } = {},
): Promise<string | null> {
  const key = provider === "gmail" ? "GMAIL" : "MICROSOFT365";

  if (provider === "gmail") {
    const secrets = await readSecrets(key);
    const expiresAt = Number(secrets.EXPIRES_AT ?? 0);
    if (secrets.ACCESS_TOKEN && expiresAt > Date.now() + 60_000) return secrets.ACCESS_TOKEN;
    if (!secrets.REFRESH_TOKEN) return secrets.ACCESS_TOKEN || null;
    const tokens = await requestToken("gmail", {
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: secrets.REFRESH_TOKEN,
      grant_type: "refresh_token",
    });
    if (!tokens.access_token) {
      await saveIntegration({ key, status: "NEEDS_ATTENTION", lastError: "Session expired. Reconnect the mailbox." });
      return null;
    }
    await saveIntegration({
      key,
      status: "CONNECTED",
      secrets: {
        ACCESS_TOKEN: tokens.access_token,
        REFRESH_TOKEN: tokens.refresh_token ?? secrets.REFRESH_TOKEN,
        EXPIRES_AT: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      },
    });
    return tokens.access_token;
  }

  const detailed = await readSecretsDetailed("MICROSOFT365");
  if (detailed.failed.length > 0) {
    await saveIntegration({
      key,
      status: "NEEDS_ATTENTION",
      lastError:
        "Stored Microsoft credentials could not be decrypted. The encryption key may have changed; reconnect Outlook.",
    });
    return null;
  }
  const secrets = detailed.secrets;
  const expiresAt = Number(secrets.EXPIRES_AT ?? 0);
  if (!options.force && secrets.ACCESS_TOKEN && expiresAt > Date.now() + 60_000) return secrets.ACCESS_TOKEN;
  if (!secrets.REFRESH_TOKEN) {
    if (secrets.ACCESS_TOKEN) return secrets.ACCESS_TOKEN;
    await saveIntegration({
      key,
      status: "NEEDS_ATTENTION",
      lastError: "Microsoft authorisation is missing. Reconnect Outlook in Settings.",
    });
    return null;
  }

  const storedScopes = (secrets.GRANTED_SCOPES ?? "").split(/\s+/).filter(Boolean);
  const scopes = storedScopes.length > 0 ? storedScopes : microsoftScopes("read");
  const tokens = await requestToken("microsoft", {
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    refresh_token: secrets.REFRESH_TOKEN,
    grant_type: "refresh_token",
    // For a legacy connection (no recorded scopes) omit scope so Microsoft
    // returns the originally granted set, including Mail.Send if it was granted.
    ...(storedScopes.length > 0 ? { scope: storedScopes.join(" ") } : {}),
  });
  if (!tokens.access_token) {
    const revoked = /invalid_grant|interaction_required|consent_required|AADSTS700082|AADSTS50173/i.test(
      tokens.error_description ?? tokens.error ?? "",
    );
    await saveIntegration({
      key,
      status: "NEEDS_ATTENTION",
      secrets: { ACCESS_TOKEN: "" },
      lastError: revoked
        ? "Microsoft sign-in expired or access was revoked. Reconnect Outlook in Settings."
        : "Microsoft could not refresh the mailbox session. Reconnect Outlook in Settings.",
    });
    return null;
  }

  const mergedScopes = [...new Set([...parseScopeList(tokens.scope, scopes), ...storedScopes])];
  await saveIntegration({
    key,
    status: "CONNECTED",
    secrets: {
      ACCESS_TOKEN: tokens.access_token,
      REFRESH_TOKEN: tokens.refresh_token ?? secrets.REFRESH_TOKEN,
      EXPIRES_AT: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      GRANTED_SCOPES: mergedScopes.join(" "),
    },
    config: { grantedScopes: mergedScopes },
  });
  return tokens.access_token;
}

/**
 * Disconnects the mailbox: deletes the Graph subscription where possible, clears
 * credentials/cursors and stops further scheduling. Historical enquiries,
 * replies, quotations and attachments are never deleted.
 */
export async function disconnect(provider: "gmail" | "microsoft") {
  const key = provider === "gmail" ? "GMAIL" : "MICROSOFT365";
  const integration = await getIntegration(key);
  const config = parseJson<{ subscriptionId?: string }>(integration?.configJson ?? "{}", {});

  if (provider === "microsoft" && config.subscriptionId) {
    try {
      const token = await getAccessToken("microsoft");
      if (token) {
        await graphFetch(
          `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(config.subscriptionId)}`,
          token,
          { method: "DELETE" },
          { attempts: 1 },
        );
      }
    } catch {
      // A subscription that cannot be deleted expires on its own; disconnect
      // must still clear local credentials and stop scheduling.
    }
  }

  if (provider === "gmail") {
    await saveIntegration({
      key,
      status: "DISCONNECTED",
      secrets: { ACCESS_TOKEN: "", REFRESH_TOKEN: "", EXPIRES_AT: "" },
    });
    return;
  }

  await saveIntegration({
    key,
    status: "DISCONNECTED",
    accountLabel: null,
    lastError: null,
    markSuccess: false,
    secrets: { ACCESS_TOKEN: "", REFRESH_TOKEN: "", EXPIRES_AT: "", GRANTED_SCOPES: "" },
    config: {
      accountEmail: null,
      displayName: null,
      graphUserId: null,
      userPrincipalName: null,
      tenantId: null,
      mailboxMode: null,
      grantedScopes: [],
      sendingEnabled: false,
      deltaLink: null,
      subscriptionId: null,
      subscriptionExpiresAt: null,
      syncStatus: "NOT_CONNECTED",
      connectionStatus: "DISCONNECTED",
      initialSyncCompleted: false,
      stats: {},
      lastError: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastAttemptedSyncAt: null,
      processedCount: 0,
    },
    nextSyncAt: null,
  });
}
