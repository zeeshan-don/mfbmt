import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { ingestSupplierReply } from "../src/lib/workflow/supplierReply";

async function clean() {
  await db.attachment.deleteMany();
  await db.supplierEmailReply.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.supplierQuoteItem.deleteMany();
  await db.supplierQuote.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.supplier.deleteMany();
  await db.approval.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.backgroundJob.deleteMany();
}

async function setupQuote(correlationToken = "A1B2C3D4") {
  const owner = await db.user.create({
    data: {
      email: `owner-${randomUUID()}@example.com`,
      name: "Reply Test Owner",
      passwordHash: await hashPassword("Str0ng-Enough-2026"),
      role: "OWNER",
    },
  });
  const supplier = await db.supplier.create({
    data: { name: "Gulf Valve Trading", email: `sales-${randomUUID()}@supplier.example`, status: "ACTIVE" },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: "10 pcs gate valve 2 inch SS316 Class 150",
      status: "SOURCING",
    },
  });
  const item = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description: "Gate valve 2 inch SS316 Class 150",
      category: "Valves",
      size: "2 inch",
      material: "SS316",
      pressureRating: "Class 150",
      unit: "pcs",
      quantity: 10,
      quantityToSource: 10,
      missingFields: "[]",
    },
  });
  const quote = await db.supplierQuote.create({
    data: {
      supplierId: supplier.id,
      enquiryItemId: item.id,
      token: randomUUID(),
      correlationToken,
      providerThreadId: "thread-gulf-1",
      status: "SENT",
      sentTo: supplier.email,
      subject: `Quotation request ${enquiry.publicRef} [RFQ-${correlationToken}]`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      items: { create: [{ description: item.description, quantity: 10, unit: "pcs" }] },
    },
  });
  return { owner, supplier, enquiry, item, quote };
}

beforeEach(clean);
afterAll(clean);

describe("automatic supplier email reply ingestion", () => {
  it("creates one unverified offer draft and is idempotent on repeated syncs", async () => {
    const { supplier, item, quote } = await setupQuote();
    const input = {
      provider: "GMAIL" as const,
      externalMessageId: "<reply-1@supplier.example>",
      providerThreadId: "thread-gulf-1",
      internetMessageId: "<reply-1@supplier.example>",
      from: supplier.email!,
      fromName: "Gulf Valve Trading",
      subject: "Re: Quotation request [RFQ-A1B2C3D4]",
      body: [
        "Dear Procurement,",
        "We can offer: Gate valve 2 inch SS316 Class 150",
        "Unit price: AED 85.00/pc",
        "MOQ: 10 pcs",
        "Lead time: 7 days",
        "Validity: 14 days",
        "Payment terms: 30 days",
        "Best regards",
      ].join("\n"),
    };

    const first = await ingestSupplierReply(input);
    expect(first.handled).toBe(true);
    expect(first.status).toBe("MATCHED");
    expect(first.quoteId).toBe(quote.id);

    const second = await ingestSupplierReply(input);
    expect(second.duplicate).toBe(true);

    expect(await db.supplierEmailReply.count()).toBe(1);
    expect(await db.supplierOffer.count()).toBe(1);

    const offer = await db.supplierOffer.findFirst({ where: { enquiryItemId: item.id } });
    expect(offer?.verificationStatus).toBe("UNVERIFIED");
    expect(offer?.status).toBe("QUOTE_RECEIVED");
    expect(offer?.unitPrice).toBe(85);
    expect(offer?.currency).toBe("AED");
    // Not stated ⇒ unknown, never zero.
    expect(offer?.shippingCost).toBeNull();
    expect(offer?.taxes).toBeNull();

    const updatedQuote = await db.supplierQuote.findUnique({ where: { id: quote.id } });
    expect(updatedQuote?.status).toBe("RESPONDED");
  });

  it("marks a reply with only sender evidence as NEEDS_REVIEW and creates no offer", async () => {
    await setupQuote();
    const { supplier, item } = await setupQuote("ZZZZ9999");
    const result = await ingestSupplierReply({
      provider: "MICROSOFT365",
      externalMessageId: "<reply-2@supplier.example>",
      providerThreadId: "unrelated-thread",
      from: supplier.email!,
      subject: "Re: your enquiry",
      body: "Please find our offer attached. Unit price AED 10/pc.",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.offerId).toBeNull();
    expect(await db.supplierOffer.count({ where: { enquiryItemId: item.id } })).toBe(0);
    const reply = await db.supplierEmailReply.findFirst();
    expect(reply?.matchingStatus).toBe("NEEDS_REVIEW");
    expect(reply?.reviewStatus).toBe("PENDING");
  });

  it("retains an unmatched email from a known supplier instead of discarding it", async () => {
    const supplier = await db.supplier.create({
      data: { name: "Unknown RFQ Supplier", email: `sales-${randomUUID()}@supplier.example`, status: "ACTIVE" },
    });
    const result = await ingestSupplierReply({
      provider: "GMAIL",
      externalMessageId: "<reply-3@supplier.example>",
      from: supplier.email!,
      subject: "Company brochure",
      body: "Our latest product catalogue is attached.",
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe("UNMATCHED");
    expect(await db.supplierEmailReply.count()).toBe(1);
  });

  it("ignores a sender who is not a known supplier", async () => {
    const result = await ingestSupplierReply({
      provider: "GMAIL",
      externalMessageId: "<reply-4@unknown.example>",
      from: "stranger@unknown.example",
      subject: "Hello",
      body: "Unrelated email.",
    });
    expect(result.handled).toBe(false);
    expect(await db.supplierEmailReply.count()).toBe(0);
  });
});
