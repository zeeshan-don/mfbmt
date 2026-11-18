import fs from "node:fs";
import path from "node:path";
import { db } from "../../src/lib/db";
import { recomputeOffersForItem } from "../../src/lib/costing/evaluate";
import { ensureSourcingApproval } from "../../src/lib/workflow/approvals";
import { FASTENER_DEMO_REFS } from "../../src/scripts/demo-fasteners";

/**
 * Creates isolated copies of the demo nut line for destructive browser tests.
 * The original ENQ-DEMO-FASTENER-* records are never touched. Each run removes
 * only the previous E2E copies, identified by their fixed public references.
 */
const REFS = {
  flow: "ENQ-E2E-VERIFY",
  auth: "ENQ-E2E-AUTH",
} as const;

async function removeOld(ref: string) {
  const existing = await db.enquiry.findUnique({ where: { publicRef: ref } });
  if (!existing) return;
  await db.customerQuotation.deleteMany({ where: { enquiryId: existing.id } });
  await db.approval.deleteMany({ where: { enquiryId: existing.id } });
  await db.enquiry.delete({ where: { id: existing.id } });
}

async function createClone(ref: string, customerName: string) {
  const source = await db.enquiry.findUnique({
    where: { publicRef: FASTENER_DEMO_REFS.rfq },
    include: { items: { include: { offers: true } } },
  });
  if (!source) throw new Error("Demo enquiry missing — run npm run db:seed with demo flags first.");
  const line = source.items.find((item) => item.lineNo === 2);
  if (!line) throw new Error("Demo nut line missing.");

  const enquiry = await db.enquiry.create({
    data: {
      publicRef: ref,
      channel: "DEMO",
      customerName,
      customerEmail: "e2e@example.test",
      rawText: line.description,
      currency: "AED",
      classification: "RFQ",
      classificationConfidence: 1,
      status: "AWAITING_APPROVAL",
      isDemo: true,
      items: {
        create: [
          {
            lineNo: 1,
            description: line.description,
            rawText: "Isolated E2E copy — original demo records are not modified.",
            category: line.category,
            size: line.size,
            material: line.material,
            grade: line.grade,
            standard: line.standard,
            unit: line.unit,
            quantity: line.quantity,
            quantityFromStock: line.quantityFromStock,
            quantityToSource: line.quantityToSource,
            inventoryStatus: line.inventoryStatus,
            sourcingStatus: "AWAITING_APPROVAL",
            reviewStatus: "CONFIRMED",
            missingFields: "[]",
            confidence: JSON.stringify({ description: 1, quantity: 1 }),
            sourceRef: "e2e copy",
            fastenerSpecJson: line.fastenerSpecJson,
            fastenerType: line.fastenerType,
            diameter: line.diameter,
            threadSeries: line.threadSeries,
            pitchMm: line.pitchMm,
            lengthMm: line.lengthMm,
            propertyClass: line.propertyClass,
            finish: line.finish,
            specSource: "MANUAL",
            specConfirmedAt: new Date(),
          },
        ],
      },
    },
    include: { items: true },
  });

  const item = enquiry.items[0];
  for (const offer of line.offers) {
    await db.supplierOffer.create({
      data: {
        enquiryItemId: item.id,
        supplierId: offer.supplierId,
        supplierName: offer.supplierName,
        productTitle: offer.productTitle,
        matchStatus: offer.matchStatus,
        unitPrice: offer.unitPrice,
        currency: offer.currency,
        moq: offer.moq,
        shippingCost: offer.shippingCost,
        otherCharges: offer.otherCharges,
        taxes: offer.taxes,
        leadTimeDays: offer.leadTimeDays,
        quantityAvailable: offer.quantityAvailable,
        validityDate: offer.validityDate,
        status: offer.status,
        sourceType: offer.sourceType,
        quotedAt: offer.quotedAt,
        quoteRef: `${offer.quoteRef}-${ref}`,
        verificationStatus: offer.verificationStatus,
        evidenceJson: offer.evidenceJson,
        offeredSpecJson: offer.offeredSpecJson,
        isDemo: true,
      },
    });
  }
  await recomputeOffersForItem(item.id);
  const approvalId = await ensureSourcingApproval(item.id);
  return { enquiryId: enquiry.id, itemId: item.id, approvalId, ref };
}

async function main() {
  await removeOld(REFS.flow);
  await removeOld(REFS.auth);
  const flow = await createClone(REFS.flow, "E2E Verification Customer (sample)");
  const auth = await createClone(REFS.auth, "E2E Authorization Customer (sample)");
  const demoNut = await db.supplierOffer.findFirst({
    where: { enquiryItem: { enquiry: { publicRef: FASTENER_DEMO_REFS.rfq } } },
    select: { enquiryItemId: true },
  });
  const fixture = {
    ...flow,
    authEnquiryId: auth.enquiryId,
    authItemId: auth.itemId,
    authApprovalId: auth.approvalId,
    demoNutItemId: demoNut?.enquiryItemId ?? null,
  };
  fs.mkdirSync(path.join(process.cwd(), "tmp-verify"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "tmp-verify", "e2e-fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
