import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { checkInventoryForItem } from "../src/lib/inventory/check";
import { parseFastenerSpec } from "../src/lib/fasteners/spec";

const REQUEST = "Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 8.8, zinc plated, carbon steel";

async function makeProduct(description: string, onHand: number) {
  const spec = parseFastenerSpec({ description });
  const product = await db.product.create({
    data: {
      sku: `FST-${randomUUID().slice(0, 8)}`,
      name: description,
      category: "Industrial Fasteners",
      size: spec.diameter,
      material: spec.material,
      grade: spec.propertyClass,
      standard: spec.standard,
      unit: "pcs",
      fastenerSpecJson: JSON.stringify(spec),
    },
  });
  const location = await db.inventoryLocation.upsert({
    where: { organizationId_code: { organizationId: "org_mfbmt", code: "FST-TEST" } },
    update: {},
    create: { code: "FST-TEST", name: "Fastener test store" },
  });
  await db.inventoryStock.create({
    data: { productId: product.id, locationId: location.id, quantityOnHand: onHand },
  });
  return product;
}

async function makeItem(description: string, overrides: { missingFields?: string[] } = {}) {
  const spec = parseFastenerSpec({ description });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `FST-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: description,
      status: "READY",
    },
  });
  return db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      description,
      category: "Industrial Fasteners",
      size: spec.diameter,
      material: spec.material,
      grade: spec.propertyClass,
      standard: spec.standard,
      unit: "pcs",
      quantity: 50,
      missingFields: JSON.stringify(overrides.missingFields ?? []),
      fastenerSpecJson: JSON.stringify(spec),
      fastenerType: spec.type,
      diameter: spec.diameter,
      threadSeries: spec.threadSeries,
      pitchMm: spec.pitchMm,
      lengthMm: spec.lengthMm,
      propertyClass: spec.propertyClass,
      finish: spec.finish,
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
});

afterAll(async () => {
  await db.$disconnect();
});

describe("fastener stock matching", () => {
  it("uses the confirmed M10 x 1.5 x 30 specification, not a broad fastener token", async () => {
    await makeProduct(REQUEST, 100);
    const item = await makeItem(REQUEST);
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("AVAILABLE");
    expect(outcome.fromStock).toBe(50);
  });

  it("does not promise M10 stock to a request for M12", async () => {
    await makeProduct("Hex bolt ISO 4017 M12 x 1.75 x 30 mm, class 8.8, zinc plated, carbon steel", 100);
    const item = await makeItem(REQUEST);
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("NONE");
    expect(outcome.fromStock).toBe(0);
    expect(outcome.toSource).toBe(50);
  });

  it("does not promise a class 10.9 bolt for a class 8.8 request", async () => {
    await makeProduct("Hex bolt ISO 4017 M10 x 1.5 x 30 mm, class 10.9, zinc plated, carbon steel", 100);
    const item = await makeItem(REQUEST);
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("NONE");
  });

  it("asks for clarification instead of checking stock when the pitch is not confirmed", async () => {
    await makeProduct(REQUEST, 100);
    const item = await makeItem("Hex bolt M10 x 30 mm class 8.8 zinc plated carbon steel", {
      missingFields: ["Thread pitch"],
    });
    const outcome = await checkInventoryForItem(item.id);
    expect(outcome.status).toBe("CLARIFY");
    expect(outcome.toSource).toBe(0);
  });
});
