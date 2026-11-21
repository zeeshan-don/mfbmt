import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createDraftSupplierQuoteRequest, sendSupplierQuoteRequest } from "../src/lib/workflow/supplierQuotes";
import { supplierSendGuard } from "../src/lib/suppliers/sendGuard";

async function clean() {
  await db.supplierQuoteItem.deleteMany();
  await db.supplierQuote.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.supplierContact.deleteMany();
  await db.supplier.deleteMany();
  await db.excludedContact.deleteMany();
  await db.approval.deleteMany();
  await db.auditLog.deleteMany();
}

async function setup() {
  const supplier = await db.supplier.create({
    data: {
      name: `Outreach ${randomUUID().slice(0, 6)}`,
      email: `sales-${randomUUID()}@supplier.example`,
      status: "ACTIVE",
    },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: "Gate valve",
      status: "SOURCING",
    },
  });
  const item = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description: "Gate valve 2 inch SS316 Class 150",
      category: "Valves",
      unit: "pcs",
      quantity: 2,
      quantityToSource: 2,
      missingFields: "[]",
    },
  });
  return { supplier, item };
}

beforeEach(clean);
afterAll(clean);

describe("supplier outreach safeguards", () => {
  it("creates a draft without an approval and refuses a duplicate supplier/item RFQ", async () => {
    const { supplier, item } = await setup();
    const first = await createDraftSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: item.id,
      userId: "system",
      actorLabel: "test",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const quote = await db.supplierQuote.findUnique({ where: { id: first.quoteId } });
    expect(quote?.status).toBe("DRAFT");
    expect(await db.approval.count({ where: { entityId: first.quoteId } })).toBe(0);

    const second = await createDraftSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: item.id,
      userId: "system",
      actorLabel: "test",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already waiting/i);
  });

  it("blocks a do-not-contact supplier even if an approval exists", async () => {
    const { supplier, item } = await setup();
    const created = await createDraftSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: item.id,
      userId: "system",
      actorLabel: "test",
    });
    if (!created.ok) throw new Error(created.error);
    await db.supplier.update({ where: { id: supplier.id }, data: { doNotContact: true } });
    await db.approval.create({
      data: {
        type: "SUPPLIER_QUOTE_SEND",
        entityType: "SupplierQuote",
        entityId: created.quoteId,
        status: "APPROVED",
      },
    });

    const guard = await supplierSendGuard(supplier.id);
    expect(guard.ok).toBe(false);
    expect(guard.error).toMatch(/do not contact/i);
    const sent = await sendSupplierQuoteRequest(created.quoteId);
    expect(sent.ok).toBe(false);
    expect(sent.detail).toMatch(/do not contact/i);
    expect((await db.supplierQuote.findUnique({ where: { id: created.quoteId } }))?.status).toBe("DRAFT");
  });

  it("blocks a supplier whose email address is on the exclusion list", async () => {
    const { supplier } = await setup();
    await db.excludedContact.create({
      data: { identifier: supplier.email!.toLowerCase(), category: "OTHER", label: "Test exclusion" },
    });
    const guard = await supplierSendGuard(supplier.id);
    expect(guard.ok).toBe(false);
    expect(guard.error).toMatch(/exclusion/i);
  });
});
