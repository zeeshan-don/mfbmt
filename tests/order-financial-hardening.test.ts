import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { recordSupplierAcknowledgement, reviewSupplierAcknowledgement } from "../src/lib/orders/purchaseOrders";
import { orderMetrics } from "../src/lib/orders/metrics";
import { dealClosureSummary } from "../src/lib/orders/closure";
import { dec } from "../src/lib/orders/money";

// The external email boundary is mocked; the outbound ledger, locks, decimal
// arithmetic and version table are the real implementation.
vi.mock("../src/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, simulated: true })),
}));

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { email: `hardening-${suffix}@example.com`, name: "Hardening Owner", passwordHash: "not-used", role: "OWNER" },
  });
  const customer = await db.customer.create({ data: { name: `Hardening Customer ${suffix}` } });
  const supplier = await db.supplier.create({
    data: { name: `Hardening Supplier ${suffix}`, email: `supplier-${suffix}@example.com`, status: "ACTIVE", identityStatus: "VERIFIED" },
  });
  const enquiry = await db.enquiry.create({
    data: { publicRef: `HARD-${suffix}`, channel: "MANUAL", customerId: customer.id, customerName: customer.name, rawText: "three line order", currency: "AED" },
  });
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      quoteNumber: `HARD-QT-${suffix}`,
      customerName: customer.name,
      currency: "AED",
      status: "SENT",
      sentAt: new Date(),
      subtotal: 3000,
      total: 3000,
      items: {
        create: [1, 2, 3].map((lineNo) => ({
          description: `Line ${lineNo} item`,
          quantity: 10,
          unit: "pcs",
          unitPrice: 100,
          lineTotal: 1000,
        })),
      },
    },
  });
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `HARD-SO-${suffix}`,
      idempotencyKey: `hard-order-${suffix}`,
      quotationId: quotation.id,
      quotationVersion: 1,
      customerId: customer.id,
      customerName: customer.name,
      currency: "AED",
      subtotal: 3000,
      total: 3000,
      lines: {
        create: [1, 2, 3].map((lineNo) => ({
          lineNo,
          description: `Line ${lineNo} item`,
          quantity: 10,
          unit: "pcs",
          unitPrice: 100,
          lineTotal: 1000,
          stockQuantity: 0,
          procureQuantity: 10,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `HARD-PO-${suffix}`,
      idempotencyKey: `hard-po-${suffix}`,
      status: "SENT",
      version: 1,
      salesOrderId: order.id,
      supplierId: supplier.id,
      currency: "AED",
      subtotal: 3000,
      taxAmount: 0,
      total: 3000,
      sentAt: new Date(),
      lines: {
        create: order.lines.map((line) => ({
          salesOrderLineId: line.id,
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          taxRatePct: 0,
          taxAmount: 0,
          lineTotal: line.lineTotal,
        })),
      },
    },
  });
  const poWithLines = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  return { suffix, owner, customer, supplier, enquiry, quotation, order, po: poWithLines };
}

async function approveRevision(
  fixture: Fixture,
  input: {
    outcome: "ACKNOWLEDGED" | "PARTIALLY_ACKNOWLEDGED" | "REJECTED" | "REVISED";
    lines?: Array<{ purchaseOrderLineId: string; acknowledgedQuantity?: number | null; revisedUnitPrice?: number | null }>;
  },
) {
  const ack = await recordSupplierAcknowledgement({
    purchaseOrderId: fixture.po.id,
    outcome: input.outcome,
    lines: input.lines,
    notes: "Supplier reply captured for the regression test.",
    userId: fixture.owner.id,
    actorLabel: fixture.owner.name,
  });
  if (!ack.ok) throw new Error(ack.error);
  const reviewed = await reviewSupplierAcknowledgement({
    acknowledgementId: ack.acknowledgementId,
    decision: "APPROVE",
    note: "Owner accepted the supplier's confirmed terms.",
    userId: fixture.owner.id,
    actorLabel: fixture.owner.name,
  });
  return { ack, reviewed };
}

afterAll(async () => {
  await db.purchaseOrderVersion.deleteMany();
  await db.supplierAcknowledgement.deleteMany();
  await db.purchaseOrderLine.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.salesOrderLine.deleteMany();
  await db.salesOrder.deleteMany();
  await db.orderStatusEvent.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.supplier.deleteMany();
  await db.customer.deleteMany();
  await db.enquiry.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.user.deleteMany();
});

describe("supplier PO revision totals", () => {
  it("keeps every unchanged line when one of three prices is revised", async () => {
    const fixture = await seed();
    const { reviewed } = await approveRevision(fixture, {
      outcome: "REVISED",
      lines: [{ purchaseOrderLineId: fixture.po.lines[1].id, revisedUnitPrice: 120 }],
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.version).toBe(2);

    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id }, include: { lines: true } });
    expect(po.subtotal.toFixed(2)).toBe("3200.00");
    expect(po.taxAmount.toFixed(2)).toBe("0.00");
    expect(po.total.toFixed(2)).toBe("3200.00");
    expect(po.lines.map((line) => line.unitPrice.toFixed(2))).toEqual(["100.00", "120.00", "100.00"]);

    const versions = await db.purchaseOrderVersion.findMany({ where: { purchaseOrderId: po.id }, orderBy: { version: "asc" } });
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0].snapshotJson).toContain('"total":"3000.0000"');
    expect(versions[1].snapshotJson).toContain('"total":"3200.0000"');
    expect(versions[1].changeSummaryJson).toContain("unitPrice");
  });

  it("rebuilds the total from all lines when two prices are revised", async () => {
    const fixture = await seed();
    await approveRevision(fixture, {
      outcome: "REVISED",
      lines: [
        { purchaseOrderLineId: fixture.po.lines[0].id, revisedUnitPrice: 120 },
        { purchaseOrderLineId: fixture.po.lines[2].id, revisedUnitPrice: 90 },
      ],
    });
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id }, include: { lines: true } });
    expect(po.subtotal.toFixed(2)).toBe("3100.00");
    expect(po.total.toFixed(2)).toBe("3100.00");
    expect(po.lines.map((line) => line.lineTotal.toFixed(2))).toEqual(["1200.00", "1000.00", "900.00"]);
  });

  it("applies a revised price that arrives with a partial acknowledgement", async () => {
    const fixture = await seed();
    await approveRevision(fixture, {
      outcome: "PARTIALLY_ACKNOWLEDGED",
      lines: [
        { purchaseOrderLineId: fixture.po.lines[0].id, acknowledgedQuantity: 4, revisedUnitPrice: 110 },
        { purchaseOrderLineId: fixture.po.lines[1].id, acknowledgedQuantity: 6 },
      ],
    });
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    expect(po.status).toBe("PARTIALLY_ACKNOWLEDGED");
    expect(po.lines.map((line) => line.acknowledgedQuantity?.toFixed(4))).toEqual(["4.0000", "6.0000", "0.0000"]);
    // Financial total covers all ordered quantities; the price change applies.
    expect(po.total.toFixed(2)).toBe("3100.00");
    expect(po.lines.map((line) => line.unitPrice.toFixed(2))).toEqual(["110.00", "100.00", "100.00"]);

    const metrics = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(metrics.lines.map((line) => line.openSupplierCommitment.toFixed(4))).toEqual(["4.0000", "6.0000", "0.0000"]);
    expect(metrics.openSupplierQty.toFixed(4)).toBe("10.0000");
    // 30 procure - 10 confirmed = 20 still to source (line 3 was not confirmed).
    expect(metrics.remainingToProcureQty.toFixed(4)).toBe("20.0000");
  });

  it("does not create another revision when the same acknowledgement is replayed", async () => {
    const fixture = await seed();
    const { ack } = await approveRevision(fixture, {
      outcome: "REVISED",
      lines: [{ purchaseOrderLineId: fixture.po.lines[0].id, revisedUnitPrice: 120 }],
    });
    const replay = await reviewSupplierAcknowledgement({
      acknowledgementId: ack.acknowledgementId,
      decision: "APPROVE",
      note: "Replayed click.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(replay.ok).toBe(false);
    expect(await db.purchaseOrderVersion.count({ where: { purchaseOrderId: fixture.po.id } })).toBe(2);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id } })).version).toBe(2);
  });

  it("preserves the earlier version when a second revision is approved", async () => {
    const fixture = await seed();
    await approveRevision(fixture, {
      outcome: "REVISED",
      lines: [{ purchaseOrderLineId: fixture.po.lines[0].id, revisedUnitPrice: 120 }],
    });
    await approveRevision(fixture, {
      outcome: "REVISED",
      lines: [{ purchaseOrderLineId: fixture.po.lines[2].id, revisedUnitPrice: 130 }],
    });
    const versions = await db.purchaseOrderVersion.findMany({ where: { purchaseOrderId: fixture.po.id }, orderBy: { version: "asc" } });
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(versions[1].snapshotJson).toContain('"total":"3200.0000"');
    expect(versions[2].snapshotJson).toContain('"total":"3500.0000"');
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id } })).total.toFixed(2)).toBe("3500.00");
  });
});

describe("procurement coverage after rejection and partial commitments", () => {
  it("releases the full remaining quantity when the supplier rejects the PO", async () => {
    const fixture = await seed();
    await approveRevision(fixture, { outcome: "REJECTED" });
    const metrics = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(metrics.openSupplierQty.toFixed(4)).toBe("0.0000");
    expect(metrics.remainingToProcureQty.toFixed(4)).toBe("30.0000");
    expect(metrics.lines.every((line) => line.receivedAccepted.eq(0))).toBe(true);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.po.id } })).status).toBe("REJECTED");
  });

  it("keeps accepted goods after the PO is cancelled and releases only the remainder", async () => {
    const fixture = await seed();
    await db.goodsReceipt.create({
      data: {
        receiptNumber: `HARD-GR-${fixture.suffix}`,
        idempotencyKey: `hard-gr-${fixture.suffix}`,
        purchaseOrderId: fixture.po.id,
        supplierId: fixture.supplier.id,
        receivedAt: new Date(),
        lines: {
          create: [
            {
              purchaseOrderLineId: fixture.po.lines[0].id,
              quantityOrdered: 10,
              quantityReceived: 4,
              quantityAccepted: 4,
              quantityRejected: 0,
              condition: "OK",
            },
          ],
        },
      },
    });
    await db.purchaseOrder.update({ where: { id: fixture.po.id }, data: { status: "CANCELLED" } });

    const metrics = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(metrics.lines[0].receivedAccepted.toFixed(4)).toBe("4.0000");
    expect(metrics.openSupplierQty.toFixed(4)).toBe("0.0000");
    // 10 procure - 4 accepted = 6 still needed; untouched lines keep their 10 each.
    expect(metrics.lines[0].remainingToProcure.toFixed(4)).toBe("6.0000");
    expect(metrics.remainingToProcureQty.toFixed(4)).toBe("26.0000");
  });

  it("shows a pending acknowledgement as provisional, then commits only the approved quantity", async () => {
    const fixture = await seed();
    const ack = await recordSupplierAcknowledgement({
      purchaseOrderId: fixture.po.id,
      outcome: "PARTIALLY_ACKNOWLEDGED",
      lines: [{ purchaseOrderLineId: fixture.po.lines[0].id, acknowledgedQuantity: 4 }],
      notes: "Awaiting owner review.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(ack.ok).toBe(true);

    const pending = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(pending.provisionalSupplierQty.toFixed(4)).toBe("30.0000");
    expect(pending.openSupplierQty.toFixed(4)).toBe("30.0000");
    expect(pending.remainingToProcureQty.toFixed(4)).toBe("0.0000");

    if (!ack.ok) return;
    const reviewed = await reviewSupplierAcknowledgement({
      acknowledgementId: ack.acknowledgementId,
      decision: "APPROVE",
      note: "Only 4 confirmed on the first line.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(reviewed.ok).toBe(true);

    const approved = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(approved.provisionalSupplierQty.toFixed(4)).toBe("0.0000");
    expect(approved.openSupplierQty.toFixed(4)).toBe("4.0000");
    expect(approved.remainingToProcureQty.toFixed(4)).toBe("26.0000");
  });

  it("does not double count a received quantity against a live commitment", async () => {
    const fixture = await seed();
    await db.goodsReceipt.create({
      data: {
        receiptNumber: `HARD-GR2-${fixture.suffix}`,
        idempotencyKey: `hard-gr2-${fixture.suffix}`,
        purchaseOrderId: fixture.po.id,
        supplierId: fixture.supplier.id,
        receivedAt: new Date(),
        lines: {
          create: [
            {
              purchaseOrderLineId: fixture.po.lines[0].id,
              quantityOrdered: 10,
              quantityReceived: 4,
              quantityAccepted: 4,
              quantityRejected: 0,
              condition: "OK",
            },
          ],
        },
      },
    });
    const metrics = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(metrics.lines[0].receivedAccepted.toFixed(4)).toBe("4.0000");
    expect(metrics.lines[0].openSupplierCommitment.toFixed(4)).toBe("6.0000");
    expect(metrics.lines[0].remainingToProcure.toFixed(4)).toBe("0.0000");
    expect(metrics.openSupplierQty.toFixed(4)).toBe("26.0000");
    expect(metrics.remainingToProcureQty.toFixed(4)).toBe("0.0000");
  });

  it("reports closure supplier obligations per currency without adding unlike amounts", async () => {
    const fixture = await seed();
    const usdPo = await db.purchaseOrder.create({
      data: {
        poNumber: `HARD-PO-USD-${fixture.suffix}`,
        idempotencyKey: `hard-po-usd-${fixture.suffix}`,
        status: "SENT",
        salesOrderId: fixture.order.id,
        supplierId: fixture.supplier.id,
        currency: "USD",
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        lines: {
          create: [
            {
              salesOrderLineId: fixture.order.lines[0].id,
              lineNo: 1,
              description: "USD-only extra charge",
              quantity: 1,
              unit: "lot",
              unitPrice: 50,
              taxRatePct: 0,
              taxAmount: 0,
              lineTotal: 50,
            },
          ],
        },
      },
    });
    expect(usdPo.currency).toBe("USD");

    const summary = await dealClosureSummary(fixture.order.id);
    expect(summary).not.toBeNull();
    if (!summary) return;
    // AED open commitment is separate from the USD amount.
    expect(dec(summary.obligations.openSupplierValueByCurrency.USD ?? 0).toNumber()).toBe(50);
    expect(dec(summary.obligations.openSupplierValueByCurrency.AED ?? 0).toNumber()).toBe(3000);
    expect(summary.obligations.openSupplierValue).toBe("3000.00");
  });
});
