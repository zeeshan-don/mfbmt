import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import {
  acceptanceInputFromPurchaseOrder,
  convertAcceptanceReview,
  correlateCustomerReply,
  ingestCustomerAcceptanceReply,
  recordCustomerAcceptanceReview,
  rejectAcceptanceReview,
  type AcceptanceCandidate,
} from "../src/lib/orders/customerAcceptance";
import type { CustomerPurchaseOrder } from "../src/lib/ai/customerPo";

async function clean() {
  await runWithTenant({ organizationId: "org_ogs", source: "test" }, async () => {
    await db.customerAcceptanceReview.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.orderStatusEvent.deleteMany();
    await db.customerQuotationItem.deleteMany();
    await db.customerQuotation.deleteMany();
    await db.customer.deleteMany();
    await db.enquiryItem.deleteMany();
    await db.enquiry.deleteMany();
  });
  await db.attachment.deleteMany();
  await db.documentPackage.deleteMany();
  await db.customerAcceptanceReview.deleteMany();
  await db.salesOrderLine.deleteMany();
  await db.salesOrder.deleteMany();
  await db.orderStatusEvent.deleteMany();
  await db.orderDiscrepancy.deleteMany();
  await db.stockReservation.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.customer.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.notification.deleteMany();
  await db.auditLog.deleteMany();
  await db.appSetting.deleteMany();
  await db.user.deleteMany();
}

beforeEach(clean);
afterAll(clean);

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { email: `owner-${suffix}@example.com`, name: "Owner Test", passwordHash: "not-used", role: "OWNER" },
  });
  const customer = await db.customer.create({
    data: { name: `Gulf Projects ${suffix}`, email: `buyer-${suffix}@example.com` },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-${suffix}`,
      channel: "MANUAL",
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      rawText: "10 hex bolts and 5 gate valves",
      status: "QUOTED",
      currency: "AED",
    },
  });
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      customerId: customer.id,
      quoteNumber: `QT-${suffix}`,
      version: 1,
      customerName: customer.name,
      customerEmail: customer.email,
      currency: "AED",
      subtotal: 550,
      taxAmount: 0,
      total: 550,
      terms: "Net 30 days",
      validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: "SENT",
      sentAt: new Date(),
      correlationToken: `TOKEN${suffix.toUpperCase()}`,
      items: {
        create: [
          {
            description: "Hex bolt M12x60 zinc plated",
            specs: "M12 x 60, grade 8.8, zinc plated",
            quantity: 10,
            unit: "pcs",
            unitPrice: 5,
            lineTotal: 50,
            priceStatus: "PRICED",
          },
          {
            description: "Gate valve 2 inch SS316 Class 150",
            specs: "2 inch, SS316 body, Class 150",
            quantity: 5,
            unit: "pcs",
            unitPrice: 100,
            lineTotal: 500,
            priceStatus: "PRICED",
          },
        ],
      },
    },
  });
  const items = await db.customerQuotationItem.findMany({
    where: { quotationId: quotation.id },
    orderBy: { id: "asc" },
  });
  return { suffix, owner, customer, enquiry, quotation, items };
}

function purchaseOrder(overrides: Partial<CustomerPurchaseOrder> = {}): CustomerPurchaseOrder {
  return {
    is_purchase_order: true,
    customer_name: "Gulf Projects",
    po_number: "PO-9001",
    po_date: "2026-11-26",
    currency: "AED",
    payment_terms: "Net 30 days",
    delivery_terms: null,
    delivery_address: "Dubai Industrial Area",
    requested_delivery_date: null,
    tax_amount: null,
    tax_rate_pct: null,
    conditions: null,
    confidence: 0.93,
    notes: null,
    lines: [
      {
        description: "Hex bolt M12x60 zinc plated",
        specifications: null,
        quantity: 10,
        unit: "pcs",
        unit_price: 5,
        discount_pct: null,
        tax_rate_pct: null,
        line_total: 50,
        quoted_item_ref: null,
        evidence: [{ source: "po.pdf", locator: "row 1", quote: "Hex bolt M12x60 zinc plated 10 pcs @ 5.00" }],
      },
      {
        description: "Gate valve 2 inch SS316 Class 150",
        specifications: null,
        quantity: 5,
        unit: "pcs",
        unit_price: 100,
        discount_pct: null,
        tax_rate_pct: null,
        line_total: 500,
        quoted_item_ref: null,
        evidence: [{ source: "po.pdf", locator: "row 2", quote: "Gate valve 2 inch SS316 Class 150 5 pcs @ 100.00" }],
      },
    ],
    ...overrides,
  };
}

function candidate(seedValue: Seed, overrides: Partial<AcceptanceCandidate> = {}): AcceptanceCandidate {
  return {
    quotationId: seedValue.quotation.id,
    quoteNumber: seedValue.quotation.quoteNumber,
    version: 1,
    customerEmail: seedValue.customer.email,
    sentTo: seedValue.customer.email,
    status: "SENT",
    correlationToken: seedValue.quotation.correlationToken,
    providerThreadId: "thread-1",
    providerMessageId: "<message-1@example.com>",
    sentAt: Date.now() - 60_000,
    ...overrides,
  };
}

describe("customer reply correlation", () => {
  it("matches the opaque quotation token and requires uniqueness", async () => {
    const fixture = await seed();
    const matched = correlateCustomerReply(
      { fromAddress: "buyer@example.com", subject: `RE: Quotation ${fixture.quotation.quoteNumber} [QTN-${fixture.quotation.correlationToken}]` },
      [candidate(fixture)],
    );
    expect(matched.status).toBe("MATCHED");
    expect(matched.quotationId).toBe(fixture.quotation.id);
    expect(matched.method).toBe("quotation_token");

    const ambiguous = correlateCustomerReply(
      { fromAddress: "buyer@example.com", subject: `[QTN-${fixture.quotation.correlationToken}]` },
      [candidate(fixture), candidate(fixture, { quotationId: "other-quote" })],
    );
    expect(ambiguous.status).toBe("NEEDS_REVIEW");
    expect(ambiguous.quotationId).toBeNull();
  });

  it("matches a provider thread or message-id header exactly", async () => {
    const fixture = await seed();
    const byThread = correlateCustomerReply(
      { fromAddress: "buyer@example.com", providerThreadId: "thread-1" },
      [candidate(fixture)],
    );
    expect(byThread.status).toBe("MATCHED");
    expect(byThread.method).toBe("provider_thread");

    const byHeader = correlateCustomerReply(
      { fromAddress: "buyer@example.com", references: "<message-1@example.com>" },
      [candidate(fixture)],
    );
    expect(byHeader.status).toBe("MATCHED");
    expect(byHeader.method).toBe("message_id_header");
  });

  it("never auto-attaches on sender identity alone", async () => {
    const fixture = await seed();
    const weak = correlateCustomerReply(
      { fromAddress: fixture.customer.email ?? "", subject: "Please proceed" },
      [candidate(fixture)],
    );
    expect(weak.status).toBe("NEEDS_REVIEW");
    expect(weak.quotationId).toBeNull();
    expect(weak.possible).toHaveLength(1);
  });
});

describe("customer purchase order comparison and conversion", () => {
  it("records an exact acceptance without discrepancies and is idempotent per email", async () => {
    const fixture = await seed();
    const first = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: purchaseOrder() },
      externalMessageId: `msg-${fixture.suffix}`,
      provider: "GMAIL",
      fromAddress: fixture.customer.email,
      subject: `Quotation ${fixture.quotation.quoteNumber}`,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);
    expect(first.blocking).toBe(0);
    expect(first.isPurchaseOrder).toBe(true);

    const review = await db.customerAcceptanceReview.findUnique({ where: { id: first.reviewId } });
    expect(review?.status).toBe("PENDING");
    expect(review?.customerPoNumber).toBe("PO-9001");
    expect(review?.quotationVersion).toBe(1);

    const replay = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: purchaseOrder() },
      externalMessageId: `msg-${fixture.suffix}`,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.duplicate).toBe(true);
    expect(replay.reviewId).toBe(first.reviewId);
    expect(await db.customerAcceptanceReview.count()).toBe(1);
  });

  it("flags a changed price with the quoted and requested values", async () => {
    const fixture = await seed();
    const changed = purchaseOrder();
    changed.lines[1] = { ...changed.lines[1], unit_price: 92 };
    const recorded = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: changed },
      externalMessageId: `msg-price-${fixture.suffix}`,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.blocking).toBeGreaterThan(0);

    const review = await db.customerAcceptanceReview.findUnique({ where: { id: recorded.reviewId } });
    const comparison = JSON.parse(review!.comparisonJson) as {
      blocking: Array<{ code: string; quoted: unknown; requested: unknown; quotationItemId: string }>;
    };
    const price = comparison.blocking.find((entry) => entry.code === "PRICE");
    expect(price).toBeTruthy();
    expect(price?.quoted).toBe(100);
    expect(price?.requested).toBe(92);
    expect(await db.salesOrder.count()).toBe(0);
  });

  it("flags a changed quantity and a changed specification", async () => {
    const fixture = await seed();
    const changed = purchaseOrder();
    changed.lines[0] = { ...changed.lines[0], quantity: 12, line_total: 60 };
    changed.lines[1] = { ...changed.lines[1], specifications: "2 inch, carbon steel body, Class 150" };
    const recorded = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: changed },
      externalMessageId: `msg-qty-${fixture.suffix}`,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const review = await db.customerAcceptanceReview.findUnique({ where: { id: recorded.reviewId } });
    const comparison = JSON.parse(review!.comparisonJson) as { blocking: Array<{ code: string }> };
    expect(comparison.blocking.some((entry) => entry.code === "QUANTITY")).toBe(true);
    expect(comparison.blocking.some((entry) => entry.code === "SPEC")).toBe(true);
  });

  it("does not treat an unreadable document as a purchase order", async () => {
    const fixture = await seed();
    const recorded = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "FAILED", error: "provider unavailable" },
      externalMessageId: `msg-failed-${fixture.suffix}`,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.isPurchaseOrder).toBe(false);

    const conversion = await convertAcceptanceReview({
      reviewId: recorded.reviewId,
      decision: "ACCEPT_ORIGINAL",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(conversion.ok).toBe(false);
    expect(await db.salesOrder.count()).toBe(0);
  });

  it("converts an exact acceptance into one order bound to the quotation version", async () => {
    const fixture = await seed();
    const recorded = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: purchaseOrder() },
      externalMessageId: `msg-convert-${fixture.suffix}`,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const converted = await convertAcceptanceReview({
      reviewId: recorded.reviewId,
      decision: "ACCEPT_ORIGINAL",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;

    const order = await db.salesOrder.findUnique({
      where: { id: converted.salesOrderId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    expect(order?.quotationId).toBe(fixture.quotation.id);
    expect(order?.quotationVersion).toBe(1);
    expect(order?.total.toFixed(2)).toBe("550.00");
    expect(order?.customerPoNumber).toBe("PO-9001");
    expect(order?.lines).toHaveLength(2);

    const review = await db.customerAcceptanceReview.findUnique({ where: { id: recorded.reviewId } });
    expect(review?.status).toBe("CONVERTED");
    expect(review?.salesOrderId).toBe(converted.salesOrderId);

    const again = await convertAcceptanceReview({
      reviewId: recorded.reviewId,
      decision: "ACCEPT_ORIGINAL",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("records an explicit rejection without creating an order", async () => {
    const fixture = await seed();
    const recorded = await recordCustomerAcceptanceReview({
      quotationId: fixture.quotation.id,
      extraction: { status: "OK", data: purchaseOrder() },
      externalMessageId: `msg-reject-${fixture.suffix}`,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const noReason = await rejectAcceptanceReview({
      reviewId: recorded.reviewId,
      reason: "   ",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(noReason.ok).toBe(false);

    const rejected = await rejectAcceptanceReview({
      reviewId: recorded.reviewId,
      reason: "The customer's PO is for a different project.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(rejected.ok).toBe(true);
    const review = await db.customerAcceptanceReview.findUnique({ where: { id: recorded.reviewId } });
    expect(review?.status).toBe("REJECTED");
    expect(await db.salesOrder.count()).toBe(0);
  });

  it("maps a quoted line reference without comparing paraphrased wording", async () => {
    const fixture = await seed();
    const input = acceptanceInputFromPurchaseOrder({
      quotationId: fixture.quotation.id,
      quotationItems: fixture.items.map((item) => ({
        id: item.id,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      extraction: purchaseOrder({
        lines: [
          {
            description: "Hex bolts, M12 x 60mm, zinc",
            specifications: null,
            quantity: 10,
            unit: "pcs",
            unit_price: 5,
            discount_pct: null,
            tax_rate_pct: null,
            line_total: 50,
            quoted_item_ref: "QT-ITEM-1",
            evidence: [],
          },
        ],
      }),
    });
    expect(input.lines?.[0].quotationItemId).toBe(fixture.items[0].id);
    expect(input.lines?.[0].description).toBeNull();
  });

  it("creates one durable review from a correlated inbound customer email", async () => {
    const fixture = await seed();
    const input = {
      provider: "GMAIL" as const,
      externalMessageId: `inbound-${fixture.suffix}`,
      providerThreadId: "customer-thread",
      from: fixture.customer.email ?? "",
      fromName: "Buyer",
      subject: `RE: Quotation ${fixture.quotation.quoteNumber} [QTN-${fixture.quotation.correlationToken}]`,
      body: "Please proceed with the order as quoted.",
    };

    const first = await ingestCustomerAcceptanceReply(input);
    expect(first.handled).toBe(true);
    if (!first.handled) return;
    expect(first.quotationId).toBe(fixture.quotation.id);

    const review = await db.customerAcceptanceReview.findUnique({ where: { id: first.reviewId } });
    expect(review?.status).toBe("PENDING");
    expect(review?.quotationVersion).toBe(1);
    expect(review?.subject).toContain(fixture.quotation.quoteNumber);
    // AI is intentionally disabled in tests: the email and its correlation are
    // still retained, and the review is marked unreadable rather than guessed.
    const extraction = JSON.parse(review!.extractionJson) as { status: string };
    expect(extraction.status).not.toBe("OK");
    expect(await db.salesOrder.count()).toBe(0);

    const replay = await ingestCustomerAcceptanceReply(input);
    expect(replay.handled).toBe(true);
    if (!replay.handled) return;
    expect(replay.duplicate).toBe(true);
    expect(await db.customerAcceptanceReview.count()).toBe(1);
  });

  it("ignores a customer email without a strong quotation identifier", async () => {
    const fixture = await seed();
    const result = await ingestCustomerAcceptanceReply({
      provider: "GMAIL",
      externalMessageId: `weak-${fixture.suffix}`,
      from: fixture.customer.email ?? "",
      subject: "Please send a price for 100 bolts",
      body: "We need a quotation.",
    });
    expect(result.handled).toBe(false);
    expect(await db.customerAcceptanceReview.count()).toBe(0);
  });

  it("cannot read another company's quotation", async () => {
    const suffix = randomUUID().slice(0, 8);
    const ogs = await runWithTenant({ organizationId: "org_ogs", source: "test" }, async () => {
      const enquiry = await db.enquiry.create({
        data: { publicRef: `OGS-${suffix}`, channel: "MANUAL", rawText: "OGS request", currency: "AED" },
      });
      return db.customerQuotation.create({
        data: {
          enquiryId: enquiry.id,
          quoteNumber: `OGS-${suffix}`,
          customerName: "OGS customer",
          currency: "AED",
          status: "SENT",
          sentAt: new Date(),
          items: { create: [{ description: "OGS line", quantity: 1, unit: "pcs", unitPrice: 10 }] },
        },
      });
    });

    const result = await recordCustomerAcceptanceReview({
      quotationId: ogs.id,
      extraction: { status: "OK", data: purchaseOrder() },
      externalMessageId: `cross-${suffix}`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Quotation not found.");
  });
});
