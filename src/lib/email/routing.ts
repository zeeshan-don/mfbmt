import { rawDb } from "../db-base";
import { parseJson } from "../json";

/**
 * Resolves the organization that owns a provider notification.
 *
 * Gmail push notifications carry the mailbox address, which is stored on the
 * owning integration. Graph notifications carry a per-organization clientState
 * (see email/sync.ts). If a provider cannot identify the mailbox, routing falls
 * back only when exactly one company has that provider connected; it never
 * guesses between companies.
 */
export async function resolveEmailOrganization(
  provider: "GMAIL" | "MICROSOFT365",
  accountEmail?: string | null,
): Promise<string | null> {
  const integrations = await rawDb.integration.findMany({
    where: { key: provider, status: "CONNECTED" },
    select: { organizationId: true, configJson: true },
  });

  if (accountEmail) {
    const normalised = accountEmail.trim().toLowerCase();
    for (const integration of integrations) {
      const config = parseJson<{ accountEmail?: string }>(integration.configJson, {});
      if (config.accountEmail && config.accountEmail.toLowerCase() === normalised) {
        return integration.organizationId;
      }
    }
  }

  const unique = new Set(integrations.map((integration) => integration.organizationId));
  return unique.size === 1 ? [...unique][0] : null;
}

/** Per-organization, signed Graph clientState. The secret is verified by the webhook. */
export function graphClientState(organizationId: string, secret: string): string {
  return `org:${organizationId}:${secret}`;
}

export function parseGraphClientState(value: string): { organizationId: string; secret: string } | null {
  if (!value.startsWith("org:")) return null;
  const rest = value.slice(4);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return { organizationId: rest.slice(0, separator), secret: rest.slice(separator + 1) };
}
