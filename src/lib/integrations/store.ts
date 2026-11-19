import { db } from "../db";
import { encryptSecret, tryDecryptSecret } from "../crypto";
import { parseJson, stringifyJson } from "../json";
import { integrationKeys, type IntegrationKey } from "../constants";
import { requireTenantId } from "../tenant";

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
  const organizationId = await requireTenantId();
  for (const key of integrationKeys) {
    await db.integration.upsert({
      where: { organizationId_key: { organizationId, key } },
      update: {},
      create: { organizationId, key, name: NAMES[key], status: "NOT_CONFIGURED" },
    });
  }
}

export async function getIntegration(key: IntegrationKey) {
  return db.integration.findFirst({ where: { key } });
}

export type SecretsResult = {
  secrets: Record<string, string>;
  /** Names of stored values that exist but could not be decrypted. */
  failed: string[];
};

/**
 * Reads and decrypts stored secrets. A decryption failure is reported, never
 * converted into an empty string that would look like "not configured".
 */
export async function readSecretsDetailed(key: IntegrationKey): Promise<SecretsResult> {
  const integration = await getIntegration(key);
  if (!integration?.secretsJson) return { secrets: {}, failed: [] };
  const encrypted = parseJson<Record<string, string>>(integration.secretsJson, {});
  const secrets: Record<string, string> = {};
  const failed: string[] = [];
  for (const [name, value] of Object.entries(encrypted)) {
    if (!value) continue;
    const result = tryDecryptSecret(value);
    if (result.ok) secrets[name] = result.value;
    else failed.push(name);
  }
  return { secrets, failed };
}

export async function readSecrets(key: IntegrationKey): Promise<Record<string, string>> {
  return (await readSecretsDetailed(key)).secrets;
}

/**
 * Marks an integration "NEEDS_ATTENTION" when stored credentials cannot be
 * decrypted, so the UI never shows a green badge for unusable credentials.
 */
export async function assertSecretsUsable(key: IntegrationKey): Promise<SecretsResult> {
  const result = await readSecretsDetailed(key);
  if (result.failed.length > 0) {
    await saveIntegration({
      key,
      status: "NEEDS_ATTENTION",
      lastError:
        "Stored credentials could not be decrypted. The encryption key may have changed; reconnect this integration.",
    });
  }
  return result;
}

export async function saveIntegration(input: {
  key: IntegrationKey;
  status?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  accountLabel?: string | null;
  lastError?: string | null;
  markSuccess?: boolean;
  nextSyncAt?: Date | null;
}) {
  const encrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    // An empty string explicitly clears a stored secret.
    if (value) encrypted[name] = encryptSecret(value);
  }
  const existing = await getIntegration(input.key);
  const existingSecrets = parseJson<Record<string, string>>(existing?.secretsJson ?? "{}", {});
  const mergedSecrets = { ...existingSecrets };
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (value) mergedSecrets[name] = encrypted[name];
    else delete mergedSecrets[name];
  }
  const mergedConfig = {
    ...parseJson<Record<string, unknown>>(existing?.configJson ?? "{}", {}),
    ...(input.config ?? {}),
  };

  const now = new Date();
  const status = input.status ?? existing?.status ?? "NOT_CONFIGURED";
  const data = {
    status,
    configJson: stringifyJson(mergedConfig),
    secretsJson: stringifyJson(mergedSecrets),
    accountLabel: input.accountLabel === undefined ? (existing?.accountLabel ?? null) : input.accountLabel,
    lastError: input.lastError === undefined ? (existing?.lastError ?? null) : input.lastError,
    lastCheckedAt: input.status ? now : (existing?.lastCheckedAt ?? null),
    lastSuccessAt: input.markSuccess ? now : (existing?.lastSuccessAt ?? null),
    nextSyncAt: input.nextSyncAt === undefined ? (existing?.nextSyncAt ?? null) : input.nextSyncAt,
  };

  const organizationId = await requireTenantId();
  await db.integration.upsert({
    where: { organizationId_key: { organizationId, key: input.key } },
    update: data,
    create: { organizationId, key: input.key, name: NAMES[input.key], ...data },
  });
}

/** Removes all stored credentials for an integration and marks it disconnected. */
export async function clearIntegration(key: IntegrationKey, status = "DISCONNECTED") {
  const organizationId = await requireTenantId();
  await db.integration.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { secretsJson: "{}", status, accountLabel: null, lastError: null, nextSyncAt: null },
    create: { organizationId, key, name: NAMES[key], status, secretsJson: "{}" },
  });
}
