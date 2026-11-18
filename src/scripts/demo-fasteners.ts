import type { PrismaClient } from "@prisma/client";
import { parseFastenerSpec } from "../lib/fasteners/spec";
import { recomputeOffersForItem } from "../lib/costing/evaluate";
import { ensureSourcingApproval } from "../lib/workflow/approvals";
import { generateAndStoreQuotationPdf } from "../lib/workflow/quotations";
import { writeAudit } from "../lib/audit";

/**
 * Fastener-owner walkthrough. All records are clearly labelled sample data.
 *
 * Idempotent: every row is created only when its stable identifier is missing.
 * Re-running never resets quantities, deletes offers or erases history, so the
 * walkthrough can be replayed safely during a live demo.
 */
export const FASTENER_DEMO_REFS = {
  rfq: "ENQ-DEMO-FASTENER-01",
  quoted: "ENQ-DEMO-FASTENER-02",
} as const;

const SUPPLIERS = [
  {
    name: "Gulf Fastener Supply (sample)",
    email: "quotes@gulf-fastener-sample.test",
    city: "Sharjah",
    phone: "+971500000021",
  },
  {
    name: "Desert Bolt Trading (sample)",
    email: "sales@desert-bolt-sample.test",
    city: "Dubai",
    phone: "+971500000022",
  },
  {
    name: "Emirates Fixings Co. (sample)",
    email: "rfq@emirates-fixings-sample.test",
    city: "Abu Dhabi",
    phone: "+971500000023",
  },
];

function specFrom(description: string) {
  return parseFastenerSpec({ description, rawText: description });
}

async function getOrCreateSupplier(db: PrismaClient, row: (typeof SUPPLIERS)[number]) {
  const existing = await db.supplier.findFirst({ where: { name: row.name } });
  if (existing) return existing;
  return db.supplier.create({
    data: {
      name: row.name,
      country: "UAE",
      city: row.city,
      email: row.email,
      phone: row.phone,
      categories: JSON.stringify(["Industrial Fasteners"]),
      notes: "Illustrative demo supplier. Not a real company; prices are sample figures.",
      status: "ACTIVE",
      isDemo: true,
      lastVerifiedAt: new Date(),
    },
  });
}

async function getOrCreateProduct(
  db: PrismaClient,
  input: { sku: string; name: string; specDescription: string; onHand: number; locationId: string },
) {
  const spec = specFrom(input.specDescription);
  const product = await db.product.upsert({
    where: { sku: input.sku },
    update: {}, // never overwrite owner edits or stock
    create: {
      sku: input.sku,
      name: input.name,
      category: "Industrial Fasteners",
      size: spec.diameter,
      material: spec.material,
      grade: spec.propertyClass,
      standard: spec.standard,
      unit: "pcs",
      isDemo: true,
      notes: "Sample stock row for the fastener walkthrough.",
      fastenerSpecJson: JSON.stringify(spec),
    },
  });
  const stock = await db.inventoryStock.findUnique({
    where: { productId_locationId: { productId: product.id, locationId: input.locationId } },
  });
  if (!stock) {
    await db.inventoryStock.create({
      data: {
        productId: product.id,
        locationId: input.locationId,
        quantityOnHand: input.onHand,
        quantityReserved: 0,
        source: "DEMO",
        lastUpdatedAt: new Date(),
      },
    });
  }
  return product;
}

export async function resetFastenerWalkthrough(db: PrismaClient) {
  const refs = Object.values(FASTENER_DEMO_REFS);
  const enquiries = await db.enquiry.findMany({
    where: { publicRef: { in: [...refs] }, isDemo: true },
    select: { id: true },
  });
  if (enquiries.length === 0) return { removed: 0 };
  const ids = enquiries.map((enquiry) => enquiry.id);
  // Scoped strictly to the walkthrough references, all of which are demo rows.
  await db.customerQuotation.deleteMany({ where: { enquiryId: { in: ids } } });
  await db.approval.deleteMany({ where: { enquiryId: { in: ids } } });
  await db.enquiry.deleteMany({ where: { id: { in: ids }, isDemo: true } });
  return { removed: ids.length };
}

export async function seedFastenerWalkthrough(db: PrismaClient): Promise<{ created: boolean }> {
  const owner = await db.user.findFirst({ where: { role: "OWNER" } });

  const location = await db.inventoryLocation.upsert({
    where: { code: "MAIN" },
    update: {},
    create: { code: "MAIN", name: "Main warehouse (sample)", isDemo: true },
  });

  const suppliers = [];
  for (const row of SUPPLIERS) suppliers.push(await getOrCreateSupplier(db, row));

  // One product with enough stock, one short, and the parts referenced by offers.
  await getOrCreateProduct(db, {
    sku: "DEMO-FAST-HB-M10-30-88Z",
    name: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated, carbon steel (sample)",
    specDescription:
      "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
    onHand: 500,
    locationId: location.id,
  });
  await getOrCreateProduct(db, {
    sku: "DEMO-FAST-HN-M12-175-8HDG",
    name: "Hex nut ISO 4032 M12 x 1.75, class 8, hot-dip galvanized, carbon steel (sample)",
    specDescription:
      "Hex nut ISO 4032 M12 x 1.75 class 8 hot-dip galvanized carbon steel",
    onHand: 100,
    locationId: location.id,
  });

  if (await db.enquiry.findUnique({ where: { publicRef: FASTENER_DEMO_REFS.rfq } })) {
    return { created: false };
  }

  const hexBoltSpec = specFrom(
    "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
  );
  const hexNutSpec = specFrom(
    "Hex nut ISO 4032 M12 x 1.75 class 8 hot-dip galvanized carbon steel",
  );
  const rodSpec = specFrom("Threaded rod M8 x 1.25 zinc plated carbon steel");

  const enquiry = await db.enquiry.create({
    data: {
      publicRef: FASTENER_DEMO_REFS.rfq,
      channel: "DEMO",
      customerName: "Al Reem Mechanical (sample)",
      customerPhone: "+971500000031",
      customerEmail: "buyer@alreem-mechanical-sample.test",
      rawText: [
        "Please quote the following fasteners. Sample request for the MFBMT walkthrough.",
        "1) 200 pcs Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated, carbon steel",
        "2) 300 pcs Hex nut ISO 4032 M12 x 1.75, class 8, hot-dip galvanized, carbon steel",
        "3) 50 pcs Threaded rod M8 x 1.25, 1 m, zinc plated, carbon steel",
      ].join("\n"),
      deliveryLocation: "Dubai",
      currency: "AED",
      classification: "RFQ",
      classificationConfidence: 1,
      status: "AWAITING_APPROVAL",
      isDemo: true,
      items: {
        create: [
          {
            lineNo: 1,
            description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated, carbon steel",
            rawText: "Sample line 1 (stock available)",
            category: "Industrial Fasteners",
            size: hexBoltSpec.diameter,
            material: hexBoltSpec.material,
            grade: hexBoltSpec.propertyClass,
            standard: hexBoltSpec.standard,
            unit: "pcs",
            quantity: 200,
            quantityFromStock: 200,
            quantityToSource: 0,
            inventoryStatus: "AVAILABLE",
            sourcingStatus: "NOT_REQUIRED",
            reviewStatus: "CONFIRMED",
            missingFields: "[]",
            confidence: JSON.stringify({ description: 1, quantity: 1 }),
            sourceRef: "sample line 1",
            fastenerSpecJson: JSON.stringify(hexBoltSpec),
            fastenerType: hexBoltSpec.type,
            diameter: hexBoltSpec.diameter,
            threadSeries: hexBoltSpec.threadSeries,
            pitchMm: hexBoltSpec.pitchMm,
            lengthMm: hexBoltSpec.lengthMm,
            propertyClass: hexBoltSpec.propertyClass,
            finish: hexBoltSpec.finish,
            specSource: "MANUAL",
            specConfirmedAt: new Date(),
          },
          {
            lineNo: 2,
            description: "Hex nut ISO 4032 M12 x 1.75, class 8, hot-dip galvanized, carbon steel",
            rawText: "Sample line 2 (short — sourcing required)",
            category: "Industrial Fasteners",
            size: hexNutSpec.diameter,
            material: hexNutSpec.material,
            grade: hexNutSpec.propertyClass,
            standard: hexNutSpec.standard,
            unit: "pcs",
            quantity: 300,
            quantityFromStock: 100,
            quantityToSource: 200,
            inventoryStatus: "PARTIAL",
            sourcingStatus: "AWAITING_APPROVAL",
            reviewStatus: "CONFIRMED",
            missingFields: "[]",
            confidence: JSON.stringify({ description: 1, quantity: 1 }),
            sourceRef: "sample line 2",
            fastenerSpecJson: JSON.stringify(hexNutSpec),
            fastenerType: hexNutSpec.type,
            diameter: hexNutSpec.diameter,
            threadSeries: hexNutSpec.threadSeries,
            pitchMm: hexNutSpec.pitchMm,
            lengthMm: null,
            propertyClass: hexNutSpec.propertyClass,
            finish: hexNutSpec.finish,
            specSource: "MANUAL",
            specConfirmedAt: new Date(),
          },
          {
            lineNo: 3,
            description: "Threaded rod M8 x 1.25, 1 m, zinc plated, carbon steel",
            rawText: "Sample line 3 (missing details)",
            category: "Industrial Fasteners",
            size: rodSpec.diameter,
            material: rodSpec.material,
            grade: null,
            standard: null,
            unit: "pcs",
            quantity: 50,
            quantityFromStock: 0,
            quantityToSource: 0,
            inventoryStatus: "CLARIFY",
            sourcingStatus: "NOT_STARTED",
            reviewStatus: "NEEDS_CLARIFICATION",
            missingFields: JSON.stringify(["Length", "Property class"]),
            clarificationQuestion: "Please confirm the length in mm and the property class for this threaded rod.",
            confidence: JSON.stringify({ description: 1, quantity: 1 }),
            sourceRef: "sample line 3",
            fastenerSpecJson: JSON.stringify(rodSpec),
            fastenerType: rodSpec.type,
            diameter: rodSpec.diameter,
            threadSeries: rodSpec.threadSeries,
            pitchMm: rodSpec.pitchMm,
            lengthMm: null,
            propertyClass: null,
            finish: rodSpec.finish,
            specSource: "EXTRACTED",
          },
        ],
      },
    },
    include: { items: true },
  });

  const nutLine = enquiry.items.find((item) => item.lineNo === 2)!;
  const offerRows = [
    {
      supplier: suppliers[0],
      title: "Hex nut ISO 4032 M12 x 1.75 class 8 HDG carbon steel (sample)",
      description: "Cheapest unit price but a very high minimum order quantity. Sample figures.",
      unitPrice: 1.1,
      moq: 5000,
      shippingCost: 0,
      otherCharges: 0,
      leadTimeDays: 3,
      matchStatus: "EXACT",
      quoteRef: "SAMPLE-FAST-101",
    },
    {
      supplier: suppliers[1],
      title: "Hex nut ISO 4032 M12 x 1.75 class 8 HDG carbon steel (sample)",
      description: "Low unit price with freight not stated, so the landed cost is incomplete.",
      unitPrice: 0.95,
      moq: 1,
      shippingCost: null,
      otherCharges: null,
      leadTimeDays: 5,
      matchStatus: "EXACT",
      quoteRef: "SAMPLE-FAST-102",
    },
    {
      supplier: suppliers[2],
      title: "Hex nut ISO 4032 M12 x 1.75 class 8 hot-dip galvanized carbon steel (sample)",
      description: "Technically exact and fully costed. Sample figures, not a live quotation.",
      unitPrice: 1.35,
      moq: 100,
      shippingCost: 60,
      otherCharges: 0,
      leadTimeDays: 4,
      matchStatus: "EXACT",
      quoteRef: "SAMPLE-FAST-103",
    },
    {
      supplier: suppliers[0],
      title: "Hex nut M12 class 10.9 zinc plated (sample)",
      description: "Superficially cheap, but the property class and finish are wrong.",
      unitPrice: 0.85,
      moq: 1,
      shippingCost: 40,
      otherCharges: 0,
      leadTimeDays: 2,
      matchStatus: "NO_MATCH",
      quoteRef: "SAMPLE-FAST-104",
    },
  ];

  for (const row of offerRows) {
    const offeredSpec = specFrom(row.title);
    const already = await db.supplierOffer.findFirst({
      where: { enquiryItemId: nutLine.id, quoteRef: row.quoteRef },
    });
    if (already) continue;
    await db.supplierOffer.create({
      data: {
        enquiryItemId: nutLine.id,
        supplierId: row.supplier.id,
        supplierName: row.supplier.name,
        productTitle: row.title,
        matchStatus: row.matchStatus,
        unitPrice: row.unitPrice,
        currency: "AED",
        moq: row.moq,
        shippingCost: row.shippingCost,
        otherCharges: row.otherCharges,
        taxes: null,
        leadTimeDays: row.leadTimeDays,
        quantityAvailable: 2000,
        validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        status: "PRICE_CONFIRMED",
        sourceType: "MANUAL",
        quotedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        quoteRef: row.quoteRef,
        verificationStatus: "VERIFIED",
        evidenceJson: JSON.stringify({
          note: "Sample offer for the walkthrough. Figures are illustrative, not market quotations.",
          supplierConfirmed: true,
          confirmedAt: new Date().toISOString(),
          reasons:
            row.matchStatus === "EXACT"
              ? ["Diameter, pitch, property class and finish verified against the request."]
              : ["Property class and finish differ from the request."],
        }),
        offeredSpecJson: JSON.stringify(offeredSpec),
        isDemo: true,
      },
    });
  }

  await recomputeOffersForItem(nutLine.id);
  await ensureSourcingApproval(nutLine.id);
  await writeAudit({
    action: "demo.fastener_walkthrough_created",
    entityType: "Enquiry",
    entityId: enquiry.id,
    actorLabel: "seed",
    meta: { sample: true },
  });

  await seedQuotedDemo(db, owner?.id ?? null);
  return { created: true };
}

async function seedQuotedDemo(db: PrismaClient, ownerId: string | null) {
  if (await db.enquiry.findUnique({ where: { publicRef: FASTENER_DEMO_REFS.quoted } })) return;

  const boltSpec = specFrom(
    "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
  );
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: FASTENER_DEMO_REFS.quoted,
      channel: "DEMO",
      customerName: "Marina Maintenance LLC (sample)",
      customerEmail: "purchase@marina-maintenance-sample.test",
      customerPhone: "+971500000032",
      rawText: "Sample request: 100 pcs Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated.",
      deliveryLocation: "Dubai",
      currency: "AED",
      classification: "RFQ",
      classificationConfidence: 1,
      status: "QUOTED",
      isDemo: true,
      items: {
        create: [
          {
            lineNo: 1,
            description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated, carbon steel",
            category: "Industrial Fasteners",
            size: boltSpec.diameter,
            material: boltSpec.material,
            grade: boltSpec.propertyClass,
            standard: boltSpec.standard,
            unit: "pcs",
            quantity: 100,
            quantityFromStock: 100,
            quantityToSource: 0,
            inventoryStatus: "AVAILABLE",
            sourcingStatus: "NOT_REQUIRED",
            reviewStatus: "CONFIRMED",
            missingFields: "[]",
            confidence: JSON.stringify({ description: 1, quantity: 1 }),
            sourceRef: "sample",
            fastenerSpecJson: JSON.stringify(boltSpec),
            fastenerType: boltSpec.type,
            diameter: boltSpec.diameter,
            threadSeries: boltSpec.threadSeries,
            pitchMm: boltSpec.pitchMm,
            lengthMm: boltSpec.lengthMm,
            propertyClass: boltSpec.propertyClass,
            finish: boltSpec.finish,
            specSource: "MANUAL",
            specConfirmedAt: new Date(),
          },
        ],
      },
    },
    include: { items: true },
  });

  const line = enquiry.items[0];
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      quoteNumber: `DEMO-QT-${Date.now().toString().slice(-6)}`,
      version: 1,
      customerName: enquiry.customerName ?? "Sample customer",
      customerPhone: enquiry.customerPhone,
      customerEmail: enquiry.customerEmail,
      currency: "AED",
      subtotal: 325,
      taxAmount: 16.25,
      total: 341.25,
      internalCostTotal: 240,
      internalCostComplete: true,
      terms: "Sample quotation for demonstration only. Not a valid commercial offer.",
      validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: "APPROVED",
      approvedById: ownerId,
      approvedAt: new Date(),
      isDemo: true,
      items: {
        create: [
          {
            description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated",
            specs: "Hex bolt · M10 · Metric coarse · pitch 1.5 mm · 30 mm long · MS · class 8.8 · Zinc plated · ISO 4017",
            quantity: 100,
            unit: "pcs",
            costPrice: 2.4,
            unitPrice: 3.25,
            lineTotal: 325,
            priceStatus: "PRICED",
            costStatus: "COMPLETE",
            pricingSource: "OWNER_OVERRIDE",
            stockQuantity: 100,
            procureQuantity: 0,
            stockUnitCost: 2.4,
            costIncomplete: false,
            enquiryItemId: line.id,
          },
        ],
      },
    },
  });

  await db.approval.createMany({
    data: [
      {
        type: "CUSTOMER_QUOTATION",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        enquiryId: enquiry.id,
        status: "APPROVED",
        requestedBy: "SYSTEM",
        decidedById: ownerId,
        decidedAt: new Date(),
        reason: "Sample approval for the demo walkthrough.",
        payloadJson: JSON.stringify({ quoteNumber: quotation.quoteNumber, sample: true, total: 341.25 }),
      },
    ],
    skipDuplicates: true,
  });

  try {
    await generateAndStoreQuotationPdf(quotation.id);
  } catch (error) {
    console.warn("[seed] sample quotation PDF could not be generated:", error instanceof Error ? error.message : error);
  }
}
