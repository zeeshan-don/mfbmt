import { randomUUID } from "node:crypto";
import { rawDb } from "../db-base";
import { requireTenantId } from "../tenant";
import { stringifyJson } from "../json";

/**
 * Durable outbound-message ledger.
 *
 * The critical guarantee is not "exactly once" — no email or WhatsApp provider
 * offers that. The guarantee is: a message is claimed atomically before the
 * provider call, and a message whose provider outcome is uncertain is NEVER
 * automatically retried. It must be reconciled by a human/operator.
 *
 * States:
 *   PENDING      created, never attempted
 *   SENDING      claimed by one worker with a lease; a provider call may be in flight
 *   SENT         provider accepted it (provider id recorded when available)
 *   FAILED_SAFE  the provider was definitely not asked, or definitely rejected it
 *   UNKNOWN      the provider may have accepted it; automatic retry is forbidden
 *   CANCELLED    operator cancelled before any send
 */

export const OUTBOUND_STATUS = {
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED_SAFE: "FAILED_SAFE",
  UNKNOWN: "UNKNOWN",
  CANCELLED: "CANCELLED",
} as const;

export type OutboundStatus = (typeof OUTBOUND_STATUS)[keyof typeof OUTBOUND_STATUS];

export type ProviderOutcome =
  | {
      outcome: "SENT";
      providerMessageId?: string | null;
      providerThreadId?: string | null;
      simulated?: boolean;
      detail?: string;
    }
  | { outcome: "FAILED_SAFE"; error: string }
  | { outcome: "UNKNOWN"; error: string };

export type OutboundSendResult = {
  status: "SENT" | "ALREADY_SENT" | "IN_PROGRESS" | "UNCERTAIN" | "EXHAUSTED" | "FAILED_SAFE" | "CANCELLED";
  detail: string;
  messageId?: string;
  providerMessageId?: string | null;
  providerThreadId?: string | null;
  simulated?: boolean;
};

export type NewOutboundMessage = {
  operationKey: string;
  kind: string;
  channel: string;
  recipient: string;
  subject?: string | null;
  body: string;
  relatedType?: string | null;
  relatedId?: string | null;
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
};

const DEFAULT_LEASE_MS = 90_000;

function leaseMs(): number {
  const configured = Number(process.env.OUTBOUND_LEASE_MS ?? "");
  return Number.isFinite(configured) && configured >= 15_000 ? configured : DEFAULT_LEASE_MS;
}

export function outboundOperationKey(parts: Array<string | number>): string {
  return parts
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(":")
    .slice(0, 240);
}

type OutboundRow = {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  providerMessageId: string | null;
  lastError: string | null;
};

async function ensureRow(input: NewOutboundMessage, organizationId: string): Promise<void> {
  await rawDb.$executeRaw`
    INSERT INTO "OutboundMessage"
      ("id", "organizationId", "operationKey", "kind", "channel", "recipient", "subject", "body",
       "status", "attempts", "maxAttempts", "metadataJson", "relatedType", "relatedId", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${organizationId}, ${input.operationKey}, ${input.kind}, ${input.channel},
       ${input.recipient}, ${input.subject ?? null}, ${input.body}, 'PENDING', 0,
       ${Math.max(1, input.maxAttempts ?? 4)}, ${stringifyJson(input.metadata ?? {})},
       ${input.relatedType ?? null}, ${input.relatedId ?? null}, now(), now())
    ON CONFLICT ("organizationId", "operationKey") DO NOTHING
  `;
}

async function readRow(organizationId: string, operationKey: string): Promise<OutboundRow | null> {
  const rows = await rawDb.$queryRaw<OutboundRow[]>`
    SELECT id, status, attempts, "maxAttempts", "claimToken", "leaseExpiresAt", "providerMessageId", "lastError"
      FROM "OutboundMessage"
     WHERE "organizationId" = ${organizationId} AND "operationKey" = ${operationKey}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Claims the right to send one outbound message. This is the only function that
 * may authorise a provider call. It is safe across workers and serverless
 * instances because the claim is a single conditional UPDATE.
 */
export async function claimOutbound(input: NewOutboundMessage): Promise<
  | { ok: true; id: string; claimToken: string; organizationId: string; attempt: number }
  | { ok: false; result: OutboundSendResult }
> {
  const organizationId = await requireTenantId();
  await ensureRow(input, organizationId);

  // Any SENDING row whose lease expired has an unknowable provider outcome.
  // Move it to UNKNOWN before deciding whether a send is allowed.
  await rawDb.$executeRaw`
    UPDATE "OutboundMessage"
       SET status = 'UNKNOWN',
           "lastError" = COALESCE("lastError", 'The sending worker stopped before recording the provider outcome. Reconcile before resending.'),
           "claimToken" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = now()
     WHERE "organizationId" = ${organizationId}
       AND "operationKey" = ${input.operationKey}
       AND status = 'SENDING'
       AND "leaseExpiresAt" IS NOT NULL
       AND "leaseExpiresAt" < now()
  `;

  const claimToken = randomUUID();
  const leaseSeconds = Math.round(leaseMs() / 1000);
  const claimed = await rawDb.$queryRaw<Array<{ id: string; attempts: number }>>`
    UPDATE "OutboundMessage"
       SET status = 'SENDING',
           "claimToken" = ${claimToken},
           "claimedAt" = now(),
           "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds}),
           attempts = attempts + 1,
           "lastError" = NULL,
           "updatedAt" = now()
     WHERE "organizationId" = ${organizationId}
       AND "operationKey" = ${input.operationKey}
       AND status IN ('PENDING', 'FAILED_SAFE')
       AND attempts < "maxAttempts"
       AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
     RETURNING id, attempts
  `;
  const row = claimed[0];
  if (row) {
    return { ok: true, id: row.id, claimToken, organizationId, attempt: row.attempts };
  }

  const existing = await readRow(organizationId, input.operationKey);
  if (!existing) {
    return {
      ok: false,
      result: { status: "FAILED_SAFE", detail: "The outbound message record could not be claimed." },
    };
  }
  switch (existing.status) {
    case "SENT":
      return {
        ok: false,
        result: {
          status: "ALREADY_SENT",
          detail: "This message was already accepted by the provider; it was not sent again.",
          providerMessageId: existing.providerMessageId,
        },
      };
    case "SENDING":
      return {
        ok: false,
        result: {
          status: "IN_PROGRESS",
          detail: "Another worker is currently sending this message. It was not sent again.",
        },
      };
    case "UNKNOWN":
      return {
        ok: false,
        result: {
          status: "UNCERTAIN",
          detail:
            "A previous attempt has an unknown provider outcome. It will not be retried automatically; reconcile it before resending.",
        },
      };
    case "CANCELLED":
      return { ok: false, result: { status: "CANCELLED", detail: "This message was cancelled." } };
    case "FAILED_SAFE":
      return {
        ok: false,
        result: {
          status: existing.attempts >= existing.maxAttempts ? "EXHAUSTED" : "FAILED_SAFE",
          detail:
            existing.attempts >= existing.maxAttempts
              ? "The retry limit for this message has been reached."
              : (existing.lastError ?? "The previous attempt failed before delivery."),
        },
      };
    default:
      return { ok: false, result: { status: "FAILED_SAFE", detail: "The message could not be claimed." } };
  }
}

/** Records that the provider accepted the message. Conditional on the claim. */
export async function markOutboundSent(input: {
  organizationId: string;
  id: string;
  claimToken: string;
  providerMessageId?: string | null;
  providerThreadId?: string | null;
  detail?: string | null;
}): Promise<boolean> {
  const rows = await rawDb.$queryRaw<Array<{ id: string }>>`
    UPDATE "OutboundMessage"
       SET status = 'SENT',
           "providerMessageId" = ${input.providerMessageId ?? null},
           "providerThreadId" = ${input.providerThreadId ?? null},
           "sentAt" = now(),
           "claimToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastError" = NULL,
           "updatedAt" = now()
     WHERE id = ${input.id}
       AND "organizationId" = ${input.organizationId}
       AND status = 'SENDING'
       AND "claimToken" = ${input.claimToken}
     RETURNING id
  `;
  return rows.length > 0;
}

/** Records a failure where the provider definitely did not accept the message. */
export async function markOutboundSafeFailure(input: {
  organizationId: string;
  id: string;
  claimToken: string;
  error: string;
}): Promise<"retry" | "exhausted" | "lost"> {
  const backoffSeconds = 30;
  const rows = await rawDb.$queryRaw<Array<{ status: string }>>`
    UPDATE "OutboundMessage"
       SET status = 'FAILED_SAFE',
           "lastError" = ${input.error.slice(0, 900)},
           "claimToken" = NULL,
           "claimedAt" = NULL,
           "leaseExpiresAt" = NULL,
           "nextAttemptAt" = now() + make_interval(secs => ${backoffSeconds}),
           "updatedAt" = now()
     WHERE id = ${input.id}
       AND "organizationId" = ${input.organizationId}
       AND status = 'SENDING'
       AND "claimToken" = ${input.claimToken}
     RETURNING status
  `;
  if (rows.length === 0) return "lost";
  const row = await rawDb.outboundMessage.findUnique({ where: { id: input.id } });
  if (!row) return "lost";
  return row.attempts >= row.maxAttempts ? "exhausted" : "retry";
}

/** Records an uncertain outcome. Automatic retries are forbidden afterwards. */
export async function markOutboundUncertain(input: {
  organizationId: string;
  id: string;
  claimToken: string;
  error: string;
}): Promise<boolean> {
  const rows = await rawDb.$queryRaw<Array<{ id: string }>>`
    UPDATE "OutboundMessage"
       SET status = 'UNKNOWN',
           "lastError" = ${input.error.slice(0, 900)},
           "claimToken" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = now()
     WHERE id = ${input.id}
       AND "organizationId" = ${input.organizationId}
       AND status = 'SENDING'
       AND "claimToken" = ${input.claimToken}
     RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Operator reconciliation of an UNKNOWN message. "SENT" records the provider
 * evidence; "NOT_SENT" makes the message safely retryable.
 */
export async function reconcileOutbound(input: {
  id: string;
  resolution: "SENT" | "NOT_SENT";
  providerMessageId?: string | null;
  note?: string | null;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const organizationId = await requireTenantId();
  const row = await rawDb.outboundMessage.findFirst({ where: { id: input.id, organizationId } });
  if (!row) return { ok: false, error: "Outbound message not found in this organization." };
  // A live SENDING claim may still have a provider request in flight. Letting a
  // human mark it NOT_SENT here would allow a second worker to transmit while
  // the first call is still running. Only an UNKNOWN (lease already expired or
  // provider explicitly uncertain) row is safe to reconcile.
  if (row.status !== "UNKNOWN") {
    return {
      ok: false,
      error: `Only an UNKNOWN message can be reconciled (current state: ${row.status}). Wait for the lease to expire or for the worker to record the outcome.`,
    };
  }
  const updated = await rawDb.$executeRaw`
    UPDATE "OutboundMessage"
       SET status = ${input.resolution === "SENT" ? "SENT" : "PENDING"},
           "providerMessageId" = ${input.resolution === "SENT" ? (input.providerMessageId ?? row.providerMessageId) : row.providerMessageId},
           "sentAt" = ${input.resolution === "SENT" ? new Date() : null},
           "reconciledAt" = now(),
           "claimToken" = NULL,
           "leaseExpiresAt" = NULL,
           "nextAttemptAt" = NULL,
           -- A human has confirmed the provider did not accept the message. Reset
           -- the automatic attempt counter so an exhausted message is actually
           -- retryable; the reconciliation itself remains audited.
           attempts = ${input.resolution === "SENT" ? row.attempts : 0},
           "lastError" = ${input.note ?? null},
           "updatedAt" = now()
     WHERE id = ${input.id}
       AND "organizationId" = ${organizationId}
       AND status = 'UNKNOWN'
  `;
  if (Number(updated) === 0) return { ok: false, error: "The message changed while it was being reconciled." };
  await rawDb.auditLog.create({
    data: {
      organizationId,
      actorLabel: input.actorLabel,
      action: `outbound.reconciled_${input.resolution.toLowerCase()}`,
      entityType: "OutboundMessage",
      entityId: input.id,
      metaJson: stringifyJson({ note: input.note ?? null, operationKey: row.operationKey }),
    },
  });
  return { ok: true };
}

/** Converts expired claims into UNKNOWN. Run by the worker/ops watchdog. */
export async function recoverStaleOutboundClaims(): Promise<number> {
  const affected = await rawDb.$executeRaw`
    UPDATE "OutboundMessage"
       SET status = 'UNKNOWN',
           "lastError" = COALESCE("lastError", 'The sending worker stopped before recording the provider outcome. Reconcile before resending.'),
           "claimToken" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = now()
     WHERE status = 'SENDING'
       AND "leaseExpiresAt" IS NOT NULL
       AND "leaseExpiresAt" < now()
  `;
  return Number(affected);
}

/**
 * The single send path used by email and WhatsApp integrations. The provider
 * function is only invoked after a successful claim.
 */
export async function sendOutboundOnce(
  input: NewOutboundMessage,
  deliver: (claimed: { id: string; attempt: number }) => Promise<ProviderOutcome>,
): Promise<OutboundSendResult> {
  const claim = await claimOutbound(input);
  if (!claim.ok) return claim.result;

  let outcome: ProviderOutcome;
  try {
    outcome = await deliver({ id: claim.id, attempt: claim.attempt });
  } catch (error) {
    // An exception after the request was initiated is conservatively uncertain.
    outcome = {
      outcome: "UNKNOWN",
      error: error instanceof Error ? error.message : "The provider outcome is unknown.",
    };
  }

  if (outcome.outcome === "SENT") {
    const recorded = await markOutboundSent({
      organizationId: claim.organizationId,
      id: claim.id,
      claimToken: claim.claimToken,
      providerMessageId: outcome.providerMessageId ?? null,
      providerThreadId: outcome.providerThreadId ?? null,
      detail: outcome.detail ?? null,
    });
    if (!recorded) {
      return {
        status: "UNCERTAIN",
        detail:
          "The provider accepted the message, but this worker no longer owned the claim. Reconcile the record before any resend.",
        providerMessageId: outcome.providerMessageId ?? null,
      };
    }
    return {
      status: "SENT",
      detail: outcome.detail ?? "Message accepted by the provider.",
      messageId: claim.id,
      providerMessageId: outcome.providerMessageId ?? null,
      providerThreadId: outcome.providerThreadId ?? null,
      simulated: outcome.simulated,
    };
  }

  if (outcome.outcome === "UNKNOWN") {
    await markOutboundUncertain({
      organizationId: claim.organizationId,
      id: claim.id,
      claimToken: claim.claimToken,
      error: outcome.error,
    });
    return {
      status: "UNCERTAIN",
      detail:
        `The provider outcome is unknown (${outcome.error}). The message will not be retried automatically; reconcile it before resending.`,
      messageId: claim.id,
    };
  }

  const state = await markOutboundSafeFailure({
    organizationId: claim.organizationId,
    id: claim.id,
    claimToken: claim.claimToken,
    error: outcome.error,
  });
  return {
    status: state === "exhausted" ? "EXHAUSTED" : "FAILED_SAFE",
    detail: outcome.error,
    messageId: claim.id,
  };
}

/** Tenant-scoped list for the operations screen. */
export async function recentOutboundMessages(limit = 50) {
  const organizationId = await requireTenantId();
  return rawDb.outboundMessage.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: Math.min(200, Math.max(1, limit)),
  });
}

/** Count of messages that need human reconciliation or attention. */
export async function outboundAttentionCount(): Promise<number> {
  const organizationId = await requireTenantId();
  return rawDb.outboundMessage.count({
    where: { organizationId, status: { in: ["UNKNOWN", "FAILED_SAFE"] } },
  });
}
