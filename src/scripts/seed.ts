import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { ingestInboundMessage, processInboundMessage, extractEnquiryById } from "../lib/workflow/enquiry";
import { runNextJob } from "../lib/workflow/process";
import { recomputeOffersForItem } from "../lib/costing/evaluate";
import { ensureSourcingApproval } from "../lib/workflow/approvals";
import { writeAudit } from "../lib/audit";
import { seedFastenerWalkthrough } from "./demo-fasteners";
import { demoSeedProblem } from "../lib/demo-guard";

const db = new PrismaClient();

const DEMO_PASSWORD = "ChangeMe123!";

async function main() {
  // Hard production guard. Demo data is only allowed in local development and
  // automated tests, and only when the operator has explicitly opted in.
  const problem = demoSeedProblem(process.env);
  if (problem) throw new Error(problem);

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const owner = await db.user.upsert({
    where: { email: "owner@mfbmt.local" },
    update: {},
    create: {
      email: "owner@mfbmt.local",
      name: "MFBMT Owner",
      passwordHash,
      role: "OWNER",
      isActive: true,
    },
  });

  await db.user.upsert({
    where: { email: "staff@mfbmt.local" },
    update: {},
    create: {
      email: "staff@mfbmt.local",
      name: "Procurement Assistant",
      passwordHash,
      role: "STAFF",
      permissions: JSON.stringify(["enquiries.view", "enquiries.review", "sourcing.view", "inventory.view", "suppliers.view"]),
      isActive: true,
    },
  });

  const org = await db.organization.findFirst();
  if (!org) {
    await db.organization.create({
      data: {
        name: "Multi Fasteners Building Materials Trading LLC",
        legalName: "Multi Fasteners Building Materials Trading LLC",
        address: "Industrial Area, Dubai, United Arab Emirates",
        defaultCurrency: "AED",
        quotationValidityDays: 14,
        taxEnabled: true,
        taxRatePct: 5,
        taxLabel: "VAT",
      },
    });
  }

  // Never delete a pricing rule the owner may have edited; add the default once.
  const existingRule = await db.pricingRule.findFirst({ where: { scope: "GLOBAL", isActive: true } });
  if (!existingRule) {
    await db.pricingRule.create({
      data: { scope: "GLOBAL", type: "PERCENT_MARKUP", value: 18, priority: 100, isActive: true },
    });
  }

  const main = await db.inventoryLocation.upsert({
    where: { code: "MAIN" },
    update: {},
    create: { code: "MAIN", name: "Main warehouse (sample)", isDemo: true },
  });

  const hammer = await db.product.upsert({
    where: { sku: "DEMO-HAMMER-001" },
    update: {},
    create: {
      sku: "DEMO-HAMMER-001",
      name: "Claw hammer 16 oz (sample)",
      category: "Tools & General Supplies",
      unit: "pcs",
      isDemo: true,
      notes: "Sample inventory record. Replace with real stock.",
    },
  });
  const elbow = await db.product.upsert({
    where: { sku: "DEMO-SS316-ELB-1" },
    update: {},
    create: {
      sku: "DEMO-SS316-ELB-1",
      name: "Stainless Steel Elbow 90° 1 inch SS316 (sample)",
      category: "Pipe Fittings",
      size: "1 inch",
      material: "SS316",
      unit: "pcs",
      isDemo: true,
    },
  });
  const valveStock = await db.product.upsert({
    where: { sku: "DEMO-VALVE-1-316" },
    update: {},
    create: {
      sku: "DEMO-VALVE-1-316",
      name: "Gate Valve 1 inch SS316 Class 150 (sample)",
      category: "Valves",
      size: "1 inch",
      material: "SS316",
      pressureRating: "Class 150",
      unit: "pcs",
      isDemo: true,
    },
  });

  const stockRows: Array<{ productId: string; quantity: number }> = [
    { productId: hammer.id, quantity: 6 },
    { productId: elbow.id, quantity: 20 },
    { productId: valveStock.id, quantity: 0 },
  ];
  for (const row of stockRows) {
    // Re-running the seed must not reset a quantity the owner has corrected.
    await db.inventoryStock.upsert({
      where: { productId_locationId: { productId: row.productId, locationId: main.id } },
      update: {},
      create: {
        productId: row.productId,
        locationId: main.id,
        quantityOnHand: row.quantity,
        quantityReserved: 0,
        source: "DEMO",
      },
    });
  }

  const suppliers = [
    {
      name: "Gulf Piping Supplies (sample)",
      country: "UAE",
      city: "Sharjah",
      email: "sales@gulf-piping-sample.test",
      phone: "+971500000001",
      whatsapp: "+971500000001",
      categories: ["Pipe Fittings", "Valves"],
      notes: "Sample supplier used in the demo. Not a real company.",
    },
    {
      name: "Emirates Valve Trading (sample)",
      country: "UAE",
      city: "Dubai",
      email: "quotes@emirates-valve-sample.test",
      phone: "+971500000002",
      categories: ["Valves"],
      notes: "Sample supplier used in the demo. Not a real company.",
    },
    {
      name: "Al Noor Industrial (sample)",
      country: "UAE",
      city: "Abu Dhabi",
      email: "sales@alnoor-industrial-sample.test",
      phone: "+971500000003",
      categories: ["Valves", "Flanges"],
      notes: "Sample supplier used in the demo. Not a real company.",
    },
  ];

  const supplierIds: string[] = [];
  for (const supplier of suppliers) {
    const existing = await db.supplier.findFirst({ where: { name: supplier.name } });
    const record =
      existing ??
      (await db.supplier.create({
        data: {
          name: supplier.name,
          country: supplier.country,
          city: supplier.city,
          email: supplier.email,
          phone: supplier.phone,
          whatsapp: supplier.whatsapp ?? null,
          categories: JSON.stringify(supplier.categories),
          notes: supplier.notes,
          status: "ACTIVE",
          isDemo: true,
          lastVerifiedAt: new Date(),
        },
      }));
    supplierIds.push(record.id);
  }

  const catalogueRows = [
    {
        supplierId: supplierIds[0],
        title: "Gate Valve 1 inch SS316 Class 150 — threaded",
        description: "Stainless steel gate valve, 1 inch, SS316 body, Class 150, threaded ends. Sample listing.",
        sku: "GV-1-316-150",
        specs: JSON.stringify({ size: "1 inch", material: "SS316", pressureRating: "Class 150", standard: "ASME B16.34" }),
        unitPrice: 148,
        currency: "AED",
        moq: 1,
        availability: "Ex-stock (sample)",
        lastSeenAt: new Date(),
        isDemo: true,
      },
      {
        supplierId: supplierIds[1],
        title: "Stainless Steel Gate Valve 1in 316 Class 150",
        description: "Sample listing with a low unit price but a large minimum order quantity.",
        specs: JSON.stringify({ size: "1 inch", material: "SS316", pressureRating: "Class 150" }),
        unitPrice: 132,
        currency: "AED",
        moq: 50,
        availability: "In stock (sample)",
        lastSeenAt: new Date(),
        isDemo: true,
      },
  ];

  // Catalogue rows are inserted once and then left alone: re-seeding must not
  // destroy a supplier price or note added by the owner.
  for (const row of catalogueRows) {
    const exists = await db.supplierProduct.findFirst({
      where: { supplierId: row.supplierId, title: row.title },
      select: { id: true },
    });
    if (!exists) await db.supplierProduct.create({ data: row });
  }

  await db.excludedContact.upsert({
    where: { identifier: "+971500000099" },
    update: {},
    create: {
      identifier: "+971500000099",
      label: "Family member (sample)",
      category: "FAMILY",
      reason: "Personal number used to demonstrate exclusion from sourcing.",
    },
  });

  const classicMessageId = "demo-inbound-classic-1";
  const classicEnquiryRef = `ENQ-${new Date().getFullYear()}-9002`;
  await writeAudit({ action: "demo.seed_started", entityType: "System", entityId: "seed", actorLabel: "seed" });

  // Each classic demo record is checked by its stable identity, so re-running the
  // seed never duplicates it and never skips one that is missing.
  if (!(await db.message.findUnique({ where: { externalMessageId: classicMessageId } }))) {
    // Enquiry A — the exact scenario from the brief (ambiguous hammer and valve).
    const messageA = await ingestInboundMessage({
      channel: "WHATSAPP",
      externalMessageId: classicMessageId,
      from: "+971500000010",
      fromName: "Al Noor Contracting (sample)",
      body: "Please quote:\n10 hammers\n20 pcs SS316 elbow 1 inch\n5 industrial valves",
      receivedAt: new Date(Date.now() - 45 * 60 * 1000),
    });
    await processInboundMessage(messageA.messageId);
    const enquiryA = await db.message.findUnique({ where: { id: messageA.messageId }, select: { enquiryId: true } });
    if (enquiryA?.enquiryId) {
      await db.enquiry.update({ where: { id: enquiryA.enquiryId }, data: { isDemo: true } });
      await extractEnquiryById(enquiryA.enquiryId);
      await db.enquiryItem.updateMany({ where: { enquiryId: enquiryA.enquiryId }, data: { reviewStatus: "NEEDS_CLARIFICATION" } });
    }

  }

  if (!(await db.enquiry.findUnique({ where: { publicRef: classicEnquiryRef } }))) {
    // Enquiry B — a complete specification so the supplier comparison has data.
    const enquiryB = await db.enquiry.create({
      data: {
        publicRef: classicEnquiryRef,
        channel: "EMAIL",
        customerName: "Emirates Facilities Co. (sample)",
        customerEmail: "buyer@emirates-facilities-sample.test",
        customerPhone: "+971500000011",
        rawText: "Kindly quote 5 pcs gate valve 1 inch SS316 Class 150. Delivery to Dubai.",
        deliveryLocation: "Dubai",
        currency: "AED",
        classification: "RFQ",
        classificationConfidence: 0.95,
        status: "AWAITING_APPROVAL",
        isDemo: true,
        items: {
          create: [
            {
              lineNo: 1,
              description: "Gate valve 1 inch SS316 Class 150",
              category: "Valves",
              size: "1 inch",
              material: "SS316",
              pressureRating: "Class 150",
              unit: "pcs",
              quantity: 5,
              quantityFromStock: 0,
              quantityToSource: 5,
              inventoryStatus: "NONE",
              sourcingStatus: "AWAITING_APPROVAL",
              reviewStatus: "CONFIRMED",
              missingFields: "[]",
              confidence: JSON.stringify({ description: 0.95, quantity: 0.95 }),
              sourceRef: "message",
            },
          ],
        },
      },
      include: { items: true },
    });

    const itemB = enquiryB.items[0];
    await db.supplierOffer.createMany({
      data: [
        {
          enquiryItemId: itemB.id,
          supplierId: supplierIds[0],
          supplierName: suppliers[0].name,
          productTitle: "Gate Valve 1 inch SS316 Class 150 — threaded",
          matchStatus: "EXACT",
          unitPrice: 148,
          currency: "AED",
          moq: 1,
          shippingCost: 35,
          otherCharges: 0,
          leadTimeDays: 2,
          quantityAvailable: 25,
          validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          status: "PRICE_CONFIRMED",
          sourceType: "MANUAL",
          quotedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          quoteRef: "SAMPLE-Q-101",
          verificationStatus: "VERIFIED",
          isDemo: true,
          evidenceJson: JSON.stringify({
            match: { reasons: ["Size matches (1in)", "Material matches (SS316)", "Pressure rating matches (Class 150)"] },
            note: "Sample offer for demonstration.",
          }),
        },
        {
          enquiryItemId: itemB.id,
          supplierId: supplierIds[1],
          supplierName: suppliers[1].name,
          productTitle: "Stainless Steel Gate Valve 1in 316 Class 150",
          matchStatus: "EXACT",
          unitPrice: 132,
          currency: "AED",
          moq: 50,
          shippingCost: 25,
          otherCharges: 0,
          leadTimeDays: 5,
          validityDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          status: "PRICE_CONFIRMED",
          sourceType: "MANUAL",
          quotedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
          quoteRef: "SAMPLE-Q-102",
          verificationStatus: "VERIFIED",
          isDemo: true,
          evidenceJson: JSON.stringify({
            match: { reasons: ["Size matches (1in)", "Material matches (SS316)", "Pressure rating matches (Class 150)"] },
            note: "Sample offer with a low unit price and a high minimum order quantity.",
          }),
        },
        {
          enquiryItemId: itemB.id,
          supplierId: supplierIds[2],
          supplierName: suppliers[2].name,
          productTitle: "Gate valve 1in SS304 Class 150 (sample)",
          matchStatus: "NO_MATCH",
          unitPrice: 120,
          currency: "AED",
          moq: 1,
          leadTimeDays: 3,
          status: "VERIFIED",
          sourceType: "MANUAL",
          quotedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
          quoteRef: "SAMPLE-Q-103",
          verificationStatus: "PARTIAL",
          isDemo: true,
          evidenceJson: JSON.stringify({
            match: { mismatches: ["Material differs: requested SS316, offered SS304"] },
            note: "Sample offer with the wrong material.",
          }),
        },
      ],
    });

    await recomputeOffersForItem(itemB.id);
    await ensureSourcingApproval(itemB.id);

    await writeAudit({
      action: "demo.seed_completed",
      entityType: "System",
      entityId: "seed",
      actorLabel: "seed",
      meta: { owner: owner.email },
    });
  }

  // The fastener-owner walkthrough is separate from the original demo records.
  await seedFastenerWalkthrough(db);

  // Drain any jobs queued by the demo pipeline so the demo state is complete.
  for (let i = 0; i < 25; i += 1) {
    const ran = await runNextJob("seed-worker");
    if (!ran) break;
  }

  console.log("Seed complete.");
  console.log("Demo accounts: owner@mfbmt.local and staff@mfbmt.local (password is shown only on the demo sign-in page).");
  console.log("All demo records are marked as sample data. Replace these accounts before real use.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
