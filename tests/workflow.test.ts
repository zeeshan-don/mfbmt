import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { ingestInboundMessage } from "../src/lib/workflow/enquiry";
import { checkInventoryForItem } from "../src/lib/inventory/check";
import { importInventory } from "../src/lib/inventory/import";
import { ensureSourcingApproval, decideApproval } from "../src/lib/workflow/approvals";
import { computeLandedCost } from "../src/lib/costing/landed";

async function makeProduct(input: {
  sku: string;
  name: string;
  quantity: number;
  size: string;
  material: string;
  category: string;
}) {
  const product = await db.product.create({
    data: {
      sku: input.sku,
      name: input.name,
      category: input.category,
      size: input.size,
      material: input.material,
      unit: "pcs",
    },
  });
  const location = await db.inventoryLocation.upsert({
    where: { code: "TEST-MAIN" },
    update: {},
    create: { code: "TEST-MAIN", name: "Test warehouse" },
  });
  await db.inventoryStock.create({
    data: { productId: product.id, locationId: location.id, quantityOnHand: input.quantity },
  });
  return product;
}

async function makeEnquiryItem(input: { quantity: number; prefix: string }) {
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `TEST-${input.prefix}-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: "test",
      status: "READY",
    },
  });
  return db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description: "SS316 elbow 1 inch",
      category: "Pipe Fittings",
      size: "1 inch",
      material: "SS316",
      unit: "pcs",
      quantity: input.quantity,
      missingFields: "[]",
    },
  });
}

beforeEach(async () => {
  await db.supplierOffer.deleteMany();
  await db.approval.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.inventoryStock.deleteMany();
  await db.product.deleteMany();
  await db.supplierProduct.deleteMany();
  await db.excludedContact.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.contact.deleteMany();
  await db.notification.deleteMany();
  await db.auditLog.deleteMany();
  await db.backgroundJob.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("inbound message de-duplication", () => {
  it("processes a repeated webhook delivery only once", async () => {
    const externalMessageId = `wa-dup-${randomUUID()}`;
    const first = await ingestInboundMessage({
      channel: "WHATSAPP",
      externalMessageId,
      from: "+971500000201",
      body: "Please quote 5 hammers",
    });
    const second = await ingestInboundMessage({
      channel: "WHATSAPP",
      externalMessageId,
      from: "+971500000201",
      body: "Please quote 5 hammers",
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(await db.message.count({ where: { externalMessageId } })).toBe(1);
  });

  it("does not store the body of a family message or create an enquiry", async () => {
    const identifier = `+9715000002${String(Math.floor(Math.random() * 90) + 10)}`;
    await db.excludedContact.create({
      data: { identifier, category: "FAMILY", label: "Test family" },
    });

    const result = await ingestInboundMessage({
      channel: "WHATSAPP",
      externalMessageId: `wa-family-${randomUUID()}`,
      from: identifier,
      body: "Happy birthday, see you at dinner",
    });

    expect(result.ignored).toBe(true);
    const message = await db.message.findUnique({ where: { id: result.messageId } });
    expect(message?.body).toBeNull();
    expect(message?.bodyRetained).toBe(false);
    expect(message?.enquiryId).toBeNull();
    expect(message?.processingStatus).toBe("IGNORED");
  });
});

describe("inventory availability", () => {
  it("fulfils a request entirely from stock when enough is available", async () => {
    const sku = `STK-EXACT-${randomUUID().slice(0, 6)}`;
    await makeProduct({
      sku,
      name: "Stainless Steel Elbow 90 degree 1 inch SS316",
      quantity: 12,
      size: "1 inch",
      material: "SS316",
      category: "Pipe Fittings",
    });
    const item = await makeEnquiryItem({ quantity: 10, prefix: "exact" });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("AVAILABLE");
    expect(outcome.fromStock).toBe(10);
    expect(outcome.toSource).toBe(0);
  });

  it("sources only the missing quantity when stock is partial", async () => {
    const sku = `STK-PART-${randomUUID().slice(0, 6)}`;
    await makeProduct({
      sku,
      name: "Stainless Steel Elbow 1 inch SS316 (partial)",
      quantity: 6,
      size: "1 inch",
      material: "SS316",
      category: "Pipe Fittings",
    });
    const item = await makeEnquiryItem({ quantity: 10, prefix: "partial" });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.fromStock).toBe(6);
    expect(outcome.toSource).toBe(4);
  });

  it("sources everything when the matching product has zero stock", async () => {
    const sku = `STK-ZERO-${randomUUID().slice(0, 6)}`;
    await makeProduct({
      sku,
      name: "Stainless Steel Elbow 1 inch SS316 (empty)",
      quantity: 0,
      size: "1 inch",
      material: "SS316",
      category: "Pipe Fittings",
    });
    const item = await makeEnquiryItem({ quantity: 10, prefix: "zero" });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("NONE");
    expect(outcome.fromStock).toBe(0);
    expect(outcome.toSource).toBe(10);
  });

  it("does not use a similar product with a different material", async () => {
    const sku = `STK-MAT-${randomUUID().slice(0, 6)}`;
    await makeProduct({
      sku,
      name: "Stainless Steel Elbow 1 inch SS304",
      quantity: 50,
      size: "1 inch",
      material: "SS304",
      category: "Pipe Fittings",
    });
    const item = await makeEnquiryItem({ quantity: 10, prefix: "mat" });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("NONE");
    expect(outcome.note).toMatch(/does not match the requested specification/i);
  });

  it("asks for details instead of checking stock for an incomplete line", async () => {
    const item = await makeEnquiryItem({ quantity: 5, prefix: "clarify" });
    await db.enquiryItem.update({
      where: { id: item.id },
      data: { missingFields: JSON.stringify(["Size"]), clarificationQuestion: "Which valve type is required?" },
    });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("CLARIFY");
    expect(outcome.toSource).toBe(0);
  });
});

describe("inventory import", () => {
  it("imports valid rows and reports invalid ones without stopping", async () => {
    const user = await db.user.upsert({
      where: { email: "import-test@mfbmt.local" },
      update: {},
      create: { email: "import-test@mfbmt.local", name: "Import Test", passwordHash: "x", role: "OWNER" },
    });
    const sku = `IMP-${randomUUID().slice(0, 6)}`;
    const report = await importInventory({
      rows: [
        ["Product A", "12", sku, "Pipe Fittings"],
        ["Product B", "not-a-number", `${sku}-B`, "Valves"],
        ["", "4", `${sku}-C`, "Valves"],
      ],
      mapping: { name: 0, quantity: 1, sku: 2, category: 3 },
      defaultLocationCode: "IMPORT-LOC",
      defaultLocationName: "Import test",
      userId: user.id,
    });

    expect(report.created).toBe(1);
    expect(report.errors.length).toBe(2);
    const product = await db.product.findUnique({ where: { sku } });
    expect(product).not.toBeNull();
    const stock = await db.inventoryStock.findFirst({ where: { productId: product!.id } });
    expect(stock?.quantityOnHand).toBe(12);
  });
});

describe("approval transitions", () => {
  it("records an owner decision once and unlocks the approved supplier", async () => {
    const item = await makeEnquiryItem({ quantity: 5, prefix: "approval" });
    await db.enquiryItem.update({
      where: { id: item.id },
      data: { quantityToSource: 5, quantityFromStock: 0 },
    });
    const offer = await db.supplierOffer.create({
      data: {
        enquiryItemId: item.id,
        supplierName: "Approval Test Supplier",
        productTitle: "SS316 elbow 1 inch",
        matchStatus: "EXACT",
        unitPrice: 12,
        currency: "AED",
        shippingCost: 20,
        status: "PRICE_CONFIRMED",
        verificationStatus: "VERIFIED",
        isEligible: true,
        landedCostJson: JSON.stringify({
          landed: computeLandedCost({
            unitPrice: 12,
            currency: "AED",
            quantity: 5,
            moq: null,
            shippingCost: 20,
            otherCharges: 0,
            taxes: 0,
            fxRate: null,
            targetCurrency: "AED",
            taxEnabled: false,
          }),
          evaluation: { rank: 1, eligible: true, blockers: [], reasons: ["Specification matches"] },
        }),
      },
    });

    const user = await db.user.upsert({
      where: { email: "approver@mfbmt.local" },
      update: {},
      create: { email: "approver@mfbmt.local", name: "Approver", passwordHash: "x", role: "OWNER" },
    });

    const approvalId = await ensureSourcingApproval(item.id);
    expect(approvalId).toBeTruthy();

    const result = await decideApproval({
      approvalId: approvalId!,
      decision: "APPROVED",
      userId: user.id,
      actorLabel: user.name,
      selectedOfferId: offer.id,
    });
    expect(result.ok).toBe(true);

    const updated = await db.enquiryItem.findUnique({ where: { id: item.id } });
    expect(updated?.approvedOfferId).toBe(offer.id);
    expect(updated?.sourcingStatus).toBe("APPROVED");

    const second = await decideApproval({
      approvalId: approvalId!,
      decision: "REJECTED",
      userId: user.id,
      actorLabel: user.name,
    });
    expect(second.ok).toBe(false);
  });

  it("requires a reason to approve an ineligible offer", async () => {
    const item = await makeEnquiryItem({ quantity: 5, prefix: "override" });
    const offer = await db.supplierOffer.create({
      data: {
        enquiryItemId: item.id,
        supplierName: "Ineligible Supplier",
        productTitle: "SS304 elbow",
        matchStatus: "NO_MATCH",
        unitPrice: 9,
        currency: "AED",
        status: "VERIFIED",
        isEligible: false,
        landedCostJson: "{}",
      },
    });
    const user = await db.user.upsert({
      where: { email: "approver@mfbmt.local" },
      update: {},
      create: { email: "approver@mfbmt.local", name: "Approver", passwordHash: "x", role: "OWNER" },
    });
    const approvalId = await ensureSourcingApproval(item.id);
    const blocked = await decideApproval({
      approvalId: approvalId!,
      decision: "APPROVED",
      userId: user.id,
      actorLabel: user.name,
      selectedOfferId: offer.id,
    });
    expect(blocked.ok).toBe(false);

    const allowed = await decideApproval({
      approvalId: approvalId!,
      decision: "APPROVED",
      userId: user.id,
      actorLabel: user.name,
      selectedOfferId: offer.id,
      reason: "Owner knows this supplier supplies an equivalent product",
    });
    expect(allowed.ok).toBe(true);
  });
});
