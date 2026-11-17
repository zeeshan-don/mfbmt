import { db } from "../db";
import { encryptSecret, decryptSecret } from "../crypto";
import { parseJson, stringifyJson } from "../json";
import { integrationKeys, type IntegrationKey } from "../constants";

const NAMES: Record<IntegrationKey, string> = {
  WHATSAPP: "WhatsApp Business",
  GMAIL: "Gmail",
  MICROSOFT365: "Microsoft 365 / Outlook",
  AI_PROVIDER: "AI reading service",
  WEB_SEARCH: "Web search",
  OCR: "Document text reading",
  STORAGE: "File storage",
  EXCHANGE_RATE: "Currency rates",
};

export async function ensureIntegrations() {
  for (const key of integrationKeys) {
    await db.integration.upsert({
      where: { key },
      update: {},
      create: { key, name: NAMES[key], status: "NOT_CONFIGURED" },
    });
  }
}

export async function getIntegration(key: IntegrationKey) {
  return db.integration.findUnique({ where: { key } });
}

export async function readSecrets(key: IntegrationKey): Promise<Record<string, string>> {
  const integration = await getIntegration(key);
  if (!integration?.secretsJson) return {};
  const encrypted = parseJson<Record<string, string>>(integration.secretsJson, {});
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(encrypted)) {
    try {
      out[name] = decryptSecret(value);
    } catch {
      out[name] = "";
    }
  }
  return out;
}

export async function saveIntegration(input: {
  key: IntegrationKey;
  status?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  accountLabel?: string | null;
  lastError?: string | null;
}) {
  const encrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (value) encrypted[name] = encryptSecret(value);
  }
  const existing = await getIntegration(input.key);
  const existingSecrets = parseJson<Record<string, string>>(existing?.secretsJson ?? "{}", {});
  const mergedSecrets = { ...existingSecrets, ...encrypted };
  const mergedConfig = { ...parseJson<Record<string, unknown>>(existing?.configJson ?? "{}", {}), ...(input.config ?? {}) };

  await db.integration.upsert({
    where: { key: input.key },
    update: {
      status: input.status ?? existing?.status ?? "NOT_CONFIGURED",
      configJson: stringifyJson(mergedConfig),
      secretsJson: stringifyJson(mergedSecrets),
      accountLabel: input.accountLabel ?? existing?.accountLabel ?? null,
      lastError: input.lastError ?? null,
      lastCheckedAt: input.status ? new Date() : existing?.lastCheckedAt ?? null,
    },
    create: {
      key: input.key,
      name: NAMES[input.key],
      status: input.status ?? "NOT_CONFIGURED",
      configJson: stringifyJson(mergedConfig),
      secretsJson: stringifyJson(mergedSecrets),
      accountLabel: input.accountLabel ?? null,
      lastError: input.lastError ?? null,
      lastCheckedAt: input.status ? new Date() : null,
    },
  });
}
