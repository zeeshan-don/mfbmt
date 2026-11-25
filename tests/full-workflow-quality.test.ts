import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { parseJson } from "../src/lib/json";
import { extractEnquiry } from "../src/lib/ai/extract";
import { runSourcingForItem } from "../src/lib/sourcing/engine";
import { createDraftSupplierQuoteRequest } from "../src/lib/workflow/supplierQuotes";

const BODY = "Hi, I need these items urgently in 3 days. Please quote.";
const ATTACHMENT = {
  filename: "customer-rfq.xlsx",
  kind: "excel" as const,
  text:
    "Sheet: RFQ\n" +
    "90 pcs Long radius elbow, carbon steel, ASTM A234 WPB, 0.5in [RFQ row 2]\n" +
    "40 pcs Gate valve 2 inch SS316 Class 150 [RFQ row 3]",
};

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
  await db.searchCache.deleteMany();
}

beforeEach(clean);
afterAll(clean);

describe("real-world enquiry to approved supplier RFQ", () => {
  it("keeps context separate, sources against real specs and composes a clean RFQ", async () => {
    const extraction = await extractEnquiry(
      { text: BODY, subject: "Urgent requirement", documents: [ATTACHMENT] },
      { allowAi: false },
    );

    // Communication context is captured separately and never becomes a product.
    expect(extraction.extraction.customerContext?.greeting).toMatch(/^hi\b/i);
    expect(extraction.extraction.customerContext?.urgency).toMatch(/urgent/i);
    expect(extraction.extraction.customerContext?.requestedDeliveryTimeframe).toMatch(/3 days/i);
    expect(extraction.extraction.customerContext?.instructions.join(" ")).toMatch(/please quote/i);
    expect(extraction.items).toHaveLength(2);
    expect(extraction.items.map((item) => item.description).join(" ")).not.toMatch(/need these items/i);
    expect(extraction.items.map((item) => item.description).join(" ")).not.toMatch(/please quote/i);

    const elbow = extraction.items.find((item) => /elbow/i.test(item.description));
    const valve = extraction.items.find((item) => /gate valve/i.test(item.description));
    expect(elbow?.quantity).toBe(90);
    expect(valve?.quantity).toBe(40);
    expect(valve?.missingFields ?? []).toHaveLength(0);

    const supplier = await db.supplier.create({
      data: {
        name: `Workflow Supplier ${randomUUID().slice(0, 6)}`,
        email: `workflow-${randomUUID()}@supplier.example`,
        status: "ACTIVE",
        country: "AE",
      },
    });
    await db.supplierProduct.create({
      data: {
        supplierId: supplier.id,
        title: "Gate valve 2 inch SS316 Class 150",
        description: "Gate valve, stainless steel, raised face flanged",
        specs: JSON.stringify({ material: "SS316", size: "2 inch", pressureRating: "Class 150" }),
        unitPrice: 125,
        currency: "AED",
      },
    });

    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `ENQ-WF-${randomUUID().slice(0, 8)}`,
        channel: "MANUAL",
        rawText: BODY,
        status: "SOURCING",
        urgency: extraction.extraction.customerContext?.urgency ?? null,
        requestedDeliveryTimeframe:
          extraction.extraction.customerContext?.requestedDeliveryTimeframe ?? null,
        customerInstructionsJson: JSON.stringify(
          extraction.extraction.customerContext?.instructions ?? [],
        ),
      },
    });

    const savedItems = [];
    for (const [index, item] of extraction.items.entries()) {
      savedItems.push(
        await db.enquiryItem.create({
          data: {
            enquiryId: enquiry.id,
            lineNo: index + 1,
            description: item.description,
            category: item.category,
            brand: item.brand,
            size: item.size,
            material: item.material,
            grade: item.grade,
            pressureRating: item.pressureRating,
            schedule: item.schedule,
            standard: item.standard,
            unit: item.unit ?? "pcs",
            quantity: item.quantity ?? 0,
            quantityToSource: item.quantity ?? 0,
            missingFields: JSON.stringify(item.missingFields ?? []),
            clarificationQuestion: item.clarificationQuestion,
            sourceRef: item.sourceRef,
            extractedJson: JSON.stringify(item),
          },
        }),
      );
    }

    const valveItem = savedItems.find((item) => /gate valve/i.test(item.description));
    expect(valveItem).toBeDefined();
    if (!valveItem) return;

    const sourcing = await runSourcingForItem(valveItem.id);
    expect(sourcing.offers).toBeGreaterThan(0);
    expect(sourcing.suppliers).toBe(1);
    const session = await db.searchSession.findFirst({
      where: { enquiryItemId: valveItem.id },
      orderBy: { startedAt: "desc" },
    });
    const summary = parseJson<Record<string, number>>(session?.summaryJson ?? "{}", {});
    expect(summary.exactMatches).toBe(1);
    expect(summary.suppliersWithEvidence).toBe(1);
    expect(summary.supplierCandidates).toBe(1);

    const draft = await createDraftSupplierQuoteRequest({
      supplierId: supplier.id,
      enquiryItemId: valveItem.id,
      userId: "system",
      actorLabel: "workflow-test",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const quote = await db.supplierQuote.findUnique({ where: { id: draft.quoteId } });
    expect(quote?.status).toBe("DRAFT");
    expect(quote?.messageBody).toMatch(/gate valve/i);
    expect(quote?.messageBody).toMatch(/40 pcs/);
    expect(quote?.messageBody).not.toMatch(/catalogue|catalog|internal|confidence|row \d+/i);
    expect((quote?.messageBody?.match(/gate valve/gi) ?? []).length).toBe(1);
    expect(quote?.messageBody).toMatch(/customer's requested delivery: 3 days/i);
    // The customer's 3-day requirement is not presented as a supplier lead time.
    expect(quote?.messageBody).not.toMatch(/lead time: 3 days/i);

    // Nothing is approved or sent automatically.
    expect(await db.approval.count({ where: { entityId: draft.quoteId } })).toBe(0);
    expect(await db.outboundMessage.count({ where: { relatedId: draft.quoteId } })).toBe(0);
  });
});
