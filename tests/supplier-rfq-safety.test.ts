import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { parseJson } from "../src/lib/json";
import {
  createDraftSupplierQuoteRequest,
  createSupplierQuoteRequest,
  sendSupplierQuoteRequest,
} from "../src/lib/workflow/supplierQuotes";

async function clean() {
  await db.supplierQuoteItem.deleteMany();
  await db.supplierQuote.deleteMany();
  await db.outboundMessage.deleteMany();
  await db.approval.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.searchResult.deleteMany();
  await db.searchQuery.deleteMany();
  await db.searchSession.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.supplierProduct.deleteMany();
  await db.supplierContact.deleteMany();
  await db.supplier.deleteMany();
}

async function setup(description = "Long radius elbow carbon steel ASTM A234 WPB 0.5in") {
  const supplier = await db.supplier.create({
    data: {
      name: `RFQ Supplier ${randomUUID().slice(0, 6)}`,
      email: `rfq-${randomUUID()}@supplier.example`,
      status: "ACTIVE",
    },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-RFQ-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: description,
      status: "SOURCING",
      requestedDeliveryTimeframe: "3 days",
    },
  });
  const item = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description,
      category: "Stainless Steel Fittings",
      material: "Carbon Steel",
      grade: "A234 WPB",
      standard: "ASTM A234",
      unit: "pcs",
      quantity: 90,
      quantityToSource: 90,
      missingFields: JSON.stringify(["Pressure class"]),
    },
  });
  return { supplier, enquiry, item };
}

beforeEach(clean);
afterAll(clean);

describe("supplier RFQ safety and approval gating", () => {
  it("creates a clean supplier-facing draft and records the quality report", async () => {
    const { supplier, item } = await setup(
      "Long radius elbow carbon steel ASTM A234 WPB 0.5in — catalogue-derived product line — Confirm exact item",
    );
    const created = await createDraftSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: item.id,
      userId: "system",
      actorLabel: "test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const quote = await db.supplierQuote.findUnique({
      where: { id: created.quoteId },
      include: { items: true },
    });
    expect(quote?.status).toBe("DRAFT");
    expect(quote?.messageBody).toMatch(/long radius elbow/i);
    expect(quote?.messageBody).toMatch(/90 pcs/);
    expect(quote?.messageBody).toMatch(/please confirm the pressure class/i);
    expect(quote?.messageBody).not.toMatch(/catalogue-derived|confirm exact item|row 27/i);
    expect(quote?.messageBody).not.toMatch(/internal match confidence/i);
    expect(quote?.items[0].description).not.toMatch(/catalogue-derived/i);

    const quality = parseJson<{ ok?: boolean; findings?: Array<{ severity: string }> }>(
      quote?.draftQualityJson ?? "{}",
      {},
    );
    expect(quality.ok).toBe(true);
    expect(quality.findings ?? []).toHaveLength(0);

    // A draft is not an approval and nothing is sent by creating one.
    expect(await db.approval.count({ where: { entityId: created.quoteId } })).toBe(0);
  });

  it("registers a pending approval for an owner-requested RFQ and refuses to send without it", async () => {
    const { supplier, item } = await setup();
    const created = await createSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: item.id,
      userId: "system",
      actorLabel: "owner",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const quote = await db.supplierQuote.findUnique({ where: { id: created.quoteId } });
    expect(quote?.status).toBe("AWAITING_APPROVAL");
    const approval = await db.approval.findFirst({
      where: { type: "SUPPLIER_QUOTE_SEND", entityId: created.quoteId },
    });
    expect(approval?.status).toBe("PENDING");

    const sent = await sendSupplierQuoteRequest(created.quoteId);
    expect(sent.ok).toBe(false);
    expect(sent.detail).toMatch(/not been approved/i);
    expect(await db.outboundMessage.count({ where: { relatedId: created.quoteId } })).toBe(0);
  });

  it("blocks a contaminated legacy draft even when an approval exists", async () => {
    const { supplier, enquiry } = await setup();
    const quote = await db.supplierQuote.create({
      data: {
        supplierId: supplier.id,
        enquiryItemId: null,
        token: `token-${randomUUID()}`,
        status: "DRAFT",
        expiresAt: new Date(Date.now() + 86_400_000),
        subject: "Quotation request ENQ-LEGACY",
        messageBody:
          "Dear Sales Team,\n1. Long radius elbow — catalogue-derived product line\n0.5in - MS\nConfirm exact item.",
        items: {
          create: [
            {
              description: "Long radius elbow",
              quantity: 90,
              unit: "pcs",
            },
          ],
        },
      },
    });
    await db.approval.create({
      data: {
        type: "SUPPLIER_QUOTE_SEND",
        entityType: "SupplierQuote",
        entityId: quote.id,
        enquiryId: enquiry.id,
        status: "APPROVED",
        requestedBy: "legacy draft",
        decidedAt: new Date(),
      },
    });

    const sent = await sendSupplierQuoteRequest(quote.id);
    expect(sent.ok).toBe(false);
    expect(sent.detail).toMatch(/quality check/i);
    expect(await db.outboundMessage.count({ where: { relatedId: quote.id } })).toBe(0);

    const updated = await db.supplierQuote.findUnique({ where: { id: quote.id } });
    expect(updated?.status).toBe("DRAFT");
    expect(updated?.lastError).toMatch(/quality check blocked/i);
  });
});
