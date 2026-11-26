import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import {
  correlatePurchaseOrderReply,
  deriveAcknowledgement,
  ingestPurchaseOrderAcknowledgement,
  type PurchaseOrderCandidate,
} from "../src/lib/orders/acknowledgements";
import type { SupplierQuotedItem } from "../src/lib/ai/supplierExtraction";
import { ingestSupplierReply } from "../src/lib/workflow/supplierReply";

async function clean() {
  // OGS fixtures created by the tenant-isolation case are removed here too, so
  // the shared test database stays independent of test-file order.
  await runWithTenant({ organizationId: "org_ogs", source: "test" }, async () => {
    await db.supplierAcknowledgement.deleteMany();
    await db.purchaseOrderLine.deleteMany();
    await db.purchaseOrder.deleteMany();
    await db.supplierEmailReply.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.orderStatusEvent.deleteMany();
    await db.customerQuotationItem.deleteMany();
    await db.customerQuotation.deleteMany();
    await db.customer.deleteMany();
    await db.enquiryItem.deleteMany();
    await db.enquiry.deleteMany();
    await db.supplier.deleteMany();
  });
  await db.attachment.deleteMany();
  await db.supplierAcknowledgement.deleteMany();
  await db.goodsReceiptLine.deleteMany();
  await db.goodsReceipt.deleteMany();
  await db.purchaseOrderLine.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.supplierEmailReply.deleteMany();
  await db.salesOrderLine.deleteMany();
  await db.salesOrder.deleteMany();
  await db.orderStatusEvent.deleteMany();
  await db.orderDiscrepancy.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.customer.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.supplier.deleteMany();
  await db.notification.deleteMany();
  await db.auditLog.deleteMany();
  await db.user.deleteMany();
}

beforeEach(clean);
afterAll(clean);

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const supplier = await db.supplier.create({
    data: { name: `Fastener Trader ${suffix}`, email: `sales-${suffix}@fastener.example`, status: "ACTIVE" },
  });
  const customer = await db.customer.create({ data: { name: `Gulf Projects ${suffix}` } });
  const enquiry = await db.enquiry.create({
    data: { publicRef: `ENQ-${suffix}`, channel: "MANUAL", customerId: customer.id, rawText: "bolts and valves", currency: "AED" },
  });
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      customerId: customer.id,
      quoteNumber: `QT-${suffix}`,
      customerName: customer.name,
      currency: "AED",
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      status: "SENT",
      sentAt: new Date(),
      items: { create: [{ description: "Hex bolt M12x60", quantity: 10, unit: "pcs", unitPrice: 5, lineTotal: 50 }] },
    },
  });
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${suffix}`,
      idempotencyKey: `test-order-${suffix}`,
      status: "PROCUREMENT_IN_PROGRESS",
      quotationId: quotation.id,
      quotationVersion: 1,
      customerId: customer.id,
      customerName: customer.name,
      currency: "AED",
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      lines: {
        create: [
          { lineNo: 1, description: "Hex bolt M12x60", quantity: 10, unit: "pcs", unitPrice: 5, lineTotal: 50, procureQuantity: 10 },
          { lineNo: 2, description: "Gate valve 2 inch SS316", quantity: 2, unit: "pcs", unitPrice: 25, lineTotal: 50, procureQuantity: 2 },
        ],
      },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-${suffix}`,
      idempotencyKey: `test-po-${suffix}`,
      status: "SENT",
      salesOrderId: order.id,
      supplierId: supplier.id,
      currency: "AED",
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      sentAt: new Date(),
      correlationToken: `PO${suffix.toUpperCase()}`,
      lines: {
        create: [
          {
            salesOrderLineId: order.lines[0].id,
            lineNo: 1,
            description: "Hex bolt M12x60",
            quantity: 10,
            unit: "pcs",
            unitPrice: 5,
            lineTotal: 50,
          },
          {
            salesOrderLineId: order.lines[1].id,
            lineNo: 2,
            description: "Gate valve 2 inch SS316",
            quantity: 2,
            unit: "pcs",
            unitPrice: 25,
            lineTotal: 50,
          },
        ],
      },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  const reply = await db.supplierEmailReply.create({
    data: {
      supplierId: supplier.id,
      externalMessageId: `reply-${suffix}`,
      provider: "GMAIL",
      fromAddress: supplier.email ?? "",
      subject: `RE: Purchase order ${po.poNumber}`,
      bodySummary: "We confirm the order and will deliver next week.",
      receivedAt: new Date(),
    },
  });
  return { suffix, supplier, customer, enquiry, quotation, order, po, reply };
}

function candidate(seedValue: Seed, overrides: Partial<PurchaseOrderCandidate> = {}): PurchaseOrderCandidate {
  return {
    purchaseOrderId: seedValue.po.id,
    poNumber: seedValue.po.poNumber,
    supplierId: seedValue.supplier.id,
    supplierEmail: seedValue.supplier.email,
    sentTo: null,
    status: "SENT",
    correlationToken: seedValue.po.correlationToken,
    providerThreadId: "po-thread-1",
    providerMessageId: "<po-message@example.com>",
    sentAt: Date.now() - 60_000,
    ...overrides,
  };
}

function quotedItem(overrides: Partial<SupplierQuotedItem> = {}): SupplierQuotedItem {
  return {
    description: "Hex bolt M12x60",
    matched_rfq_item_ref: null,
    price_basis: "UNIT",
    unit_price: null,
    total_price: null,
    quantity: null,
    unit_of_measure: null,
    minimum_order_quantity: null,
    lead_time: null,
    lead_time_days: null,
    shipping_cost: null,
    taxes: null,
    validity: null,
    payment_terms: null,
    availability: null,
    notes: null,
    alternative_to: null,
    evidence: [],
    ...overrides,
  };
}

const PO_LINES = [
  { id: "line-1", description: "Hex bolt M12x60", quantity: 10, unitPrice: 5, unit: "pcs" },
  { id: "line-2", description: "Gate valve 2 inch SS316", quantity: 2, unitPrice: 25, unit: "pcs" },
];

describe("supplier purchase-order reply correlation", () => {
  it("matches the opaque PO token, thread or header and requires uniqueness", async () => {
    const fixture = await seed();
    const token = correlatePurchaseOrderReply(
      { fromAddress: "sales@example.com", subject: `RE: Purchase order ${fixture.po.poNumber} [PO-${fixture.po.correlationToken}]` },
      [candidate(fixture)],
    );
    expect(token.status).toBe("MATCHED");
    expect(token.purchaseOrderId).toBe(fixture.po.id);
    expect(token.method).toBe("po_token");

    const thread = correlatePurchaseOrderReply({ fromAddress: "sales@example.com", providerThreadId: "po-thread-1" }, [
      candidate(fixture),
    ]);
    expect(thread.status).toBe("MATCHED");

    const header = correlatePurchaseOrderReply(
      { fromAddress: "sales@example.com", inReplyTo: "<po-message@example.com>" },
      [candidate(fixture)],
    );
    expect(header.status).toBe("MATCHED");

    const ambiguous = correlatePurchaseOrderReply({ fromAddress: "sales@example.com", providerThreadId: "po-thread-1" }, [
      candidate(fixture),
      candidate(fixture, { purchaseOrderId: "other-po" }),
    ]);
    expect(ambiguous.status).toBe("NEEDS_REVIEW");
  });

  it("does not auto-attach a purchase order from the supplier address alone", async () => {
    const fixture = await seed();
    const weak = correlatePurchaseOrderReply(
      { fromAddress: fixture.supplier.email ?? "", subject: "Delivery update" },
      [candidate(fixture)],
    );
    expect(weak.status).toBe("NEEDS_REVIEW");
    expect(weak.purchaseOrderId).toBeNull();
  });
});

describe("supplier acknowledgement derivation", () => {
  it("records a partial quantity, revised price and late promise without changing the PO", () => {
    const derived = deriveAcknowledgement({
      lines: PO_LINES,
      quotedItems: [
        quotedItem({ quantity: 4, unit_price: 5, lead_time_days: 30 }),
        quotedItem({ description: "Gate valve 2 inch SS316", quantity: 2, unit_price: 28, lead_time_days: 30 }),
      ],
      body: "We can supply part of the order and the valve price has changed.",
      receivedAt: new Date("2026-11-26T00:00:00Z"),
      expectedDeliveryDate: new Date("2026-12-03T00:00:00Z"),
    });
    expect(derived.outcome).toBe("REVISED");
    expect(derived.deviations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["PARTIAL_QUANTITY", "REVISED_PRICE", "LATE_DELIVERY"]),
    );
    expect(derived.lines[0].acknowledgedQuantity).toBe(4);
    expect(derived.lines[1].revisedUnitPrice).toBe(28);
    expect(derived.promisedDate?.toISOString()).toContain("2026-12-26");
    expect(derived.confidence).toBe("HIGH");
  });

  it("detects a rejection and never records a positive commitment", () => {
    const derived = deriveAcknowledgement({
      lines: PO_LINES,
      quotedItems: [quotedItem({ quantity: 10 })],
      body: "We are unable to supply this item and must decline the order.",
      receivedAt: new Date(),
    });
    expect(derived.outcome).toBe("REJECTED");
    expect(derived.lines.every((line) => line.acknowledgedQuantity === 0)).toBe(true);
    expect(derived.deviations[0].code).toBe("SUPPLIER_REJECTED");
  });

  it("defaults to the ordered quantities when the reply has no itemised evidence", () => {
    const derived = deriveAcknowledgement({
      lines: PO_LINES,
      quotedItems: [],
      body: "Acknowledged, thank you.",
      receivedAt: new Date(),
    });
    expect(derived.outcome).toBe("ACKNOWLEDGED");
    expect(derived.method).toBe("DETERMINISTIC_DEFAULT");
    expect(derived.confidence).toBe("LOW");
    expect(derived.lines.map((line) => line.acknowledgedQuantity)).toEqual([10, 2]);
  });
});

describe("supplier acknowledgement ingestion", () => {
  it("creates one pending acknowledgement and leaves the approved PO values untouched", async () => {
    const fixture = await seed();
    const before = await db.purchaseOrder.findUnique({ where: { id: fixture.po.id }, include: { lines: true } });

    const result = await ingestPurchaseOrderAcknowledgement({
      supplierReplyId: fixture.reply.id,
      purchaseOrderId: fixture.po.id,
      body: "We confirm 4 bolts only; the valve price is 28 each.",
      receivedAt: new Date(),
      quotedItems: [
        quotedItem({ quantity: 4, unit_price: 5 }),
        quotedItem({ description: "Gate valve 2 inch SS316", quantity: 2, unit_price: 28 }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("REVISED");

    const po = await db.purchaseOrder.findUnique({ where: { id: fixture.po.id }, include: { lines: true, acknowledgements: true } });
    expect(po?.status).toBe("ACKNOWLEDGEMENT_RECEIVED");
    expect(po?.acknowledgements).toHaveLength(1);
    expect(po?.acknowledgements[0].reviewStatus).toBe("PENDING");
    expect(po?.acknowledgements[0].source).toBe("EMAIL");
    expect(po?.acknowledgements[0].supplierReplyId).toBe(fixture.reply.id);
    expect(po?.lines[1].unitPrice.toFixed(2)).toBe("25.00");
    expect(po?.total.toFixed(2)).toBe(before?.total.toFixed(2));

    const reply = await db.supplierEmailReply.findUnique({ where: { id: fixture.reply.id } });
    expect(reply?.purchaseOrderId).toBe(fixture.po.id);

    const replay = await ingestPurchaseOrderAcknowledgement({
      supplierReplyId: fixture.reply.id,
      purchaseOrderId: fixture.po.id,
      body: "duplicate delivery of the same email",
      receivedAt: new Date(),
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.duplicate).toBe(true);
    expect(await db.supplierAcknowledgement.count()).toBe(1);
  });

  it("routes an inbound supplier email to the purchase order, once", async () => {
    const fixture = await seed();
    const input = {
      provider: "GMAIL" as const,
      externalMessageId: `inbound-${fixture.suffix}`,
      providerThreadId: "inbound-thread",
      from: fixture.supplier.email ?? "",
      fromName: "Supplier Sales",
      subject: `RE: Purchase order ${fixture.po.poNumber} [PO-${fixture.po.correlationToken}]`,
      body: "Thank you, we acknowledge the order and will confirm the delivery date.",
    };

    const first = await ingestSupplierReply(input);
    expect(first.handled).toBe(true);
    expect(first.status).toBe("MATCHED");
    expect(first.quoteId).toBeNull();

    const po = await db.purchaseOrder.findUnique({
      where: { id: fixture.po.id },
      include: { acknowledgements: true },
    });
    expect(po?.status).toBe("ACKNOWLEDGEMENT_RECEIVED");
    expect(po?.acknowledgements).toHaveLength(1);
    expect(po?.acknowledgements[0].reviewStatus).toBe("PENDING");
    expect(po?.acknowledgements[0].source).toBe("EMAIL");

    const replay = await ingestSupplierReply(input);
    expect(replay.handled).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(await db.supplierAcknowledgement.count()).toBe(1);
  });

  it("refuses a PO that was never sent", async () => {
    const fixture = await seed();
    await db.purchaseOrder.update({ where: { id: fixture.po.id }, data: { status: "AWAITING_APPROVAL" } });
    const result = await ingestPurchaseOrderAcknowledgement({
      supplierReplyId: fixture.reply.id,
      purchaseOrderId: fixture.po.id,
      body: "ok",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    expect(await db.supplierAcknowledgement.count()).toBe(0);
  });

  it("cannot read another company's purchase order", async () => {
    const suffix = randomUUID().slice(0, 8);
    const ogs = await runWithTenant({ organizationId: "org_ogs", source: "test" }, async () => {
      const supplier = await db.supplier.create({ data: { name: `OGS Supplier ${suffix}`, status: "ACTIVE" } });
      const customer = await db.customer.create({ data: { name: `OGS Customer ${suffix}` } });
      const enquiry = await db.enquiry.create({
        data: { publicRef: `OGS-ENQ-${suffix}`, channel: "MANUAL", rawText: "ogs", currency: "AED" },
      });
      const quotation = await db.customerQuotation.create({
        data: {
          enquiryId: enquiry.id,
          quoteNumber: `OGS-QT-${suffix}`,
          customerName: customer.name,
          currency: "AED",
          status: "SENT",
          sentAt: new Date(),
          items: { create: [{ description: "OGS line", quantity: 1, unit: "pcs", unitPrice: 10 }] },
        },
      });
      const order = await db.salesOrder.create({
        data: {
          orderNumber: `OGS-SO-${suffix}`,
          idempotencyKey: `ogs-order-${suffix}`,
          quotationId: quotation.id,
          quotationVersion: 1,
          customerName: customer.name,
          currency: "AED",
          lines: { create: [{ lineNo: 1, description: "OGS line", quantity: 1, unit: "pcs", unitPrice: 10 }] },
        },
        include: { lines: true },
      });
      return db.purchaseOrder.create({
        data: {
          poNumber: `OGS-PO-${suffix}`,
          idempotencyKey: `ogs-po-${suffix}`,
          status: "SENT",
          salesOrderId: order.id,
          supplierId: supplier.id,
          currency: "AED",
          sentAt: new Date(),
          lines: {
            create: [
              {
                salesOrderLineId: order.lines[0].id,
                lineNo: 1,
                description: "OGS line",
                quantity: 1,
                unitPrice: 10,
                lineTotal: 10,
              },
            ],
          },
        },
      });
    });
    const reply = await db.supplierEmailReply.create({
      data: {
        externalMessageId: `cross-${suffix}`,
        provider: "GMAIL",
        fromAddress: "ogs@example.com",
        subject: "RE: PO",
        bodySummary: "ok",
        receivedAt: new Date(),
      },
    });
    const result = await ingestPurchaseOrderAcknowledgement({
      supplierReplyId: reply.id,
      purchaseOrderId: ogs.id,
      body: "ok",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Purchase order not found.");
  });
});
