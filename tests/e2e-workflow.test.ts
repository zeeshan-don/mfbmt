import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as whatsappPOST, GET as whatsappGET } from "../src/app/api/webhooks/whatsapp/route";
import { hmacSignature } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/auth";
import { processInboundMessage, extractEnquiryById, checkEnquiryInventory } from "../src/lib/workflow/enquiry";
import { recomputeOffersForItem } from "../src/lib/costing/evaluate";
import { ensureSourcingApproval, decideApproval } from "../src/lib/workflow/approvals";
import {
  createQuotationDraft,
  generateAndStoreQuotationPdf,
  sendApprovedQuotation,
} from "../src/lib/workflow/quotations";

const APP_SECRET = "test-app-secret";
const PHONE_ID = "PNID-E2E";

function whatsappPayload(input: { id: string; from: string; body: string; toPhoneNumberId?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-E2E",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "971500000000", phone_number_id: input.toPhoneNumberId ?? PHONE_ID },
              messages: [
                {
                  from: input.from,
                  id: input.id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: input.body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function deliver(payload: unknown, options: { badSignature?: boolean; path?: string } = {}) {
  const raw = JSON.stringify(payload);
  const signature = options.badSignature ? hmacSignature("wrong-secret", raw) : hmacSignature(APP_SECRET, raw);
  const request = new Request(`http://localhost:3000/api/webhooks/whatsapp${options.path ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  return whatsappPOST(request);
}

async function resetDatabase() {
  await db.webhookEvent.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.approval.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.supplierQuoteItem.deleteMany();
  await db.supplierQuote.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.attachment.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.contact.deleteMany();
  await db.excludedContact.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.inventoryStock.deleteMany();
  await db.inventoryLocation.deleteMany();
  await db.materialEquivalence.deleteMany();
  await db.product.deleteMany();
  await db.supplierProduct.deleteMany();
  await db.supplier.deleteMany();
  await db.pricingRule.deleteMany();
  // Organizations are provisioned by the migration and never deleted by tests:
  // deleting them would cascade every tenant and destroy the isolation fixtures.
  await db.session.deleteMany();
  await db.user.deleteMany();
  await db.integration.deleteMany();
}

async function seedBasics() {
  await db.organization.update({
    where: { id: "org_mfbmt" },
    data: {
      name: "Test Trading LLC",
      defaultCurrency: "AED",
      taxEnabled: true,
      taxRatePct: 5,
      taxLabel: "VAT",
      quotationValidityDays: 14,
      inventoryMode: "STOCK_FIRST",
    },
  });
  // The webhook routes by the receiving WhatsApp Phone Number ID, so this
  // tenant must own a connected WhatsApp integration for the fixture number.
  const { ensureIntegrations, saveIntegration } = await import("../src/lib/integrations/store");
  await ensureIntegrations();
  await saveIntegration({
    key: "WHATSAPP",
    status: "CONNECTED",
    accountLabel: "E2E test number",
    secrets: { ACCESS_TOKEN: "e2e-token", WABA_ID: "WABA-E2E", PHONE_NUMBER_ID: PHONE_ID },
  });
  await db.pricingRule.create({
    data: { scope: "GLOBAL", category: null, type: "PERCENT_MARKUP", value: 20, priority: 100, isActive: true },
  });
  const location = await db.inventoryLocation.create({ data: { code: "E2E", name: "Test store" } });
  const product = await db.product.create({
    data: {
      sku: "E2E-ELB-316-1",
      name: "Stainless Steel Elbow 90° 1 inch SS316",
      category: "Pipe Fittings",
      size: "1 inch",
      material: "SS316",
      unit: "pcs",
    },
  });
  await db.inventoryStock.create({
    data: { productId: product.id, locationId: location.id, quantityOnHand: 6, quantityReserved: 0, lastUpdatedAt: new Date() },
  });
  return { product, location };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("end-to-end procurement workflow", () => {
  it("verifies the Meta webhook challenge and rejects an unsigned delivery", async () => {
    const verified = await whatsappGET(
      new Request(
        "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123",
      ),
    );
    expect(verified.status).toBe(200);
    expect(await verified.text()).toBe("challenge-123");

    const forged = await deliver(whatsappPayload({ id: "wamid.forged", from: "971500000301", body: "quote please" }), {
      badSignature: true,
    });
    expect(forged.status).toBe(401);
    expect(await db.message.count()).toBe(0);
  });

  it("runs a genuine WhatsApp RFQ from webhook to a released customer quotation", async () => {
    await seedBasics();
    const owner = await db.user.create({
      data: {
        email: "owner-e2e@example.com",
        name: "E2E Owner",
        passwordHash: await hashPassword("Str0ng-Enough-2026"),
        role: "OWNER",
      },
    });

    const externalId = `wamid.${randomUUID()}`;
    const response = await deliver(
      whatsappPayload({ id: externalId, from: "971500000301", body: "Please quote 20 pcs SS316 elbow, 1 inch." }),
    );
    expect(response.status).toBe(200);

    // Durable receipt exists before the work is done.
    expect(await db.webhookEvent.count({ where: { externalId } })).toBe(1);
    const message = await db.message.findFirst({ where: { externalMessageId: externalId } });
    expect(message).not.toBeNull();
    expect(message?.processingStatus).not.toBe("IGNORED");

    // A repeated delivery of the same message must not create a second record.
    await deliver(whatsappPayload({ id: externalId, from: "971500000301", body: "Please quote 20 pcs SS316 elbow, 1 inch." }));
    expect(await db.message.count({ where: { externalMessageId: externalId } })).toBe(1);

    const processed = await processInboundMessage(message!.id);
    expect(processed.enquiryId).toBeTruthy();
    const enquiryId = processed.enquiryId!;
    const enquiry = await db.enquiry.findUnique({ where: { id: enquiryId } });
    expect(enquiry?.classification).toBe("RFQ");

    const extraction = await extractEnquiryById(enquiryId);
    expect(extraction.items).toBe(1);
    const items = await db.enquiryItem.findMany({ where: { enquiryId } });
    expect(items).toHaveLength(1);
    expect(items[0].description.toLowerCase()).toContain("elbow");
    expect(items[0].quantity).toBe(20);
    expect(items[0].unit).toBe("pcs");
    expect(items[0].size?.toLowerCase()).toContain("1");
    expect(items[0].material?.toUpperCase().replace(/[^A-Z0-9]/g, "")).toBe("SS316");

    // Stock: 6 on hand of 20 requested → 14 must be sourced, not 20.
    await checkEnquiryInventory(enquiryId);
    const checked = await db.enquiryItem.findUnique({ where: { id: items[0].id } });
    expect(checked?.inventoryStatus).toBe("PARTIAL");
    expect(checked?.quantityFromStock).toBe(6);
    expect(checked?.quantityToSource).toBe(14);

    // Supplier offers: exact, wrong material, high MOQ, unknown freight.
    const exact = await db.supplierOffer.create({
      data: {
        enquiryItemId: items[0].id,
        supplierName: "Exact Supplier",
        productTitle: "SS316 elbow 1 inch 90 degree",
        matchStatus: "EXACT",
        unitPrice: 12,
        currency: "AED",
        shippingCost: 20,
        otherCharges: 0,
        taxes: 0,
        leadTimeDays: 2,
        quantityAvailable: 100,
        validityDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: "PRICE_CONFIRMED",
        sourceType: "MANUAL",
        quotedAt: new Date(),
        verificationStatus: "VERIFIED",
      },
    });
    const wrongMaterial = await db.supplierOffer.create({
      data: {
        enquiryItemId: items[0].id,
        supplierName: "Wrong Material",
        productTitle: "SS304 elbow 1 inch",
        matchStatus: "NO_MATCH",
        unitPrice: 10,
        currency: "AED",
        shippingCost: 0,
        otherCharges: 0,
        taxes: 0,
        leadTimeDays: 2,
        quantityAvailable: 100,
        status: "PRICE_CONFIRMED",
        sourceType: "MANUAL",
        quotedAt: new Date(),
        verificationStatus: "PARTIAL",
      },
    });
    const highMoq = await db.supplierOffer.create({
      data: {
        enquiryItemId: items[0].id,
        supplierName: "High MOQ",
        productTitle: "SS316 elbow 1 inch",
        matchStatus: "EXACT",
        unitPrice: 8,
        currency: "AED",
        moq: 50,
        shippingCost: 0,
        otherCharges: 0,
        taxes: 0,
        leadTimeDays: 3,
        quantityAvailable: 100,
        status: "PRICE_CONFIRMED",
        sourceType: "MANUAL",
        quotedAt: new Date(),
        verificationStatus: "VERIFIED",
      },
    });
    const unknownFreight = await db.supplierOffer.create({
      data: {
        enquiryItemId: items[0].id,
        supplierName: "Unknown Freight",
        productTitle: "SS316 elbow 1 inch",
        matchStatus: "EXACT",
        unitPrice: 9,
        currency: "AED",
        shippingCost: null,
        otherCharges: 0,
        taxes: 0,
        leadTimeDays: 3,
        status: "PRICE_CONFIRMED",
        sourceType: "MANUAL",
        quotedAt: new Date(),
        verificationStatus: "UNVERIFIED",
      },
    });

    const evaluation = await recomputeOffersForItem(items[0].id);
    expect(evaluation.requiredQuantity).toBe(14);

    const byId = new Map(evaluation.ranked.map((entry) => [entry.offer.id, entry]));
    // 14 × 12 + 20 = 188 landed; the cheapest complete option.
    expect(byId.get(exact.id)?.offer.landed.total).toBe(188);
    expect(byId.get(exact.id)?.rank).toBe(1);
    // 50 × 8 = 400 outlay, disclosed as overbuy, ranked after the cheaper outlay.
    expect(byId.get(highMoq.id)?.offer.landed.total).toBe(400);
    expect(byId.get(highMoq.id)?.evaluation.overbuy?.excessQuantity).toBe(36);
    expect(byId.get(highMoq.id)?.rank).toBe(2);
    // Unknown freight keeps the total unknown: never presented as cheapest.
    expect(byId.get(unknownFreight.id)?.offer.landed.complete).toBe(false);
    expect(byId.get(unknownFreight.id)?.offer.landed.total).toBeNull();
    expect(byId.get(unknownFreight.id)?.evaluation.rankable).toBe(false);
    // Wrong material is never eligible.
    expect(byId.get(wrongMaterial.id)?.evaluation.eligible).toBe(false);

    const approvalId = await ensureSourcingApproval(items[0].id);
    expect(approvalId).toBeTruthy();
    const sourcingDecision = await decideApproval({
      approvalId: approvalId!,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.name,
      selectedOfferId: exact.id,
    });
    expect(sourcingDecision.ok).toBe(true);

    // A second decision on the same approval is refused (concurrent double submit).
    const second = await decideApproval({
      approvalId: approvalId!,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.name,
      selectedOfferId: exact.id,
    });
    expect(second.ok).toBe(false);

    const draft = await createQuotationDraft({ enquiryId, userId: owner.id, actorLabel: owner.name });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const quotation = await db.customerQuotation.findUnique({
      where: { id: draft.quotationId },
      include: { items: true },
    });
    // 14 × 12 + 20 = 188 total procurement outlay for 14 sourced units.
    // The known outlay is allocated across all 20 customer units (188 / 20 = 9.40),
    // then the configured 20% markup is applied: 11.28/unit, 225.60 line total.
    const line = quotation!.items[0];
    expect(line.stockQuantity).toBe(6);
    expect(line.procureQuantity).toBe(14);
    expect(line.quantity).toBe(20);
    expect(line.procureUnitCost).toBeCloseTo(13.43, 2);
    expect(line.unitPrice).toBeCloseTo(11.28, 2);
    expect(line.lineTotal).toBeCloseTo(225.6, 2);
    expect(quotation!.subtotal).toBeCloseTo(225.6, 2);
    expect(quotation!.taxAmount).toBeCloseTo(11.28, 2);
    expect(quotation!.total).toBeCloseTo(236.88, 2);
    // Revenue covers the procurement outlay plus the configured markup.
    expect(quotation!.subtotal).toBeGreaterThan(188);
    // Stock has no recorded acquisition cost, so internal cost is not claimed as complete.
    expect(line.costIncomplete).toBe(true);
    expect(quotation!.internalCostComplete).toBe(false);
    expect(quotation!.total).toBeCloseTo(quotation!.subtotal + quotation!.taxAmount, 2);

    // Customer quotation needs its own approval.
    const quotationApproval = await db.approval.findFirst({
      where: { type: "CUSTOMER_QUOTATION", entityId: quotation!.id, status: "PENDING" },
    });
    expect(quotationApproval).not.toBeNull();

    const releasedTooEarly = await sendApprovedQuotation({
      quotationId: quotation!.id,
      channel: "MANUAL",
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(releasedTooEarly.ok).toBe(false);

    // The customer PDF is only produced from an approved quotation.
    const pdfBeforeApproval = await generateAndStoreQuotationPdf(quotation!.id);
    expect(pdfBeforeApproval.ok).toBe(false);

    const quotationDecision = await decideApproval({
      approvalId: quotationApproval!.id,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(quotationDecision.ok).toBe(true);

    const pdf = await generateAndStoreQuotationPdf(quotation!.id);
    if (!pdf.ok) console.error("PDF generation failed:", pdf.error);
    expect(pdf.ok).toBe(true);

    const sent = await sendApprovedQuotation({
      quotationId: quotation!.id,
      channel: "MANUAL",
      manualNote: "Printed and handed to the customer in the office",
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(sent.ok).toBe(true);

    const released = await db.customerQuotation.findUnique({ where: { id: quotation!.id } });
    expect(released?.status).toBe("SENT");
    expect(released?.sentChannel).toBe("MANUAL");
    expect(released?.sentAt).not.toBeNull();
    expect(released?.pdfPath).toBeTruthy();
    const refreshedEnquiry = await db.enquiry.findUnique({ where: { id: enquiryId } });
    expect(refreshedEnquiry?.status).toBe("QUOTED");
  });

  it("never stores, classifies or queues an excluded family message", async () => {
    await seedBasics();
    await db.excludedContact.create({
      data: { identifier: "+971500000099", category: "FAMILY", label: "Brother" },
    });

    const externalId = `wamid.${randomUUID()}`;
    const response = await deliver(
      whatsappPayload({ id: externalId, from: "971500000099", body: "Happy birthday, dinner at 8?" }),
    );
    expect(response.status).toBe(200);

    const message = await db.message.findFirst({ where: { externalMessageId: externalId } });
    expect(message?.processingStatus).toBe("IGNORED");
    expect(message?.body ?? "").toBe("");
    expect(message?.subject).toBeNull();
    expect(await db.attachment.count({ where: { messageId: message!.id } })).toBe(0);
    expect(await db.enquiry.count()).toBe(0);
    expect(await db.backgroundJob.count()).toBe(0);
  });

  it("routes an ambiguous message from an unknown sender to review without searching suppliers", async () => {
    await seedBasics();
    const externalId = `wamid.${randomUUID()}`;
    const response = await deliver(
      whatsappPayload({ id: externalId, from: "971500000777", body: "Bro, are we still meeting tomorrow at the cafe?" }),
    );
    expect(response.status).toBe(200);

    const message = await db.message.findFirst({ where: { externalMessageId: externalId } });
    await processInboundMessage(message!.id);
    const reloaded = await db.message.findFirst({ where: { externalMessageId: externalId } });
    expect(["UNCLEAR", "OTHER", "PERSONAL"]).toContain(reloaded?.classification);

    const enquiry = await db.enquiry.findFirst({ where: { conversationId: reloaded!.conversationId } });
    if (enquiry) expect(enquiry.requiresReview).toBe(true);
    expect(await db.backgroundJob.count({ where: { type: "RUN_SOURCING" } })).toBe(0);
    expect(await db.customerQuotation.count()).toBe(0);
  });
});
