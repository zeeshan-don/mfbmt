import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { runWithTenant } from "../src/lib/tenant";
import {
  claimOutbound,
  reconcileOutbound,
  recoverStaleOutboundClaims,
  sendOutboundOnce,
} from "../src/lib/outbound/messages";

const RUN = randomUUID().slice(0, 8);
const createdOrganizationIds: string[] = [];

afterAll(async () => {
  await rawDb.outboundMessage.deleteMany({ where: { operationKey: { contains: RUN } } });
  await rawDb.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
  await rawDb.$disconnect();
});

function message(key: string, extra: Record<string, unknown> = {}) {
  return {
    operationKey: `test:${RUN}:${key}`,
    kind: "SUPPLIER_RFQ",
    channel: "EMAIL",
    recipient: "supplier@example.com",
    subject: "Test",
    body: "Body",
    ...extra,
  };
}

describe("durable outbound messages (PostgreSQL)", () => {
  it("sends once when many workers race for the same message", async () => {
    let providerCalls = 0;
    const key = message("race");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        sendOutboundOnce(key, async () => {
          providerCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { outcome: "SENT", providerMessageId: "provider-1" };
        }),
      ),
    );

    expect(providerCalls).toBe(1);
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === "SENT")).toHaveLength(1);
    expect(statuses.every((status) => ["SENT", "IN_PROGRESS", "ALREADY_SENT"].includes(status))).toBe(true);

    let laterCalls = 0;
    const later = await sendOutboundOnce(key, async () => {
      laterCalls += 1;
      return { outcome: "SENT" };
    });
    expect(later.status).toBe("ALREADY_SENT");
    expect(laterCalls).toBe(0);
    const rows = await rawDb.outboundMessage.findMany({ where: { operationKey: key.operationKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
    expect(rows[0].providerMessageId).toBe("provider-1");
  });

  it("never retries automatically when the provider outcome is unknown", async () => {
    const key = message("unknown");
    let calls = 0;
    const first = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "UNKNOWN", error: "socket hang up" };
    });
    expect(first.status).toBe("UNCERTAIN");
    expect(calls).toBe(1);

    const second = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT" };
    });
    expect(second.status).toBe("UNCERTAIN");
    expect(calls).toBe(1);

    const row = await rawDb.outboundMessage.findFirst({ where: { operationKey: key.operationKey } });
    expect(row?.status).toBe("UNKNOWN");

    const reconciled = await reconcileOutbound({
      id: row!.id,
      resolution: "NOT_SENT",
      note: "Provider confirmed no message id",
      actorLabel: "owner@example.com",
    });
    expect(reconciled.ok).toBe(true);

    const third = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT", providerMessageId: "provider-2" };
    });
    expect(third.status).toBe("SENT");
    expect(calls).toBe(2);
  });

  it("sweeps a stale SENDING lease into UNKNOWN even when nobody retries it", async () => {
    const key = message("stale-sweep");
    const claim = await claimOutbound(key);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await rawDb.outboundMessage.update({
      where: { id: claim.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const swept = await recoverStaleOutboundClaims();
    expect(swept).toBeGreaterThanOrEqual(1);
    const row = await rawDb.outboundMessage.findUnique({ where: { id: claim.id } });
    expect(row?.status).toBe("UNKNOWN");
    expect(row?.lastError).toMatch(/worker stopped|reconcile/i);
  });

  it("turns a crashed SENDING lease into UNKNOWN and blocks the resend", async () => {
    const key = message("stale");
    const claim = await claimOutbound(key);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await rawDb.outboundMessage.update({
      where: { id: claim.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    let calls = 0;
    const result = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT" };
    });
    expect(result.status).toBe("UNCERTAIN");
    expect(calls).toBe(0);
  });

  it("retries only a known-safe failure, after its backoff", async () => {
    const key = message("safe");
    let calls = 0;
    const first = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "FAILED_SAFE", error: "recipient rejected before dispatch" };
    });
    expect(first.status).toBe("FAILED_SAFE");

    const blocked = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT" };
    });
    expect(blocked.status).toBe("FAILED_SAFE");
    expect(calls).toBe(1);

    const row = await rawDb.outboundMessage.findFirst({ where: { operationKey: key.operationKey } });
    await rawDb.outboundMessage.update({ where: { id: row!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

    const retried = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT", providerMessageId: "provider-3" };
    });
    expect(retried.status).toBe("SENT");
    expect(calls).toBe(2);
    expect((await rawDb.outboundMessage.findUnique({ where: { id: row!.id } }))?.attempts).toBe(2);
  });

  it("keeps the same operation key independent between tenants", async () => {
    const other = await rawDb.organization.create({
      data: {
        slug: `outbound-iso-${RUN}-${randomUUID().slice(0, 6)}`,
        name: "Outbound isolation tenant",
        status: "ACTIVE",
      },
    });
    createdOrganizationIds.push(other.id);

    const operationKey = `test:${RUN}:iso`;
    let calls = 0;
    const sender = async () => {
      calls += 1;
      return { outcome: "SENT" as const };
    };
    const own = await sendOutboundOnce(
      { ...message("iso"), operationKey },
      sender,
    );
    const foreign = await runWithTenant({ organizationId: other.id, source: "explicit" }, () =>
      sendOutboundOnce({ ...message("iso"), operationKey }, sender),
    );
    expect(own.status).toBe("SENT");
    expect(foreign.status).toBe("SENT");
    expect(calls).toBe(2);
    const rows = await rawDb.outboundMessage.findMany({ where: { operationKey } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.organizationId))).toEqual(new Set(["org_mfbmt", other.id]));
  });

  it("refuses to reconcile a live SENDING claim while a provider call may be in flight", async () => {
    const key = message("live-claim");
    const claim = await claimOutbound(key);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const rejected = await reconcileOutbound({
      id: claim.id,
      resolution: "NOT_SENT",
      note: "Operator tried to release a live claim",
      actorLabel: "owner@example.com",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/UNKNOWN|SENDING/i);
    const row = await rawDb.outboundMessage.findUnique({ where: { id: claim.id } });
    expect(row?.status).toBe("SENDING");
  });

  it("lets a human make an exhausted UNKNOWN message retryable", async () => {
    const key = message("exhausted-unknown", { maxAttempts: 1 });
    let calls = 0;
    const first = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "UNKNOWN", error: "gateway timeout" };
    });
    expect(first.status).toBe("UNCERTAIN");
    const row = await rawDb.outboundMessage.findFirst({ where: { operationKey: key.operationKey } });
    expect(row?.attempts).toBe(1);
    expect(row?.maxAttempts).toBe(1);

    const reconciled = await reconcileOutbound({
      id: row!.id,
      resolution: "NOT_SENT",
      note: "Provider log confirms no message id was issued",
      actorLabel: "owner@example.com",
    });
    expect(reconciled.ok).toBe(true);
    const reset = await rawDb.outboundMessage.findUnique({ where: { id: row!.id } });
    expect(reset?.status).toBe("PENDING");
    expect(reset?.attempts).toBe(0);

    const retried = await sendOutboundOnce(key, async () => {
      calls += 1;
      return { outcome: "SENT", providerMessageId: "provider-after-reconcile" };
    });
    expect(retried.status).toBe("SENT");
    expect(calls).toBe(2);
    const sent = await rawDb.outboundMessage.findUnique({ where: { id: row!.id } });
    expect(sent?.status).toBe("SENT");
    expect(sent?.providerMessageId).toBe("provider-after-reconcile");
  });

  it("does not invent a provider message id when the provider omits one", async () => {
    const key = message("no-provider-id");
    const result = await sendOutboundOnce(key, async () => ({ outcome: "SENT" }));
    expect(result.status).toBe("SENT");
    expect(result.providerMessageId ?? null).toBeNull();
    const row = await rawDb.outboundMessage.findFirst({ where: { operationKey: key.operationKey } });
    expect(row?.providerMessageId).toBeNull();
    expect(row?.status).toBe("SENT");
  });

  it("rejects reconciliation from another tenant and audits the successful decision", async () => {
    const other = await rawDb.organization.create({
      data: { slug: `outbound-reconcile-${RUN}-${randomUUID().slice(0, 6)}`, name: "Reconcile isolation tenant", status: "ACTIVE" },
    });
    createdOrganizationIds.push(other.id);

    const key = message("reconcile-tenant");
    await sendOutboundOnce(key, async () => ({ outcome: "UNKNOWN", error: "timeout" }));
    const row = await rawDb.outboundMessage.findFirst({ where: { operationKey: key.operationKey } });
    expect(row).not.toBeNull();

    const foreign = await runWithTenant({ organizationId: other.id, source: "explicit" }, () =>
      reconcileOutbound({ id: row!.id, resolution: "NOT_SENT", note: "foreign attempt", actorLabel: "foreign" }),
    );
    expect(foreign.ok).toBe(false);

    const own = await reconcileOutbound({
      id: row!.id,
      resolution: "NOT_SENT",
      note: "Provider dashboard shows no delivery",
      actorLabel: "owner@example.com",
    });
    expect(own.ok).toBe(true);
    const audit = await rawDb.auditLog.findFirst({
      where: { action: "outbound.reconciled_not_sent", entityId: row!.id, organizationId: "org_mfbmt" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metaJson).toContain("Provider dashboard");
  });
});
