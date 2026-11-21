import { db } from "../db";
import { currentTenant } from "../tenant";
import { availableQuantity } from "./matching";

export type ReservationResult = {
  stockId: string;
  productId: string;
  locationId: string;
  quantityReserved: number;
  availableAfter: number;
};

export type ReservationError = { code: "INSUFFICIENT_STOCK" | "NOT_FOUND"; message: string };

/**
 * Reserve `quantity` units of stock for a product/location inside a single
 * transaction. Uses `SELECT ... FOR UPDATE` so two concurrent callers cannot
 * both reserve the same available units. Never allows reserved to exceed on
 * hand. Returns the updated reserved total.
 */
export async function reserveStock(input: {
  productId: string;
  locationId: string;
  quantity: number;
  organizationId?: string;
}): Promise<ReservationResult> {
  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Reservation quantity must be a positive number.");
  }

  return db.$transaction(async (tx) => {
    const tenant = await currentTenant();
    const orgId = input.organizationId ?? tenant?.organizationId;
    if (!orgId) throw new Error("Tenant context is required to reserve stock.");
    const rows = (await (tx as unknown as { $queryRaw: (...a: unknown[]) => Promise<unknown[]> }).$queryRaw`
      SELECT id, "productId", "locationId", "quantityOnHand", "quantityReserved", "organizationId"
      FROM "InventoryStock"
      WHERE "productId" = ${input.productId}
        AND "locationId" = ${input.locationId}
        AND "organizationId" = ${orgId}
      FOR UPDATE
    `) as Array<{
      id: string;
      productId: string;
      locationId: string;
      quantityOnHand: number;
      quantityReserved: number;
      organizationId: string;
    }>;

    const stock = rows[0];
    if (!stock) throw new Error("No stock record for this product/location.");

    const available = availableQuantity(stock.quantityOnHand, stock.quantityReserved);
    if (qty > available + 1e-9) {
      throw new Error(
        `Insufficient stock: requested ${qty}, available ${available} (on hand ${stock.quantityOnHand}, reserved ${stock.quantityReserved}).`,
      );
    }

    const newReserved = stock.quantityReserved + qty;
    await tx.inventoryStock.update({
      where: { id: stock.id },
      data: { quantityReserved: newReserved, lastUpdatedAt: new Date() },
    });

    return {
      stockId: stock.id,
      productId: stock.productId,
      locationId: stock.locationId,
      quantityReserved: newReserved,
      availableAfter: availableQuantity(stock.quantityOnHand, newReserved),
    };
  });
}

export async function releaseStock(input: {
  productId: string;
  locationId: string;
  quantity: number;
}): Promise<ReservationResult> {
  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Release quantity must be a positive number.");
  }
  return db.$transaction(async (tx) => {
    const tenant = await currentTenant();
    const orgId = tenant?.organizationId;
    if (!orgId) throw new Error("Tenant context is required to release stock.");
    const rows = (await (tx as unknown as { $queryRaw: (...a: unknown[]) => Promise<unknown[]> }).$queryRaw`
      SELECT id, "productId", "locationId", "quantityOnHand", "quantityReserved"
      FROM "InventoryStock"
      WHERE "productId" = ${input.productId}
        AND "locationId" = ${input.locationId}
        AND "organizationId" = ${orgId}
      FOR UPDATE
    `) as Array<{
      id: string;
      productId: string;
      locationId: string;
      quantityOnHand: number;
      quantityReserved: number;
    }>;
    const stock = rows[0];
    if (!stock) throw new Error("No stock record for this product/location.");
    const newReserved = Math.max(0, stock.quantityReserved - qty);
    await tx.inventoryStock.update({
      where: { id: stock.id },
      data: { quantityReserved: newReserved, lastUpdatedAt: new Date() },
    });
    return {
      stockId: stock.id,
      productId: stock.productId,
      locationId: stock.locationId,
      quantityReserved: newReserved,
      availableAfter: availableQuantity(stock.quantityOnHand, newReserved),
    };
  });
}