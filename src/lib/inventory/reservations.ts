import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { rawDb } from "../db-base";
import { parseJson, stringifyJson } from "../json";
import { availableQuantity } from "./matching";

/**
 * Inventory reservations.
 *
 * A reservation is a temporary hold for one quotation line, not an accepted
 * customer order and not a purchase commitment. It is created in the same
 * database transaction as the approval decision and can be released or expire.
 *
 * Correctness rules:
 *  - stock rows are locked with SELECT … FOR UPDATE before allocation;
 *  - available stock is aggregated across every eligible location of the tenant;
 *  - a line can never reserve more than is available;
 *  - one idempotency key per quotation line prevents duplicate reservations;
 *  - a release is a conditional state transition, so it can happen only once;
 *  - insufficient stock throws, which rolls the approval transaction back
 *    unless an owner explicitly overrides with a recorded reason.
 */

export type ReservationAllocation = { locationId: string; quantity: number };

export type ReservationLineResult = {
  reservationId: string;
  quotationItemId: string | null;
  enquiryItemId: string | null;
  productId: string;
  quantity: number;
  allocations: ReservationAllocation[];
  status: string;
  duplicate: boolean;
};

export type InsufficientStockLine = {
  quotationItemId: string | null;
  enquiryItemId: string | null;
  productId: string | null;
  description: string;
  required: number;
  available: number;
  reason: string;
};

export class InsufficientStockError extends Error {
  readonly lines: InsufficientStockLine[];

  constructor(lines: InsufficientStockLine[]) {
    super(
      `Insufficient stock for ${lines.length} line(s): ${lines
        .map((line) => `${line.description} need ${line.required}, available ${line.available}`)
        .join("; ")}`,
    );
    this.name = "InsufficientStockError";
    this.lines = lines;
  }
}

const RESERVATION_STATUS = {
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  EXPIRED: "EXPIRED",
  COMMITTED: "COMMITTED",
} as const;

export function reservationIdempotencyKey(quotationId: string, quotationItemId: string): string {
  return `quotation:${quotationId}:${quotationItemId}`;
}

type LockedStockRow = {
  id: string;
  locationId: string;
  quantityOnHand: number;
  quantityReserved: number;
};

/**
 * Reserves every stock-shipping line of a quotation inside an existing
 * transaction. Throws InsufficientStockError after making no changes when any
 * line cannot be fully covered.
 */
export async function reserveQuotationStockInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    quotationId: string;
    userId?: string | null;
    expiresAt?: Date;
    overrideReason?: string | null;
  },
): Promise<{ created: ReservationLineResult[]; duplicates: ReservationLineResult[] }> {
  const quotation = await tx.customerQuotation.findFirst({
    where: { id: input.quotationId, organizationId: input.organizationId },
    include: { items: true },
  });
  if (!quotation) throw new Error("Quotation not found in this organization.");

  const stockLines = quotation.items.filter((item) => (item.stockQuantity ?? 0) > 0);
  if (stockLines.length === 0) return { created: [], duplicates: [] };

  const enquiryItemIds = stockLines
    .map((line) => line.enquiryItemId)
    .filter((id): id is string => Boolean(id));
  const enquiryItems = await tx.enquiryItem.findMany({
    where: { id: { in: enquiryItemIds }, organizationId: input.organizationId },
    select: { id: true, matchedProductId: true, description: true },
  });
  const enquiryById = new Map(enquiryItems.map((item) => [item.id, item]));

  const created: ReservationLineResult[] = [];
  const duplicates: ReservationLineResult[] = [];
  const failures: InsufficientStockLine[] = [];
  const plans: Array<{
    line: (typeof stockLines)[number];
    productId: string;
    required: number;
    allocations: ReservationAllocation[];
  }> = [];

  for (const line of stockLines) {
    const required = Number(line.stockQuantity ?? 0);
    const enquiryItem = line.enquiryItemId ? enquiryById.get(line.enquiryItemId) : undefined;
    const productId = enquiryItem?.matchedProductId ?? null;
    const description = line.description || enquiryItem?.description || "Unnamed line";

    if (!Number.isFinite(required) || required <= 0) continue;
    if (!productId) {
      failures.push({
        quotationItemId: line.id,
        enquiryItemId: line.enquiryItemId,
        productId: null,
        description,
        required,
        available: 0,
        reason: "The line ships from stock but has no matched inventory product.",
      });
      continue;
    }

    const idempotencyKey = reservationIdempotencyKey(quotation.id, line.id);
    const existing = await tx.stockReservation.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey } },
    });
    // ACTIVE/COMMITTED means this line is already covered. A RELEASED or
    // EXPIRED row is historical: the quotation can be re-approved later, so it
    // must be reopened after the fresh allocation rather than treated as a
    // duplicate or silently left without stock.
    if (existing && (existing.status === RESERVATION_STATUS.ACTIVE || existing.status === RESERVATION_STATUS.COMMITTED)) {
      duplicates.push({
        reservationId: existing.id,
        quotationItemId: line.id,
        enquiryItemId: line.enquiryItemId,
        productId: existing.productId,
        quantity: existing.quantity,
        allocations: parseJson<ReservationAllocation[]>(existing.allocationsJson, []),
        status: existing.status,
        duplicate: true,
      });
      continue;
    }

    // Lock every eligible stock row for this product. The join enforces that
    // the location itself belongs to the same tenant.
    const rows = await tx.$queryRaw<LockedStockRow[]>`
      SELECT s.id, s."locationId", s."quantityOnHand", s."quantityReserved"
        FROM "InventoryStock" s
        JOIN "InventoryLocation" l
          ON l.id = s."locationId" AND l."organizationId" = s."organizationId"
       WHERE s."organizationId" = ${input.organizationId}
         AND s."productId" = ${productId}
         AND (s."quantityOnHand" - s."quantityReserved") > 0
       ORDER BY (s."quantityOnHand" - s."quantityReserved") DESC, s."locationId" ASC
       FOR UPDATE OF s
    `;

    let remaining = required;
    let available = 0;
    const allocations: ReservationAllocation[] = [];
    for (const row of rows) {
      const free = availableQuantity(row.quantityOnHand, row.quantityReserved);
      available += free;
      if (remaining <= 0) continue;
      const take = Math.min(remaining, free);
      if (take > 0) {
        allocations.push({ locationId: row.locationId, quantity: take });
        remaining -= take;
      }
    }

    // Re-check after the stock row locks. A concurrent request for the SAME
    // quotation may have inserted this line's reservation while we waited for
    // the lock. That is an idempotent repeat, not an insufficient-stock
    // failure: returning the existing row avoids a false rejection when the
    // requested quantity exactly equals available stock.
    const existingAfterLock = await tx.stockReservation.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey } },
    });
    if (
      existingAfterLock &&
      (existingAfterLock.status === RESERVATION_STATUS.ACTIVE || existingAfterLock.status === RESERVATION_STATUS.COMMITTED)
    ) {
      duplicates.push({
        reservationId: existingAfterLock.id,
        quotationItemId: line.id,
        enquiryItemId: line.enquiryItemId,
        productId: existingAfterLock.productId,
        quantity: existingAfterLock.quantity,
        allocations: parseJson<ReservationAllocation[]>(existingAfterLock.allocationsJson, []),
        status: existingAfterLock.status,
        duplicate: true,
      });
      continue;
    }

    if (remaining > 1e-9) {
      failures.push({
        quotationItemId: line.id,
        enquiryItemId: line.enquiryItemId,
        productId,
        description,
        required,
        available,
        reason: "Not enough unreserved stock across eligible locations.",
      });
      continue;
    }

    plans.push({ line, productId, required, allocations });
  }

  if (failures.length > 0) throw new InsufficientStockError(failures);

  for (const plan of plans) {
    const idempotencyKey = reservationIdempotencyKey(quotation.id, plan.line.id);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // The unique key is the concurrency gate: a second transaction inserting
    // the same line gets 0 rows and must not increment reserved stock.
    // A prior RELEASED/EXPIRED row owns the unique idempotency key. Reopen that
    // row atomically; if another worker already reopened or inserted it, the
    // conditional update returns 0 and we fall back to the duplicate path.
    const reopened = await tx.stockReservation.updateMany({
      where: {
        organizationId: input.organizationId,
        idempotencyKey,
        status: { in: [RESERVATION_STATUS.RELEASED, RESERVATION_STATUS.EXPIRED] },
      },
      data: {
        quotationId: quotation.id,
        quotationItemId: plan.line.id,
        enquiryItemId: plan.line.enquiryItemId,
        productId: plan.productId,
        quantity: plan.required,
        allocationsJson: stringifyJson(plan.allocations),
        status: RESERVATION_STATUS.ACTIVE,
        expiresAt,
        overrideReason: input.overrideReason ?? null,
        createdById: input.userId ?? null,
        releasedAt: null,
        releaseReason: null,
      },
    });
    const inserted = reopened.count > 0
      ? { count: 1 }
      : await tx.stockReservation.createMany({
          data: [
            {
              organizationId: input.organizationId,
              quotationId: quotation.id,
              quotationItemId: plan.line.id,
              enquiryItemId: plan.line.enquiryItemId,
              productId: plan.productId,
              quantity: plan.required,
              allocationsJson: stringifyJson(plan.allocations),
              status: RESERVATION_STATUS.ACTIVE,
              idempotencyKey,
              expiresAt,
              overrideReason: input.overrideReason ?? null,
              createdById: input.userId ?? null,
            },
          ],
          skipDuplicates: true,
        });

    if (inserted.count === 0) {
      const existing = await tx.stockReservation.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey } },
      });
      if (existing) {
        duplicates.push({
          reservationId: existing.id,
          quotationItemId: plan.line.id,
          enquiryItemId: plan.line.enquiryItemId,
          productId: existing.productId,
          quantity: existing.quantity,
          allocations: parseJson<ReservationAllocation[]>(existing.allocationsJson, []),
          status: existing.status,
          duplicate: true,
        });
      }
      continue;
    }

    for (const allocation of plan.allocations) {
      const updated = await tx.$executeRaw`
        UPDATE "InventoryStock"
           SET "quantityReserved" = "quantityReserved" + ${allocation.quantity},
               "lastUpdatedAt" = now()
         WHERE "organizationId" = ${input.organizationId}
           AND "productId" = ${plan.productId}
           AND "locationId" = ${allocation.locationId}
           AND ("quantityOnHand" - "quantityReserved") >= ${allocation.quantity}
      `;
      if (Number(updated) !== 1) {
        throw new Error(
          `Stock changed while reserving ${plan.line.description}; the approval was rolled back.`,
        );
      }
    }

    const reservation = await tx.stockReservation.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey } },
    });
    if (reservation) {
      created.push({
        reservationId: reservation.id,
        quotationItemId: plan.line.id,
        enquiryItemId: plan.line.enquiryItemId,
        productId: plan.productId,
        quantity: plan.required,
        allocations: plan.allocations,
        status: reservation.status,
        duplicate: false,
      });
    }
  }

  return { created, duplicates };
}

/** Convenience wrapper for callers that are not already inside a transaction. */
export async function reserveQuotationStock(input: {
  organizationId: string;
  quotationId: string;
  userId?: string | null;
  expiresAt?: Date;
}): Promise<{ created: ReservationLineResult[]; duplicates: ReservationLineResult[] }> {
  return db.$transaction((tx) =>
    reserveQuotationStockInTransaction(tx, {
      organizationId: input.organizationId,
      quotationId: input.quotationId,
      userId: input.userId,
      expiresAt: input.expiresAt,
    }),
  );
}

/**
 * Releases one reservation and returns each allocation to available stock. The
 * conditional status transition makes a repeated release a no-op.
 */
export async function releaseReservationInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    reservationId: string;
    reason?: string | null;
    finalStatus?: typeof RESERVATION_STATUS.RELEASED | typeof RESERVATION_STATUS.EXPIRED;
  },
): Promise<boolean> {
  const finalStatus = input.finalStatus ?? RESERVATION_STATUS.RELEASED;
  const reservation = await tx.stockReservation.findFirst({
    where: { id: input.reservationId, organizationId: input.organizationId },
  });
  if (!reservation) return false;

  const claimed = await tx.stockReservation.updateMany({
    where: { id: reservation.id, organizationId: input.organizationId, status: RESERVATION_STATUS.ACTIVE },
    data: {
      status: finalStatus,
      releasedAt: new Date(),
      releaseReason: input.reason?.slice(0, 900) ?? null,
    },
  });
  if (claimed.count === 0) return false;

  const allocations = parseJson<ReservationAllocation[]>(reservation.allocationsJson, []);
  for (const allocation of allocations) {
    const quantity = Number(allocation.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    await tx.$executeRaw`
      UPDATE "InventoryStock"
         SET "quantityReserved" = GREATEST(0, "quantityReserved" - ${quantity}),
             "lastUpdatedAt" = now()
       WHERE "organizationId" = ${input.organizationId}
         AND "productId" = ${reservation.productId}
         AND "locationId" = ${allocation.locationId}
    `;
  }
  return true;
}

/** Releases every active hold for a quotation (cancellation / superseded revision). */
export async function releaseQuotationReservationsInTransaction(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; quotationId: string; reason: string },
): Promise<number> {
  const reservations = await tx.stockReservation.findMany({
    where: {
      organizationId: input.organizationId,
      quotationId: input.quotationId,
      status: RESERVATION_STATUS.ACTIVE,
    },
    select: { id: true },
  });
  let released = 0;
  for (const reservation of reservations) {
    if (
      await releaseReservationInTransaction(tx, {
        organizationId: input.organizationId,
        reservationId: reservation.id,
        reason: input.reason,
      })
    ) {
      released += 1;
    }
  }
  return released;
}

export async function releaseQuotationReservations(input: {
  organizationId: string;
  quotationId: string;
  reason: string;
}): Promise<number> {
  return db.$transaction((tx) => releaseQuotationReservationsInTransaction(tx, input));
}

/** Marks a hold as an accepted commitment without changing the reserved quantity. */
export async function commitReservation(input: {
  organizationId: string;
  reservationId: string;
}): Promise<boolean> {
  const result = await db.stockReservation.updateMany({
    where: {
      id: input.reservationId,
      organizationId: input.organizationId,
      status: RESERVATION_STATUS.ACTIVE,
    },
    data: { status: RESERVATION_STATUS.COMMITTED },
  });
  return result.count > 0;
}

/** Expires stale holds across tenants. Each row is released in its own transaction. */
export async function expireStaleReservations(limit = 100): Promise<number> {
  const expired = await rawDb.stockReservation.findMany({
    where: { status: RESERVATION_STATUS.ACTIVE, expiresAt: { lt: new Date() } },
    select: { id: true, organizationId: true },
    take: Math.min(500, Math.max(1, limit)),
    orderBy: { expiresAt: "asc" },
  });

  let released = 0;
  for (const reservation of expired) {
    const done = await rawDb.$transaction((tx) =>
      releaseReservationInTransaction(tx, {
        organizationId: reservation.organizationId,
        reservationId: reservation.id,
        reason: "Reservation expired",
        finalStatus: RESERVATION_STATUS.EXPIRED,
      }),
    );
    if (done) released += 1;
  }
  return released;
}

/** Tenant-scoped view used by the quotation screen and tests. */
export async function activeReservationsForQuotation(quotationId: string) {
  return db.stockReservation.findMany({
    where: { quotationId, status: { in: [RESERVATION_STATUS.ACTIVE, RESERVATION_STATUS.COMMITTED] } },
    orderBy: { createdAt: "asc" },
  });
}

/** Aggregated free stock for one product across all eligible locations. */
export async function availableStockForProduct(input: {
  organizationId: string;
  productId: string;
}): Promise<number> {
  const rows = await rawDb.$queryRaw<Array<{ available: number }>>`
    SELECT COALESCE(SUM(s."quantityOnHand" - s."quantityReserved"), 0)::double precision AS available
      FROM "InventoryStock" s
      JOIN "InventoryLocation" l
        ON l.id = s."locationId" AND l."organizationId" = s."organizationId"
     WHERE s."organizationId" = ${input.organizationId}
       AND s."productId" = ${input.productId}
  `;
  return Math.max(0, Number(rows[0]?.available ?? 0));
}

export type ReservationError = { code: "INSUFFICIENT_STOCK" | "NOT_FOUND"; message: string };
