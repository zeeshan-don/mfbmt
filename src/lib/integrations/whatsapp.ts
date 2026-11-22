import { env } from "../env";
import { signPayload, verifySignedPayload, tryDecryptSecret } from "../crypto";
import { rawDb } from "../db-base";
import { getIntegration, readSecretsDetailed, saveIntegration, clearIntegration } from "./store";
import { parseJson } from "../json";

/**
 * Meta WhatsApp Business Embedded Signup (JS SDK / v4) + Coexistence.
 *
 * Adapted from CoolCare's working implementation (api/whatsapp-connect.js):
 *   initiate → FB.login(config_id) → complete(code, wabaId, phoneNumberId?)
 *   → token exchange → long-lived token → WABA phone resolution → webhook
 *   subscription → encrypted per-account storage.
 *
 * your company stores its own credentials in its own database. No CoolCare token, WABA
 * id, phone number id or customer record is reused, and no unofficial client
 * (WhatsApp Web automation, session cookies, scraping) is involved.
 */

const SIGNUP_STATE_TTL_SECONDS = 10 * 60;

export type SignupLaunch = {
  appId: string;
  configId: string;
  apiVersion: string;
  state: string;
  redirectUri: string;
};

export type WhatsAppConnection = {
  connected: boolean;
  status: string;
  phoneNumber: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessId: string | null;
  businessName: string | null;
  coexistence: boolean;
  webhookStatus: string | null;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  accountLabel: string | null;
};

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path.replace(/^\//, "")}`;
}

async function graphJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error as { message?: string; code?: number } | undefined;
      return {
        ok: false,
        status: response.status,
        error: error?.message ?? `Meta returned HTTP ${response.status}.`,
      };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Meta request failed.",
    };
  }
}

/** Launch configuration for the browser SDK. The state binds the flow to this app. */
export function createSignupLaunch(coexistence = false): SignupLaunch {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new Error(
      "META_APP_ID and META_APP_SECRET must be configured before WhatsApp can be connected.",
    );
  }
  const configId =
    (coexistence ? env.META_EMBEDDED_SIGNUP_CONFIG_ID_COEXISTENCE : "") ||
    env.META_EMBEDDED_SIGNUP_CONFIG_ID;
  if (!configId) {
    throw new Error(
      "META_EMBEDDED_SIGNUP_CONFIG_ID is not set. Create a Facebook Login for Business configuration (WhatsApp Embedded Signup template) in the Meta App Dashboard and set its configuration ID.",
    );
  }
  return {
    appId: env.META_APP_ID,
    configId,
    apiVersion: env.META_GRAPH_API_VERSION,
    state: signPayload({ purpose: "whatsapp-signup", coexistence }, SIGNUP_STATE_TTL_SECONDS),
    redirectUri: `${env.APP_URL.replace(/\/$/, "")}/api/integrations/whatsapp`,
  };
}

export function verifySignupState(state: string): { ok: true; coexistence: boolean } | { ok: false; error: string } {
  const result = verifySignedPayload<{ purpose?: string; coexistence?: boolean }>(state);
  if (!result.ok) return { ok: false, error: result.error };
  if (result.data.purpose !== "whatsapp-signup") return { ok: false, error: "Unexpected signup state." };
  return { ok: true, coexistence: Boolean(result.data.coexistence) };
}

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string };
};

/** Exchanges the Embedded Signup code. v4 codes are exchanged without a redirect_uri. */
export async function exchangeCodeForToken(code: string): Promise<{ ok: true; accessToken: string; expiresIn: number } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
  });
  const result = await graphJson<TokenResponse>(`${graphUrl("oauth/access_token")}?${params.toString()}`);
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.access_token) return { ok: false, error: "Meta did not return an access token." };
  return {
    ok: true,
    accessToken: result.data.access_token,
    expiresIn: result.data.expires_in ?? 5_184_000,
  };
}

/** Best-effort long-lived token exchange. A short-lived token is used if it fails. */
export async function extendToken(accessToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: accessToken,
  });
  const result = await graphJson<TokenResponse>(`${graphUrl("oauth/access_token")}?${params.toString()}`);
  if (result.ok && result.data.access_token) {
    return { accessToken: result.data.access_token, expiresIn: result.data.expires_in ?? 5_184_000 };
  }
  return { accessToken, expiresIn: 5_184_000 };
}

export async function fetchBusinessProfile(accessToken: string) {
  const result = await graphJson<{ id?: string; name?: string }>(
    `${graphUrl("me")}?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
  );
  return result.ok ? { businessId: result.data.id ?? null, businessName: result.data.name ?? null } : {};
}

export async function fetchPhoneNumberInfo(phoneNumberId: string, accessToken: string) {
  const result = await graphJson<{
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    is_on_biz_app?: boolean;
    platform_type?: string;
  }>(
    `${graphUrl(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!result.ok) return null;
  const data = result.data;
  return {
    phoneNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
    isOnBizApp: data.is_on_biz_app === true,
    platformType: data.platform_type ?? null,
  };
}

/**
 * Coexistence completions do not return a phone_number_id, so the number behind
 * the freshly exchanged token is read from the WABA. That lookup also proves the
 * token can actually access the account.
 */
export async function resolveWabaPrimaryPhone(wabaId: string, accessToken: string) {
  const result = await graphJson<{
    phone_numbers?: {
      data?: Array<{
        id?: string;
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        is_on_biz_app?: boolean;
        platform_type?: string;
      }>;
    };
  }>(
    `${graphUrl(wabaId)}?fields=id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type}&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!result.ok) return null;
  const phones = result.data.phone_numbers?.data ?? [];
  if (phones.length === 0) return null;
  const pick =
    phones.find((p) => p.is_on_biz_app === true) ??
    phones.find((p) => p.platform_type === "CLOUD_API") ??
    phones[0];
  if (!pick?.id) return null;
  return {
    phoneNumberId: pick.id,
    phoneNumber: pick.display_phone_number ?? null,
    verifiedName: pick.verified_name ?? null,
    qualityRating: pick.quality_rating ?? null,
    isOnBizApp: pick.is_on_biz_app === true,
    platformType: pick.platform_type ?? null,
  };
}

export async function subscribeWabaWebhook(wabaId: string, accessToken: string): Promise<boolean> {
  const result = await graphJson(`${graphUrl(`${wabaId}/subscribed_apps`)}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
  });
  return result.ok;
}

/**
 * Meta routes inbound messages to a phone-number-level alternate callback URL
 * before the WABA or app default. A number that was previously connected to
 * another provider can keep sending messages there, so (re)assert our own
 * endpoint and verify token every time we connect.
 */
export async function setPhoneWebhookOverride(phoneNumberId: string, accessToken: string): Promise<boolean> {
  if (!env.WHATSAPP_VERIFY_TOKEN) return false;
  const callbackUrl = `${env.APP_URL.replace(/\/$/, "")}/api/webhooks/whatsapp`;
  const result = await graphJson(`${graphUrl(phoneNumberId)}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhook_configuration: {
        override_callback_uri: callbackUrl,
        verify_token: env.WHATSAPP_VERIFY_TOKEN,
      },
    }),
  });
  return result.ok;
}

export async function clearPhoneWebhookOverride(phoneNumberId: string, accessToken: string): Promise<void> {
  await graphJson(`${graphUrl(phoneNumberId)}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_configuration: { override_callback_uri: "" } }),
  }).catch(() => undefined);
}

export async function registerPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await graphJson(`${graphUrl(`${phoneNumberId}/register`)}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export type CompleteSignupInput = {
  code: string;
  wabaId: string;
  phoneNumberId?: string | null;
  businessId?: string | null;
  state: string;
  event?: string | null;
};

export type CompleteSignupResult =
  | { ok: true; connection: WhatsAppConnection; notes: string[] }
  | { ok: false; error: string; code?: string };

/**
 * Finishes Embedded Signup: exchanges the code, verifies the token can reach the
 * chosen account, subscribes webhooks and stores the connection encrypted.
 * A connection is only reported as connected when Meta accepted it.
 */
export async function completeSignup(input: CompleteSignupInput): Promise<CompleteSignupResult> {
  const state = verifySignupState(input.state);
  if (!state.ok) return { ok: false, error: state.error, code: "invalid_state" };
  if (!input.code) return { ok: false, error: "Meta did not return an authorisation code.", code: "missing_code" };
  if (!input.wabaId) return { ok: false, error: "Meta did not return a WhatsApp Business Account ID.", code: "missing_waba" };

  const resolvedWabaId = input.wabaId;

  console.log("[whatsapp] completeSignup started", {
    event: input.event ?? "unknown",
    hasCode: Boolean(input.code),
    hasWabaId: Boolean(input.wabaId),
    hasPhoneId: Boolean(input.phoneNumberId),
    hasBusinessId: Boolean(input.businessId),
  });

  const isCoexistenceEvent = input.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
  const coexistence = state.coexistence || isCoexistenceEvent || !input.phoneNumberId;

  console.log("[whatsapp] coexistence mode:", coexistence, { stateCoexistence: state.coexistence, isCoexistenceEvent, hasPhoneId: Boolean(input.phoneNumberId) });
  const notes: string[] = [];

  const exchanged = await exchangeCodeForToken(input.code);
  if (!exchanged.ok) {
    console.error("[whatsapp] token exchange failed", { error: exchanged.error });
    return { ok: false, error: exchanged.error, code: "token_exchange_failed" };
  }
  console.log("[whatsapp] token exchanged successfully");

  const extended = await extendToken(exchanged.accessToken);
  const accessToken = extended.accessToken;

  if (!resolvedWabaId) {
    return { ok: false, error: "Meta did not return a WhatsApp Business Account.", code: "missing_waba" };
  }

  const profile = await fetchBusinessProfile(accessToken);
  let phoneInfo = null;
  let phoneNumberId = input.phoneNumberId ?? null;

  if (coexistence && !phoneNumberId) {
    const resolved = await resolveWabaPrimaryPhone(resolvedWabaId, accessToken);
    if (!resolved?.phoneNumberId) {
      return {
        ok: false,
        code: "phone_unreachable",
        error:
          "Meta did not grant access to a phone number on this account. Disconnect and reconnect, choosing your own WhatsApp Business number.",
      };
    }
    phoneNumberId = resolved.phoneNumberId;
    phoneInfo = resolved;
  } else if (phoneNumberId) {
    phoneInfo = await fetchPhoneNumberInfo(phoneNumberId, accessToken);
    if (!phoneInfo) {
      return {
        ok: false,
        code: "phone_unreachable",
        error:
          "Meta did not grant access to this phone number. Disconnect and reconnect, choosing your own WhatsApp Business number.",
      };
    }
  }

  if (!phoneNumberId) {
    return { ok: false, code: "missing_phone", error: "No WhatsApp phone number was returned by Meta." };
  }

  // WhatsApp delivers inbound events at the WABA level: subscribing the app to
  // the WABA covers every phone number under it. There is no phone-number-level
  // subscribed_apps edge in the Graph API, so attempting one always fails and
  // must not gate the connection.
  const wabaSubscribed = await subscribeWabaWebhook(resolvedWabaId, accessToken);
  const phoneWebhookReady = await setPhoneWebhookOverride(phoneNumberId, accessToken);
  console.log("[whatsapp] webhook subscription", { wabaSubscribed, phoneWebhookReady });
  if (!wabaSubscribed) {
    notes.push(
      "Inbound webhooks could not be subscribed. Messages will not arrive until the subscription succeeds — use “Test connection” to retry.",
    );
  }
  if (!phoneWebhookReady) {
    notes.push(
      "The phone-number webhook route could not be set to this app. Inbound messages may be delivered elsewhere until “Test connection” succeeds.",
    );
  }

  let pin: string | null = null;
  if (!coexistence) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    const registered = await registerPhoneNumber(phoneNumberId, accessToken, pin);
    if (!registered.ok) {
      // Already-registered numbers reject /register; that is not a send failure.
      notes.push(
        `Phone registration returned: ${registered.error ?? "unknown error"}. If the number already has a two-step PIN, keep using it.`,
      );
      pin = null;
    }
  }

  const tokenExpiresAt = new Date(Date.now() + extended.expiresIn * 1000);
  const businessName = profile.businessName ?? phoneInfo?.verifiedName ?? null;

  await saveIntegration({
    key: "WHATSAPP",
    status: wabaSubscribed && phoneWebhookReady ? "CONNECTED" : "NEEDS_ATTENTION",
    accountLabel: [businessName, phoneInfo?.phoneNumber].filter(Boolean).join(" · ") || null,
    lastError:
      wabaSubscribed && phoneWebhookReady
        ? null
        : !wabaSubscribed
          ? "Webhook subscription failed. Inbound messages will not arrive until it succeeds."
          : "The phone-number webhook route could not be set to this app. Inbound messages may be delivered elsewhere.",
    markSuccess: wabaSubscribed && phoneWebhookReady,
    secrets: {
      ACCESS_TOKEN: accessToken,
      WABA_ID: resolvedWabaId,
      PHONE_NUMBER_ID: phoneNumberId,
      REGISTER_PIN: pin ?? "",
    },
    config: {
      businessId: input.businessId ?? profile.businessId ?? null,
      businessName,
      phoneNumber: phoneInfo?.phoneNumber ?? null,
      coexistence,
      webhookStatus: wabaSubscribed && phoneWebhookReady ? "active" : "pending",
      tokenExpiresAt: tokenExpiresAt.toISOString(),
      signedUpAt: new Date().toISOString(),
      qualityRating: phoneInfo?.qualityRating ?? null,
      isOnBizApp: phoneInfo?.isOnBizApp ?? null,
      platformType: phoneInfo?.platformType ?? null,
      signupVersion: "v4",
    },
  });

  return { ok: true, connection: (await getWhatsAppConnection())!, notes };
}

/** Stored connection state. Never returns the access token. */
export async function getWhatsAppConnection(): Promise<WhatsAppConnection | null> {
  const integration = await getIntegration("WHATSAPP");
  if (!integration) return null;
  const config = parseJson<Record<string, unknown>>(integration.configJson, {});
  const { secrets, failed } = await readSecretsDetailed("WHATSAPP");
  const tokenExpired =
    typeof config.tokenExpiresAt === "string" && new Date(config.tokenExpiresAt).getTime() < Date.now();

  const hasCredentials = Boolean(secrets.ACCESS_TOKEN && secrets.PHONE_NUMBER_ID && secrets.WABA_ID);
  const connected =
    hasCredentials && !tokenExpired && failed.length === 0 && integration.status === "CONNECTED";

  return {
    connected,
    status: failed.length > 0 ? "NEEDS_ATTENTION" : tokenExpired ? "NEEDS_ATTENTION" : integration.status,
    phoneNumber: (config.phoneNumber as string | undefined) ?? null,
    phoneNumberId: secrets.PHONE_NUMBER_ID ?? null,
    wabaId: secrets.WABA_ID ?? null,
    businessId: (config.businessId as string | undefined) ?? null,
    businessName: (config.businessName as string | undefined) ?? null,
    coexistence: Boolean(config.coexistence),
    webhookStatus: (config.webhookStatus as string | undefined) ?? null,
    tokenExpiresAt: (config.tokenExpiresAt as string | undefined) ?? null,
    lastCheckedAt: integration.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: integration.lastSuccessAt?.toISOString() ?? null,
    lastError:
      failed.length > 0
        ? "Stored WhatsApp credentials could not be decrypted. Reconnect the account."
        : tokenExpired
          ? "The WhatsApp access token has expired. Reconnect the account."
          : integration.lastError,
    accountLabel: integration.accountLabel,
  };
}

/**
 * Routes an inbound WhatsApp delivery to its owning organization by the
 * receiving Phone Number ID. Each company's credentials are stored separately,
 * so a message can never be processed with another company's access token.
 * Returns null for a number that is not connected to any active tenant.
 */
export async function resolveWhatsAppOrganization(phoneNumberId: string): Promise<string | null> {
  if (!phoneNumberId) return null;
  const integrations = await rawDb.integration.findMany({
    where: { key: "WHATSAPP" },
    select: { organizationId: true, secretsJson: true },
  });
  for (const integration of integrations) {
    const secrets = parseJson<Record<string, string>>(integration.secretsJson, {});
    const stored = secrets.PHONE_NUMBER_ID ? tryDecryptSecret(secrets.PHONE_NUMBER_ID) : null;
    if (!stored?.ok || stored.value !== phoneNumberId) continue;
    const organization = await rawDb.organization.findUnique({
      where: { id: integration.organizationId },
      select: { status: true },
    });
    if (organization?.status === "ACTIVE") return integration.organizationId;
  }
  return null;
}

/** Runtime credentials for webhooks and sending. Null when the connection is unusable. */
export async function getWhatsAppCredentials(): Promise<{
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
} | null> {
  const { secrets, failed } = await readSecretsDetailed("WHATSAPP");
  if (failed.length > 0) return null;
  if (!secrets.ACCESS_TOKEN || !secrets.PHONE_NUMBER_ID || !secrets.WABA_ID) return null;
  return {
    accessToken: secrets.ACCESS_TOKEN,
    phoneNumberId: secrets.PHONE_NUMBER_ID,
    wabaId: secrets.WABA_ID,
  };
}

/**
 * Real provider request used by Settings. Never marks a connection as connected
 * because credentials merely exist.
 */
export async function testWhatsAppConnection(): Promise<{
  ok: boolean;
  detail: string;
  account?: string;
  needsAttention?: boolean;
}> {
  const credentials = await getWhatsAppCredentials();
  if (!credentials) {
    return { ok: false, detail: "WhatsApp is not connected. Use Connect WhatsApp to link the business account." };
  }

  const phone = await graphJson<{ display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
    `${graphUrl(credentials.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(credentials.accessToken)}`,
  );
  if (!phone.ok) {
    await saveIntegration({
      key: "WHATSAPP",
      status: "NEEDS_ATTENTION",
      lastError: phone.error,
    });
    return { ok: false, detail: phone.error, needsAttention: true };
  }

  const subscribed = await graphJson<{ data?: Array<{ whatsapp_business_api_data?: { id?: string } }> }>(
    `${graphUrl(`${credentials.wabaId}/subscribed_apps`)}?access_token=${encodeURIComponent(credentials.accessToken)}`,
  );

  const display = phone.data.display_phone_number ?? "the business number";
  const name = phone.data.verified_name ?? "WhatsApp Business";
  const quality = phone.data.quality_rating ? ` Quality: ${phone.data.quality_rating}.` : "";

  if (!subscribed.ok) {
    await saveIntegration({
      key: "WHATSAPP",
      status: "NEEDS_ATTENTION",
      accountLabel: `${name} · ${display}`,
      lastError: `Number reachable, but the webhook subscription check failed: ${subscribed.error}`,
    });
    return {
      ok: false,
      needsAttention: true,
      detail: `Reached ${name} (${display}) but could not verify the webhook subscription.${quality}`,
      account: display,
    };
  }

  const overrideReady = await setPhoneWebhookOverride(credentials.phoneNumberId, credentials.accessToken);
  if (!overrideReady) {
    await saveIntegration({
      key: "WHATSAPP",
      status: "NEEDS_ATTENTION",
      accountLabel: `${name} · ${display}`,
      lastError: "The phone-number webhook route could not be set to this app.",
    });
    return {
      ok: false,
      needsAttention: true,
      detail: `Reached ${name} (${display}) but could not set the phone-number webhook route.${quality}`,
      account: display,
    };
  }

  await saveIntegration({
    key: "WHATSAPP",
    status: "CONNECTED",
    accountLabel: `${name} · ${display}`,
    lastError: null,
    markSuccess: true,
    config: { phoneNumber: display, businessName: name, webhookStatus: "active", qualityRating: quality || null },
  });

  return {
    ok: true,
    detail: `Connected to ${name} (${display}); webhook subscription active.${quality}`,
    account: display,
  };
}

export async function disconnectWhatsApp(actor: string) {
  const credentials = await getWhatsAppCredentials();
  if (credentials) {
    // Best effort: stop Meta sending events for this account. Failure to
    // unsubscribe does not keep local credentials alive.
    await graphJson(`${graphUrl(`${credentials.wabaId}/subscribed_apps`)}?access_token=${encodeURIComponent(credentials.accessToken)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    await clearPhoneWebhookOverride(credentials.phoneNumberId, credentials.accessToken);
  }
  await clearIntegration("WHATSAPP");
  void actor;
}
