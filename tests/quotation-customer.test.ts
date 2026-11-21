import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createQuotationDraft, setQuotationOutcome } from "../src/lib/workflow/quotations";
import { resolvePricingRule } from "../src/lib/pricing/rules";

async function clean() {
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.customerContact.deleteMany();
  await db.customer.deleteMany();
  await db.approval.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.user.deleteMany();
}

beforeEach(clean);
afterAll(clean);

describe("customer master and quotation quality", () => {
  it("links a draft quotation to a customer master record", async () => {
    const owner = await db.user.create({
      data: { email: `owner-${randomUUID()}@example.com`, name: "Test Owner", passwordHash: "not-used", role: "OWNER" },
    });
    const email = `buyer-${randomUUID()}@example.com`;
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `ENQ-${randomUUID().slice(0, 8)}`,
        channel: "MANUAL",
        customerName: "Gulf Projects LLC",
        customerEmail: email,
        rawText: "Gate valve",
        status: "APPROVED",
        items: {
          create: [{
            description: "Gate valve 2 inch SS316 Class 150",
            category: "Valves",
            unit: "pcs",
            quantity: 2,
            quantityToSource: 2,
            missingFields: "[]",
          }],
        },
      },
    });

    const draft = await createQuotationDraft({
      enquiryId: enquiry.id,
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const customer = await db.customer.findFirst({ where: { email } });
    expect(customer).not.toBeNull();
    const quote = await db.customerQuotation.findUnique({ where: { id: draft.quotationId } });
    expect(quote?.customerId).toBe(customer!.id);
    expect(quote?.changeSummary).toMatch(/initial quotation/i);
    const linkedEnquiry = await db.enquiry.findUnique({ where: { id: enquiry.id } });
    expect(linkedEnquiry?.customerId).toBe(customer!.id);
  });

  it("records a quotation outcome only after release", async () => {
    const owner = await db.user.create({
      data: { email: `owner-${randomUUID()}@example.com`, name: "Test Owner", passwordHash: "not-used", role: "OWNER" },
    });
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `ENQ-${randomUUID().slice(0, 8)}`,
        channel: "MANUAL",
        customerName: "Outcome Customer",
        rawText: "Valve",
        status: "QUOTED",
      },
    });
    const quote = await db.customerQuotation.create({
      data: {
        enquiryId: enquiry.id,
        quoteNumber: `QT-${randomUUID().slice(0, 8)}`,
        customerName: "Outcome Customer",
        currency: "AED",
        status: "SENT",
        sentAt: new Date(),
      },
    });
    const result = await setQuotationOutcome({
      quotationId: quote.id,
      outcome: "WON",
      reason: "Purchase order received.",
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(result.ok).toBe(true);
    const updated = await db.customerQuotation.findUnique({ where: { id: quote.id } });
    expect(updated?.outcome).toBe("WON");
    expect(updated?.outcomeReason).toMatch(/purchase order/i);
  });

  it("prefers a customer-tier pricing rule over the generic category rule", () => {
    const rules = [
      { id: "generic", scope: "CATEGORY", category: "Valves", customerTier: null, type: "PERCENT_MARKUP", value: 10, priority: 100, isActive: true },
      { id: "gold", scope: "CATEGORY", category: "Valves", customerTier: "GOLD", type: "PERCENT_MARKUP", value: 20, priority: 100, isActive: true },
    ];
    expect(resolvePricingRule(rules, "Valves", "STANDARD")?.id).toBe("generic");
    expect(resolvePricingRule(rules, "Valves", "GOLD")?.id).toBe("gold");
  });
});
