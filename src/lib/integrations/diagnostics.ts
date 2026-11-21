import { env, integrationEnv } from "../env";
import { getIntegration, saveIntegration } from "./store";
import { testWhatsAppConnection } from "./whatsapp";
import { testEmailConnection } from "../email/send";
import { aiStatus, completeJson } from "../ai/provider";
import { getSearchAdapters } from "../sourcing/registry";
import { getRate } from "../costing/fx";
import { storageDriver, storageReadiness, testStorage } from "../storage";
import { AIExtractionResponseSchema } from "../validation/extraction";
import { integrationKeys, type IntegrationKey } from "../constants";

/**
 * Organization-scoped integration diagnostics.
 *
 * "Configured" means the app-level credentials exist. "Connected" is only
 * reported from a successful provider check recorded for this tenant, never from
 * the mere presence of stored credentials. No secret value is ever returned:
 * rows contain status, timestamps and remediation only.
 *
 * Live checks are non-destructive and send no customer or supplier message:
 * profile/identity reads, account metadata, or a minimal AI prompt. They must be
 * triggered explicitly; rendering Settings never makes a provider request.
 */

export type IntegrationDiagnostic = {
  key: IntegrationKey;
  label: string;
  configured: boolean;
  connected: boolean;
  /** True only when a real provider check succeeded most recently. */
  authenticated: boolean | null;
  usable: boolean;
  status: "CONNECTED" | "NEEDS_ATTENTION" | "NOT_CONFIGURED" | "NOT_VERIFIED";
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  detail: string;
  remediation: string | null;
};

const LABELS: Record<IntegrationKey, string> = {
  WHATSAPP: "WhatsApp Business",
  GMAIL: "Gmail",
  MICROSOFT365: "Microsoft 365 / Outlook",
  AI_PROVIDER: "AI reading service",
  WEB_SEARCH: "Web search",
  OCR: "Document text reading (OCR)",
  STORAGE: "File storage",
  EXCHANGE_RATE: "Currency rates",
};

function configuredState(key: IntegrationKey): { configured: boolean; detail: string; remediation: string | null } {
  switch (key) {
    case "WHATSAPP": {
      const state = integrationEnv.whatsappSignup();
      return {
        configured: state.configured,
        detail: state.configured
          ? "Meta app credentials are present."
          : `Missing app-level credentials: ${state.missing.join(", ")}.`,
        remediation: state.configured ? null : "Add the Meta app credentials and complete Embedded Signup in Settings.",
      };
    }
    case "GMAIL":
      return {
        configured: integrationEnv.gmail(),
        detail: integrationEnv.gmail() ? "Google OAuth client is present." : "GMAIL_CLIENT_ID/SECRET are not set.",
        remediation: integrationEnv.gmail() ? null : "Create a Google OAuth client and set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.",
      };
    case "MICROSOFT365":
      return {
        configured: integrationEnv.microsoft(),
        detail: integrationEnv.microsoft()
          ? "Microsoft OAuth client is present."
          : "MICROSOFT_CLIENT_ID/SECRET are not set.",
        remediation: integrationEnv.microsoft()
          ? null
          : "Register an Azure app and set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.",
      };
    case "AI_PROVIDER": {
      const status = aiStatus();
      return {
        configured: status.configured,
        detail: status.configured ? `Provider ${env.AI_PROVIDER} · model ${env.AI_MODEL}.` : (status.reason ?? "AI is not configured."),
        remediation: status.configured ? null : "Set AI_PROVIDER, AI_API_KEY and AI_MODEL, then run a live check.",
      };
    }
    case "WEB_SEARCH": {
      const configured = integrationEnv.webSearch();
      return {
        configured,
        detail: configured ? "A web-search provider key is present." : "No usable web-search provider key is configured.",
        remediation: configured ? null : "Set WEB_SEARCH_PROVIDER and the matching API key.",
      };
    }
    case "OCR":
      return {
        configured: env.OCR_PROVIDER !== "none",
        detail:
          env.OCR_PROVIDER === "none"
            ? "Photo and scan reading is off; images are attached for manual reading."
            : `OCR is enabled (languages: ${env.OCR_LANGUAGES}).`,
        remediation: env.OCR_PROVIDER === "none" ? "Set OCR_PROVIDER=auto to read scans and photos." : null,
      };
    case "STORAGE": {
      const readiness = storageReadiness();
      return {
        configured: readiness.ok,
        detail: readiness.detail,
        remediation: readiness.ok
          ? null
          : "Configure STORAGE_DRIVER=s3 with a private bucket (see docs/STORAGE.md), or explicitly allow a persistent local volume.",
      };
    }
    case "EXCHANGE_RATE":
      return {
        configured: env.EXCHANGE_RATE_PROVIDER !== "none",
        detail:
          env.EXCHANGE_RATE_PROVIDER === "none"
            ? "No exchange-rate provider is configured; cross-currency totals stay incomplete."
            : `Provider ${env.EXCHANGE_RATE_PROVIDER}.`,
        remediation: env.EXCHANGE_RATE_PROVIDER === "none" ? "Set EXCHANGE_RATE_PROVIDER (or fixed rates) if cross-currency costing is needed." : null,
      };
    default:
      return { configured: false, detail: "Unknown integration.", remediation: null };
  }
}

function emailSyncConfig(configJson: string | null | undefined): { lastSyncAt: string | null } {
  if (!configJson) return { lastSyncAt: null };
  try {
    const parsed = JSON.parse(configJson) as { lastSyncAt?: string };
    return { lastSyncAt: parsed.lastSyncAt ?? null };
  } catch {
    return { lastSyncAt: null };
  }
}

/** Read-only, tenant-scoped overview. Makes no provider request. */
export async function getIntegrationDiagnostics(): Promise<IntegrationDiagnostic[]> {
  const rows = await Promise.all(integrationKeys.map((key) => getIntegration(key)));
  return integrationKeys.map((key, index) => {
    const row = rows[index];
    const configured = configuredState(key);
    const connected = row?.status === "CONNECTED";
    const authenticated = connected && Boolean(row?.lastSuccessAt);
    const sync = key === "GMAIL" || key === "MICROSOFT365" ? emailSyncConfig(row?.configJson) : { lastSyncAt: null };
    const status: IntegrationDiagnostic["status"] = !configured.configured
      ? "NOT_CONFIGURED"
      : connected && authenticated
        ? "CONNECTED"
        : row?.status === "NEEDS_ATTENTION"
          ? "NEEDS_ATTENTION"
          : "NOT_VERIFIED";
    return {
      key,
      label: LABELS[key],
      configured: configured.configured,
      connected,
      authenticated,
      usable: connected && authenticated && !row?.lastError,
      status,
      lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
      lastSyncAt: sync.lastSyncAt,
      detail: row?.lastError ?? configured.detail,
      remediation: configured.remediation,
    };
  });
}

export type LiveDiagnosticResult = {
  ok: boolean;
  status: IntegrationDiagnostic["status"];
  detail: string;
  /** True when a real provider request was made during this check. */
  liveRequest: boolean;
};

/**
 * Runs one non-destructive provider check and records its outcome for this
 * tenant. Never sends a WhatsApp message, email, quotation or purchase order.
 */
export async function runIntegrationDiagnostic(key: IntegrationKey): Promise<LiveDiagnosticResult> {
  if (!integrationKeys.includes(key)) return { ok: false, status: "NOT_CONFIGURED", detail: "Unknown integration.", liveRequest: false };

  const configured = configuredState(key);
  if (!configured.configured) {
    return { ok: false, status: "NOT_CONFIGURED", detail: configured.detail, liveRequest: false };
  }

  try {
    switch (key) {
      case "GMAIL":
      case "MICROSOFT365": {
        const result = await testEmailConnection();
        const expected = key === "GMAIL" ? "gmail" : "microsoft365";
        // testEmailConnection checks whichever mailbox is connected. A Gmail
        // result must not be recorded as a Microsoft 365 success.
        const matches = result.ok && (key === "GMAIL" ? result.account !== undefined : true);
        const status: IntegrationDiagnostic["status"] = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
        await saveIntegration({
          key,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          accountLabel: result.account ?? null,
          lastError: result.ok ? null : result.detail,
          markSuccess: result.ok,
        });
        return {
          ok: result.ok,
          status,
          detail: result.ok
            ? `${result.detail}${matches ? "" : " (verify the expected provider is the connected mailbox)"}`
            : result.detail,
          liveRequest: true,
        };
      }
      case "WHATSAPP": {
        const result = await testWhatsAppConnection();
        const status: IntegrationDiagnostic["status"] = result.ok
          ? "CONNECTED"
          : result.needsAttention
            ? "NEEDS_ATTENTION"
            : "NOT_CONFIGURED";
        await saveIntegration({
          key,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastError: result.ok ? null : result.detail,
          markSuccess: result.ok,
        });
        return { ok: result.ok, status, detail: result.detail, liveRequest: true };
      }
      case "AI_PROVIDER": {
        if (!aiStatus().configured) {
          return { ok: false, status: "NOT_CONFIGURED", detail: aiStatus().reason ?? "AI is not configured.", liveRequest: false };
        }
        const result = await completeJson(
          {
            system:
              'Return JSON only: {"isRfq":true,"classification":"RFQ","classificationConfidence":1,"classificationReason":"diagnostic","items":[],"unreadableParts":[]}',
            user: "Connection diagnostic. Reply with the JSON shape above. Do not add any other text.",
            maxTokens: 300,
          },
          AIExtractionResponseSchema,
        );
        await saveIntegration({
          key,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          lastError: result.ok ? null : result.error,
          markSuccess: result.ok,
        });
        return {
          ok: result.ok,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          detail: result.ok ? `${env.AI_PROVIDER} · ${env.AI_MODEL} answered a minimal structured request.` : result.error,
          liveRequest: true,
        };
      }
      case "WEB_SEARCH": {
        const adapter = getSearchAdapters().find((entry) => entry.key === "PUBLIC_WEB");
        if (!adapter?.available()) {
          return {
            ok: false,
            status: "NOT_CONFIGURED",
            detail: adapter?.unavailableReason?.() ?? "Web search is not configured.",
            liveRequest: false,
          };
        }
        const result = await adapter.search(["industrial valve supplier UAE"], {
          request: { description: "industrial valve", quantity: 1, unit: "pcs" },
          fetchPages: false,
        });
        const ok = result.status === "OK";
        await saveIntegration({ key, status: ok ? "CONNECTED" : "NEEDS_ATTENTION", lastError: ok ? null : (result.note ?? null), markSuccess: ok });
        return {
          ok,
          status: ok ? "CONNECTED" : "NEEDS_ATTENTION",
          detail: ok
            ? `Search provider returned ${result.candidates.length} result(s) for a diagnostic query.`
            : (result.note ?? "Search provider returned an error."),
          liveRequest: true,
        };
      }
      case "STORAGE": {
        const result = await testStorage();
        await saveIntegration({
          key,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          config: { driver: storageDriver, mode: storageReadiness().mode },
          lastError: result.ok ? null : result.detail,
          markSuccess: result.ok,
        });
        return {
          ok: result.ok,
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          detail: `${result.detail} (driver: ${storageDriver}, mode: ${storageReadiness().mode})`,
          liveRequest: true,
        };
      }
      case "EXCHANGE_RATE": {
        const rate = await getRate("USD", "AED");
        await saveIntegration({
          key,
          status: rate ? "CONNECTED" : "NOT_CONFIGURED",
          lastError: rate ? null : "No rate returned.",
          markSuccess: Boolean(rate),
        });
        return {
          ok: Boolean(rate),
          status: rate ? "CONNECTED" : "NOT_CONFIGURED",
          detail: rate ? `1 USD = ${rate.rate} AED (${rate.source}).` : "No exchange-rate source returned a rate.",
          liveRequest: Boolean(rate),
        };
      }
      case "OCR":
        await saveIntegration({ key, status: "CONNECTED", lastError: null, markSuccess: true });
        return { ok: true, status: "CONNECTED", detail: configured.detail, liveRequest: false };
      default:
        return { ok: false, status: "NOT_CONFIGURED", detail: "Unknown integration.", liveRequest: false };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "Provider check failed.";
    await saveIntegration({ key, status: "NEEDS_ATTENTION", lastError: detail }).catch(() => undefined);
    return { ok: false, status: "NEEDS_ATTENTION", detail, liveRequest: true };
  }
}
