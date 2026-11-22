import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import {
  InsufficientStockError,
  expireStaleReservations,
  releaseQuotationReservations,
  reserveQuotationStock,
} from "../src/lib/inventory/reservations";
import { decideApproval } from "../src/lib/workflow/approvals";

const RUN = randomUUID().slice(0, 8);
const createdOrganizationIds: string[] = [];
const createdEnquiryIds: string[] = [];
const createdProductIds: string[] = [];
const createdLocationIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  await rawDb.stockReservation.deleteMany({ where: { idempotencyKey: { contains: RUN } } });
  await rawDb.approval.deleteMany({ where: { entityType: "CustomerQuotation", entityId: { startsWith: `q-${RUN}-` } } });
  await rawDb.auditLog.deleteMany({ where: { entityId: { startsWith: `q-${RUN}-` } } });
  await rawDb.enquiryItem.deleteMany({ where: { enquiryId: { in: createdEnquiryIds } } });
  await rawDb.enquiry.deleteMany({ where: { id: { in: createdEnquiryIds } } });
  await rawDb.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawDb.inventoryLocation.deleteMany({ where: { id: { in: createdLocationIds } } });
  await rawDb.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawDb.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
  await rawDb.$disconnect();
});

async function makeStockedProduct(input: { quantities: number[]; organizationId?: string; prefix: string }) {
  const organizationId = input.organizationId ?? "org_mfbmt";
  return db.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        organizationId,
        sku: `${input.prefix}-SKU-${RUN}-${randomUUID().slice(0, 6)}`,
        name: `${input.prefix} test product`,
        category: "Pipes",
        unit: "pcs",
      },
    });
    createdProductIds.push(product.id);
    const locations = [];
    for (const [index, quantity] of input.quantities.entries()) {
      const location = await tx.inventoryLocation.create({
        data: {
          organizationId,
          code: `${input.prefix}-LOC-${RUN}-${index}-${randomUUID().slice(0, 4)}`,
          name: `Test location ${index}`,
        },
      });
      createdLocationIds.push(location.id);
      await tx.inventoryStock.create({
        data: { organizationId, productId: product.id, locationId: location.id, quantityOnHand: quantity },
      });
      locations.push(location);
    }
    return { product, locations };
  });
}

async function makeQuotation(input: {
  productId: string;
  stockQuantity: number;
  unitPrice?: number | null;
  status?: string;
  organizationId?: string;
}) {
  const organizationId = input.organizationId ?? "org_mfbmt";
  const enquiry = await db.enquiry.create({
    data: {
      organizationId,
      publicRef: `RES-${RUN}-${randomUUID().slice(0, 8)}`,
      channel: "MANUAL",
      rawText: "reservation test",
      status: "APPROVED",
    },
  });
  createdEnquiryIds.push(enquiry.id);
  const item = await db.enquiryItem.create({
    data: {
      organizationId,
      enquiryId: enquiry.id,
      description: "Reservation test line",
      category: "Pipes",
      quantity: input.stockQuantity,
      unit: "pcs",
      matchedProductId: input.productId,
      quantityFromStock: input.stockQuantity,
      quantityToSource: 0,
    },
  });
  const quotation = await db.customerQuotation.create({
    data: {
      organizationId,
      id: `q-${RUN}-${randomUUID().slice(0, 10)}`,
      enquiryId: enquiry.id,
      quoteNumber: `QT-${RUN}-${randomUUID().slice(0, 8)}`,
      version: 1,
      customerName: "Reservation Customer",
      currency: "AED",
      subtotal: (input.unitPrice ?? 0) * input.stockQuantity,
      total: (input.unitPrice ?? 0) * input.stockQuantity,
      status: input.status ?? "AWAITING_APPROVAL",
      items: {
        create: [
          {
            organizationId,
            description: "Reservation test line",
            quantity: input.stockQuantity,
            unit: "pcs",
            unitPrice: input.unitPrice ?? 10,
            lineTotal: (input.unitPrice ?? 10) * input.stockQuantity,
            priceStatus: "PRICED",
            stockQuantity: input.stockQuantity,
            enquiryItemId: item.id,
          },
        ],
      },
    },
  });
  return { enquiry, item, quotation };
}

async function reservedTotal(productId: string) {
  const rows = await rawDb.inventoryStock.findMany({
    where: { productId, organizationId: "org_mfbmt" },
    select: { quantityReserved: true },
  });
  return rows.reduce((sum, row) => sum + row.quantityReserved, 0);
}

describe("inventory reservations (PostgreSQL)", () => {
  it("aggregates available stock across eligible locations and reserves exactly once", async () => {
    const { product } = await makeStockedProduct({ quantities: [2, 4], prefix: "agg" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 5 });

    const first = await reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id });
    expect(first.created).toHaveLength(1);
    expect(first.created[0].allocations.reduce((sum, row) => sum + row.quantity, 0)).toBe(5);
    expect(await reservedTotal(product.id)).toBe(5);

    const second = await reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id });
    expect(second.created).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(await reservedTotal(product.id)).toBe(5);
  });

  it("never over-reserves when two quotations race for the same stock", async () => {
    const { product } = await makeStockedProduct({ quantities: [6], prefix: "race" });
    const [left, right] = await Promise.all([
      makeQuotation({ productId: product.id, stockQuantity: 4 }),
      makeQuotation({ productId: product.id, stockQuantity: 4 }),
    ]);

    const results = await Promise.allSettled([
      reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: left.quotation.id }),
      reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: right.quotation.id }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);
    expect(await reservedTotal(product.id)).toBe(4);
  });

  it("treats a concurrent repeat of the same quotation as idempotent even when stock is exact", async () => {
    const { product } = await makeStockedProduct({ quantities: [4], prefix: "same-race" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 4 });

    const results = await Promise.allSettled([
      reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id }),
      reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const fulfilled = results
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveQuotationStock>>> => result.status === "fulfilled")
      .map((result) => result.value);
    expect(fulfilled.reduce((sum, result) => sum + result.created.length, 0)).toBe(1);
    expect(fulfilled.reduce((sum, result) => sum + result.duplicates.length, 0)).toBe(1);
    expect(await reservedTotal(product.id)).toBe(4);
    expect(await rawDb.stockReservation.count({ where: { quotationId: quotation.id, status: "ACTIVE" } })).toBe(1);
  });

  it("reserves again after a release instead of leaving a re-approved quotation without stock", async () => {
    const { product } = await makeStockedProduct({ quantities: [6], prefix: "reopen" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 3 });
    const first = await reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id });
    expect(first.created).toHaveLength(1);
    expect(await releaseQuotationReservations({ organizationId: "org_mfbmt", quotationId: quotation.id, reason: "rejected" })).toBe(1);
    expect(await reservedTotal(product.id)).toBe(0);

    const second = await reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id });
    expect(second.created).toHaveLength(1);
    expect(second.created[0].status).toBe("ACTIVE");
    expect(await reservedTotal(product.id)).toBe(3);
    const rows = await rawDb.stockReservation.findMany({ where: { quotationId: quotation.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ACTIVE");
    expect(rows[0].releasedAt).toBeNull();
  });

  it("releases once and never lets reserved stock go negative", async () => {
    const { product } = await makeStockedProduct({ quantities: [10], prefix: "release" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 3 });
    await reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id });
    expect(await reservedTotal(product.id)).toBe(3);

    expect(await releaseQuotationReservations({ organizationId: "org_mfbmt", quotationId: quotation.id, reason: "test release" })).toBe(1);
    expect(await reservedTotal(product.id)).toBe(0);
    expect(await releaseQuotationReservations({ organizationId: "org_mfbmt", quotationId: quotation.id, reason: "double release" })).toBe(0);
    expect(await reservedTotal(product.id)).toBe(0);

    const reservations = await rawDb.stockReservation.findMany({ where: { quotationId: quotation.id } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].status).toBe("RELEASED");
  });

  it("expires stale holds and returns the units to available stock", async () => {
    const { product } = await makeStockedProduct({ quantities: [5], prefix: "expire" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 2 });
    await reserveQuotationStock({
      organizationId: "org_mfbmt",
      quotationId: quotation.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await reservedTotal(product.id)).toBe(2);

    const expired = await expireStaleReservations(50);
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await reservedTotal(product.id)).toBe(0);
    const reservation = await rawDb.stockReservation.findFirst({ where: { quotationId: quotation.id } });
    expect(reservation?.status).toBe("EXPIRED");
  });

  it("blocks approval when required stock is missing, and records an explicit owner override", async () => {
    const { product } = await makeStockedProduct({ quantities: [2], prefix: "approval" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 5 });
    const owner = await rawDb.user.create({
      data: {
        organizationId: "org_mfbmt",
        email: `reservation-owner-${RUN}-${randomUUID().slice(0, 6)}@example.com`,
        name: "Reservation Owner",
        passwordHash: "not-used",
        role: "OWNER",
      },
    });
    createdUserIds.push(owner.id);
    const approval = await rawDb.approval.create({
      data: {
        organizationId: "org_mfbmt",
        type: "CUSTOMER_QUOTATION",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        status: "PENDING",
        requestedBy: "SYSTEM",
      },
    });

    const blocked = await decideApproval({
      approvalId: approval.id,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.email,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/insufficient stock/i);
    expect((await rawDb.approval.findUnique({ where: { id: approval.id } }))?.status).toBe("PENDING");
    expect(await reservedTotal(product.id)).toBe(0);
    expect((await rawDb.customerQuotation.findUnique({ where: { id: quotation.id } }))?.status).toBe("AWAITING_APPROVAL");

    const overridden = await decideApproval({
      approvalId: approval.id,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.email,
      reason: "Customer accepts partial delivery; balance sourced separately.",
    });
    expect(overridden.ok).toBe(true);
    const audit = await rawDb.auditLog.findFirst({
      where: { action: "quotation.stock_override", entityId: quotation.id },
    });
    expect(audit).not.toBeNull();
    // An override authorises the approval but never invents stock: the two
    // available units are not silently over-reserved to five.
    expect(await reservedTotal(product.id)).toBe(0);
  });

  it("reserves inside the approval transaction when stock is sufficient", async () => {
    const { product } = await makeStockedProduct({ quantities: [10], prefix: "approveok" });
    const { quotation } = await makeQuotation({ productId: product.id, stockQuantity: 4 });
    const owner = await rawDb.user.create({
      data: {
        organizationId: "org_mfbmt",
        email: `reservation-owner-ok-${RUN}-${randomUUID().slice(0, 6)}@example.com`,
        name: "Reservation Owner OK",
        passwordHash: "not-used",
        role: "OWNER",
      },
    });
    createdUserIds.push(owner.id);
    const approval = await rawDb.approval.create({
      data: {
        organizationId: "org_mfbmt",
        type: "CUSTOMER_QUOTATION",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        status: "PENDING",
        requestedBy: "SYSTEM",
      },
    });

    const decided = await decideApproval({
      approvalId: approval.id,
      decision: "APPROVED",
      userId: owner.id,
      actorLabel: owner.email,
    });
    expect(decided.ok).toBe(true);
    expect(await reservedTotal(product.id)).toBe(4);
    const reservation = await rawDb.stockReservation.findFirst({ where: { quotationId: quotation.id } });
    expect(reservation?.status).toBe("ACTIVE");
    expect((await rawDb.customerQuotation.findUnique({ where: { id: quotation.id } }))?.status).toBe("APPROVED");
  });

  it("does not reserve another tenant's stock", async () => {
    const organizations = await rawDb.organization.findMany({ where: { slug: { startsWith: "res-iso-" } } });
    expect(organizations).toHaveLength(0);
    const other = await rawDb.organization.create({
      data: {
        slug: `res-iso-${RUN}-${randomUUID().slice(0, 6)}`,
        name: "Reservation isolation tenant",
        status: "ACTIVE",
      },
    });
    createdOrganizationIds.push(other.id);
    const { product } = await runWithTenant({ organizationId: other.id, source: "explicit" }, () =>
      makeStockedProduct({ quantities: [10], prefix: "iso", organizationId: other.id }),
    );
    const { quotation } = await makeQuotation({
      productId: product.id,
      stockQuantity: 2,
      organizationId: "org_mfbmt",
    });
    await expect(
      reserveQuotationStock({ organizationId: "org_mfbmt", quotationId: quotation.id }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    const otherStock = await rawDb.inventoryStock.findFirst({ where: { productId: product.id, organizationId: other.id } });
    expect(otherStock?.quantityReserved).toBe(0);
  });
});
