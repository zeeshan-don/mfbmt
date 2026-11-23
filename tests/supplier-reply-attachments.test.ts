import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import {
  extractSupplierQuoteTerms,
  ingestSupplierReply,
  mergeSupplierAttachmentTerms,
} from "../src/lib/workflow/supplierReply";

async function resetDatabase() {
  await db.webhookEvent.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.approval.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.supplierQuoteItem.deleteMany();
  await db.supplierEmailReply.deleteMany();
  await db.attachment.deleteMany();
  await db.supplierQuote.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.contact.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.inventoryStock.deleteMany();
  await db.inventoryLocation.deleteMany();
  await db.materialEquivalence.deleteMany();
  await db.product.deleteMany();
  await db.supplierProduct.deleteMany();
  await db.supplier.deleteMany();
  await db.pricingRule.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
  await db.integration.deleteMany();
}

function makeTextPdf(lines: string[]): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(12).text(lines.join("\n"));
    doc.end();
  });
}

/** A file that claims to be a PDF but cannot be parsed by either reader. */
function corruptPdf(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("not a real pdf body ".repeat(40))]);
}

async function setup() {
  await db.organization.update({
    where: { id: "org_mfbmt" },
    data: { name: "Attachment Test Trading LLC", defaultCurrency: "AED" },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: "10 pcs gate valve SS316 Class 150",
      status: "READY",
      currency: "AED",
    },
  });
  const item = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description: "Gate valve 1 inch SS316 Class 150",
      category: "Valves",
      size: "1 inch",
      material: "SS316",
      pressureRating: "Class 150",
      unit: "pcs",
      quantity: 10,
      quantityToSource: 10,
      missingFields: "[]",
    },
  });
  const supplier = await db.supplier.create({
    data: {
      name: "Attachment Test Supplier",
      email: `supplier-${randomUUID()}@example.com`,
      country: "UAE",
      status: "ACTIVE",
    },
  });
  const quote = await db.supplierQuote.create({
    data: {
      supplierId: supplier.id,
      enquiryItemId: item.id,
      token: randomUUID(),
      status: "SENT",
      correlationToken: "ABCD1234",
      sentTo: supplier.email,
      subject: "Quotation request — Gate valve [RFQ-ABCD1234]",
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      items: { create: [{ description: item.description, quantity: 10, unit: "pcs" }] },
    },
  });
  return { enquiry, item, supplier, quote };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("supplier reply attachment extraction", () => {
  it("reads a quoted PDF and creates an evidence-backed offer from it", async () => {
    const { supplier, quote, item } = await setup();
    const pdf = await makeTextPdf([
      "Quotation No: Q-991",
      "Description: Gate valve 1 inch SS316 Class 150",
      "Unit price: AED 12.50/pc",
      "MOQ: 10 pcs",
      "Lead time: 5 days",
      "Validity: 14 days",
      "Country of origin: India",
    ]);

    const result = await ingestSupplierReply({
      provider: "GMAIL",
      externalMessageId: `msg-${randomUUID()}`,
      from: supplier.email!,
      subject: "Re: Quotation request [RFQ-ABCD1234]",
      body: "Dear team,\nPlease find our quotation attached.\nRegards",
      attachments: [{ filename: "supplier-quote.pdf", buffer: pdf }],
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe("MATCHED");
    expect(result.quoteId).toBe(quote.id);
    expect(result.offerId).toBeTruthy();

    const attachment = await db.attachment.findFirst({ where: { supplierReplyId: result.replyId! } });
    expect(attachment).not.toBeNull();
    // The file was actually parsed, not merely stored.
    expect(attachment!.extractionStatus).toBe("TEXT_OK");
    expect(attachment!.textExtract ?? "").toContain("Unit price");
    expect(attachment!.organizationId).toBe("org_mfbmt");

    const offer = await db.supplierOffer.findUnique({ where: { id: result.offerId! } });
    expect(offer).not.toBeNull();
    expect(offer!.unitPrice).toBe(12.5);
    expect(offer!.currency).toBe("AED");
    expect(offer!.moq).toBe(10);
    expect(offer!.leadTimeDays).toBe(5);
    expect(offer!.enquiryItemId).toBe(item.id);
    // A supplier attachment is evidence, never an approved offer.
    expect(offer!.verificationStatus).toBe("UNVERIFIED");
    expect(offer!.status).toBe("QUOTE_RECEIVED");

    const evidence = JSON.parse(offer!.evidenceJson) as {
      attachmentEvidence?: Array<{ filename: string; sourceRefs: string[]; fieldsFound: string[]; status: string }>;
      attachmentProvenance?: Record<string, string>;
      fieldsFromAttachments?: string[];
    };
    expect(evidence.attachmentEvidence).toHaveLength(1);
    expect(evidence.attachmentEvidence![0].filename).toBe("supplier-quote.pdf");
    expect(evidence.attachmentEvidence![0].status).toBe("TEXT_OK");
    expect(evidence.attachmentEvidence![0].sourceRefs).toContain("page 1");
    expect(evidence.attachmentEvidence![0].fieldsFound).toEqual(expect.arrayContaining(["unitPrice", "moq"]));
    expect(evidence.attachmentProvenance?.unitPrice).toContain("supplier-quote.pdf");
    expect(evidence.fieldsFromAttachments).toEqual(expect.arrayContaining(["unitPrice", "currency"]));

    const reply = await db.supplierEmailReply.findUnique({ where: { id: result.replyId! } });
    expect(reply!.extractionStatus).toBe("EXTRACTED");
    expect(reply!.organizationId).toBe("org_mfbmt");
  });

  it("keeps the email body's stated price when the attachment disagrees", async () => {
    const { supplier } = await setup();
    const pdf = await makeTextPdf(["Unit price: AED 99.00/pc", "MOQ: 50 pcs"]);

    const result = await ingestSupplierReply({
      provider: "MICROSOFT365",
      externalMessageId: `msg-${randomUUID()}`,
      from: supplier.email!,
      subject: "Re: [RFQ-ABCD1234]",
      body: "Unit price: AED 20.00/pc\nMOQ: 10 pcs",
      attachments: [{ filename: "offer.pdf", buffer: pdf }],
    });

    const offer = await db.supplierOffer.findUnique({ where: { id: result.offerId! } });
    expect(offer!.unitPrice).toBe(20);
    expect(offer!.moq).toBe(10);
    const evidence = JSON.parse(offer!.evidenceJson) as { attachmentProvenance?: Record<string, string> };
    // Body values were not overwritten, so the attachment is not their source.
    expect(evidence.attachmentProvenance?.unitPrice).toBeUndefined();
  });

  it("records an unreadable attachment as a failure but still processes the reply", async () => {
    const { supplier } = await setup();

    const result = await ingestSupplierReply({
      provider: "GMAIL",
      externalMessageId: `msg-${randomUUID()}`,
      from: supplier.email!,
      subject: "Re: [RFQ-ABCD1234]",
      body: "Unit price: AED 15.00/pc\nMOQ: 10 pcs",
      attachments: [{ filename: "broken.pdf", buffer: corruptPdf() }],
    });

    expect(result.status).toBe("MATCHED");
    expect(result.offerId).toBeTruthy();
    expect(result.reason ?? "").toContain("broken.pdf");

    const attachment = await db.attachment.findFirst({ where: { supplierReplyId: result.replyId! } });
    expect(attachment!.extractionStatus).toBe("FAILED");
    expect(attachment!.extractionNote ?? "").not.toBe("");

    const offer = await db.supplierOffer.findUnique({ where: { id: result.offerId! } });
    expect(offer!.unitPrice).toBe(15);

    const reply = await db.supplierEmailReply.findUnique({ where: { id: result.replyId! } });
    const correlation = JSON.parse(reply!.correlationJson) as {
      attachmentFailures?: string[];
      documentExtraction?: Array<{ filename: string; status: string }>;
    };
    expect(correlation.attachmentFailures ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("broken.pdf")]),
    );
    expect(correlation.documentExtraction?.[0]?.status).toBe("FAILED");
    // The body still had usable terms, so the reply itself is not a failed extraction.
    expect(reply!.extractionStatus).toBe("EXTRACTED");
  });

  it("never invents values that neither the body nor the attachment stated", () => {
    const bodyTerms = extractSupplierQuoteTerms("Please see attached quotation.", "Re: RFQ");
    const merged = mergeSupplierAttachmentTerms(bodyTerms, [
      {
        attachmentId: "attachment-1",
        filename: "price-list.xlsx",
        status: "TEXT_OK",
        note: null,
        pageCount: 1,
        text: "Sheet: Prices\nDescription: Gate valve 1 inch SS316\nUnit price: USD 4.50/pc  [Prices row 2]",
      },
    ]);

    expect(merged.terms.unitPrice).toBe(4.5);
    expect(merged.terms.currency).toBe("USD");
    // Unstated commercial inputs remain missing, not zero.
    expect(merged.terms.shippingCost).toBeNull();
    expect(merged.terms.taxes).toBeNull();
    expect(merged.terms.otherCharges).toBeNull();
    expect(merged.terms.missingCommercial).toEqual(
      expect.arrayContaining(["Shipping cost", "Taxes", "Quote validity"]),
    );
    expect(merged.provenance.unitPrice).toBe("price-list.xlsx (Prices row 2)");
    expect(merged.evidence[0].sourceRefs).toContain("Prices row 2");
  });
});
