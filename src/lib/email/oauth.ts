import { env } from "../env";
import { getIntegration, readSecrets, saveIntegration } from "../integrations/store";

/**
 * Least-privilege scopes:
 *  - Gmail: read messages + send (nothing else, no settings, no delete).
 *  - Microsoft Graph: Mail.Read + Mail.Send + offline_access.
 */
export const SCOPES = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "openid", "email"],
  microsoft: ["offline_access", "User.Read", "Mail.Read", "Mail.Send"],
};

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
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return null;
  const url = new URL(`https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.MICROSOFT_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES.microsoft.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function requestToken(
  provider: "gmail" | "microsoft",
  body: Record<string, string>,
): Promise<TokenResponse> {
  const endpoint =
    provider === "gmail"
      ? "https://oauth2.googleapis.com/token"
      : `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return (await response.json()) as TokenResponse;
}

export async function exchangeCode(provider: "gmail" | "microsoft", code: string, state: string) {
  const body: Record<string, string> =
    provider === "gmail"
      ? {
          code,
          client_id: env.GMAIL_CLIENT_ID,
          client_secret: env.GMAIL_CLIENT_SECRET,
          redirect_uri: env.GMAIL_REDIRECT_URI,
          grant_type: "authorization_code",
        }
      : {
          code,
          client_id: env.MICROSOFT_CLIENT_ID,
          client_secret: env.MICROSOFT_CLIENT_SECRET,
          redirect_uri: env.MICROSOFT_REDIRECT_URI,
          grant_type: "authorization_code",
          scope: SCOPES.microsoft.join(" "),
        };
  const tokens = await requestToken(provider, body);
  if (!tokens.access_token) {
    return { ok: false as const, error: tokens.error_description ?? tokens.error ?? "Token exchange failed." };
  }
  await saveIntegration({
    key: provider === "gmail" ? "GMAIL" : "MICROSOFT365",
    status: "CONNECTED",
    secrets: {
      ACCESS_TOKEN: tokens.access_token,
      REFRESH_TOKEN: tokens.refresh_token ?? "",
      EXPIRES_AT: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    },
    config: { state },
    lastError: null,
  });
  return { ok: true as const };
}

/** Returns a valid access token, refreshing when expired. */
export async function getAccessToken(provider: "gmail" | "microsoft"): Promise<string | null> {
  const key = provider === "gmail" ? "GMAIL" : "MICROSOFT365";
  const secrets = await readSecrets(key);
  const expiresAt = Number(secrets.EXPIRES_AT ?? 0);
  if (secrets.ACCESS_TOKEN && expiresAt > Date.now() + 60_000) return secrets.ACCESS_TOKEN;
  if (!secrets.REFRESH_TOKEN) return secrets.ACCESS_TOKEN || null;

  const body: Record<string, string> =
    provider === "gmail"
      ? {
          client_id: env.GMAIL_CLIENT_ID,
          client_secret: env.GMAIL_CLIENT_SECRET,
          refresh_token: secrets.REFRESH_TOKEN,
          grant_type: "refresh_token",
        }
      : {
          client_id: env.MICROSOFT_CLIENT_ID,
          client_secret: env.MICROSOFT_CLIENT_SECRET,
          refresh_token: secrets.REFRESH_TOKEN,
          grant_type: "refresh_token",
          scope: SCOPES.microsoft.join(" "),
        };
  const tokens = await requestToken(provider, body);
  if (!tokens.access_token) {
    const integration = await getIntegration(key);
    if (integration) {
      await saveIntegration({ key, status: "NEEDS_ATTENTION", lastError: "Session expired. Reconnect the mailbox." });
    }
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

export async function disconnect(provider: "gmail" | "microsoft") {
  const key = provider === "gmail" ? "GMAIL" : "MICROSOFT365";
  await saveIntegration({ key, status: "DISCONNECTED", secrets: { ACCESS_TOKEN: "", REFRESH_TOKEN: "", EXPIRES_AT: "" } });
}
