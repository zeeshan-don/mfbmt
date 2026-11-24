import { rawDb } from "../db-base";
import { parseJson } from "../json";
import { timingSafeEqual } from "../crypto";

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
    where: { key: provider, status: { in: ["CONNECTED", "CONNECTING"] } },
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

export type GraphNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  lifecycleEvent?: string;
};

/**
 * Validates and groups one webhook batch by verified organisation.
 *
 * A single Graph delivery may contain notifications for several subscriptions
 * belonging to different MFBMT companies. Every entry must carry a valid
 * per-tenant clientState; an invalid entry rejects the whole batch rather than
 * being routed somewhere else. The legacy global clientState is accepted only
 * when exactly one company has Outlook connected.
 */
export async function groupGraphNotifications(
  notifications: GraphNotification[],
  secret: string,
): Promise<
  | { ok: true; groups: Array<{ organizationId: string; notifications: GraphNotification[] }> }
  | { ok: false; status: number; error: string }
> {
  if (!secret) return { ok: false, status: 503, error: "Microsoft Graph push is not configured." };
  if (notifications.length === 0) return { ok: true, groups: [] };

  const groups = new Map<string, GraphNotification[]>();
  let legacyOrganization: string | null | undefined;

  for (const notification of notifications) {
    const parsed = notification.clientState ? parseGraphClientState(notification.clientState) : null;
    let organizationId: string;

    if (parsed) {
      if (!timingSafeEqual(parsed.secret, secret)) {
        return { ok: false, status: 401, error: "Invalid client state." };
      }
      organizationId = parsed.organizationId;
    } else {
      // Legacy subscription created before per-tenant state existed.
      if (!notification.clientState || !timingSafeEqual(notification.clientState, secret)) {
        return { ok: false, status: 401, error: "Invalid client state." };
      }
      if (legacyOrganization === undefined) {
        legacyOrganization = await resolveEmailOrganization("MICROSOFT365", null);
      }
      if (!legacyOrganization) {
        return { ok: false, status: 422, error: "Notification cannot be routed to a company." };
      }
      organizationId = legacyOrganization;
    }

    const list = groups.get(organizationId) ?? [];
    list.push(notification);
    groups.set(organizationId, list);
  }

  return {
    ok: true,
    groups: [...groups.entries()].map(([organizationId, entries]) => ({
      organizationId,
      notifications: entries,
    })),
  };
}
