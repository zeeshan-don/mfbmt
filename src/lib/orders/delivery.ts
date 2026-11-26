import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { sha256 } from "../crypto";
import { nextNumber } from "../workflow/sequences";
import { dec, qty, sum } from "./money";
import { orderMetrics } from "./metrics";
import { recordOrderEvent } from "./events";
import { refreshSalesOrderStatus } from "./state";
import { lockSalesOrder, lockStockForProduct, OrderLockError } from "./locks";

/**
 * Customer dispatch and delivery.
 *
 * Quantities are checked against accepted stock plus inspected supplier
 * receipts, per sales-order line. A delivery starts DISPATCHED and becomes
 * DELIVERED only with recorded proof; a partial delivery never marks the whole
 * order delivered.
 */

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export type DeliveryLineInput = { salesOrderLineId: string; quantity: number | string };

export type RecordDeliveryInput = {
  salesOrderId: string;
  lines: DeliveryLineInput[];
  dispatchedAt?: Date | string | null;
  carrier?: string | null;
  vehicleRef?: string | null;
  trackingRef?: string | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
};

class DeliveryStockError extends Error {}

async function consumeStock(
  tx: Prisma.TransactionClient,
  input: { productId: string; quantity: ReturnType<typeof qty>; deliveryId: string; userId: string },
): Promise<void> {
  let remaining = input.quantity;
  // Lock the stock rows in deterministic location/id order, then decrement with
  // a conditional update that cannot take on-hand stock below zero.
  const rows = await lockStockForProduct(tx, input.productId);
  for (const row of rows) {
    if (remaining.lte(0)) break;
    const onHand = qty(row.quantityOnHand);
    const take = qty(remaining.lte(onHand) ? remaining : onHand);
    if (take.lte(0)) continue;
    const reserved = qty(row.quantityReserved);
    const updated = await tx.inventoryStock.updateMany({
      where: { id: row.id, quantityOnHand: { gte: Number(take) } },
      data: {
        quantityOnHand: { decrement: Number(take) },
        // The quotation hold becomes a real dispatch; release the hold with the
        // stock so the same quantity is never counted as both reserved and gone.
        quantityReserved: { decrement: Number(reserved.gte(take) ? take : reserved) },
        lastUpdatedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw new DeliveryStockError(`Stock for the line changed while dispatching; reload and try again.`);
    }
    await tx.inventoryMovement.create({
      data: {
        productId: input.productId,
        locationId: row.locationId,
        delta: -Number(take),
        reason: "CUSTOMER_DELIVERY",
        refType: "Delivery",
        refId: input.deliveryId,
        userId: input.userId,
      },
    });
    remaining = qty(remaining.minus(take));
  }
  if (remaining.gt(0)) {
    throw new DeliveryStockError(`Stock for the line is no longer available (missing ${remaining.toFixed(4)}).`);
  }
}

export type RecordDeliveryResult =
  | { ok: true; deliveryId: string; deliveryNumber: string; duplicate: boolean }
  | { ok: false; error: string };

export async function recordDelivery(input: RecordDeliveryInput): Promise<RecordDeliveryResult> {
  const order = await db.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!order) return { ok: false, error: "Sales order not found." };
  if (order.status === "CLOSED" || order.status === "CANCELLED") {
    return { ok: false, error: "This sales order is closed; no further delivery can be recorded." };
  }
  if (input.lines.length === 0) return { ok: false, error: "Add at least one delivered line." };

  const signature = sha256(
    JSON.stringify({
      orderId: order.id,
      lines: [...input.lines].sort((a, b) => a.salesOrderLineId.localeCompare(b.salesOrderLineId)),
    }),
  );
  const idempotencyKey = input.idempotencyKey?.trim() || `delivery:${order.id}:${signature.slice(0, 32)}`;
  const existing = await db.delivery.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: order.organizationId, idempotencyKey } },
  });
  if (existing) return { ok: true, deliveryId: existing.id, deliveryNumber: existing.deliveryNumber, duplicate: true };

  const prepared: Array<{
    salesOrderLineId: string;
    quantity: ReturnType<typeof qty>;
    productId: string | null;
    stockPortion: ReturnType<typeof qty>;
  }> = [];

  for (const line of input.lines) {
    const orderLine = order.lines.find((candidate) => candidate.id === line.salesOrderLineId);
    if (!orderLine) return { ok: false, error: "A delivery line does not belong to this sales order." };
    const requested = qty(line.quantity);
    if (requested.lte(0)) return { ok: false, error: `Delivery quantity for "${orderLine.description}" must be positive.` };
    // Accepted supplier receipts are posted to inventory, so the whole
    // dispatched quantity is consumed from stock, not only the part that came
    // from the order's opening stock position.
    prepared.push({
      salesOrderLineId: orderLine.id,
      quantity: requested,
      productId: orderLine.productId,
      stockPortion: requested,
    });
  }

  const deliveryNumber = await nextNumber("DN");
  const dispatchedAtRaw = input.dispatchedAt ? new Date(input.dispatchedAt) : new Date();
  const dispatchedAt = Number.isNaN(dispatchedAtRaw.getTime()) ? new Date() : dispatchedAtRaw;

  try {
    const created = await db.$transaction(async (tx) => {
      // Serialize dispatch with closure, receipts and other dispatches. The
      // availability calculation is repeated inside the lock, never trusted from
      // the stale read above.
      const lockedOrder = await lockSalesOrder(tx, order.id);
      const metrics = await orderMetrics(tx, lockedOrder.id);
      for (const line of prepared) {
        const metric = metrics.lines.find((candidate) => candidate.id === line.salesOrderLineId);
        if (!metric) throw new DeliveryStockError("Fulfilment state for a delivery line is unavailable.");
        if (line.quantity.gt(metric.availableToDispatch)) {
          throw new DeliveryStockError(
            `Only ${metric.availableToDispatch.toFixed(4)} ${metric.unit} of "${metric.description}" is available to dispatch (accepted stock and inspected receipts minus what already left).`,
          );
        }
      }

      const delivery = await tx.delivery.create({
        data: {
          deliveryNumber,
          idempotencyKey,
          salesOrderId: order.id,
          status: "DISPATCHED",
          dispatchedAt,
          carrier: input.carrier?.trim() || null,
          vehicleRef: input.vehicleRef?.trim() || null,
          trackingRef: input.trackingRef?.trim() || null,
          deliveryAddress: input.deliveryAddress?.trim() || order.deliveryAddress,
          notes: input.notes?.trim() || null,
          recordedById: input.userId,
          lines: {
            create: prepared.map((line) => ({
              salesOrderLineId: line.salesOrderLineId,
              quantity: line.quantity,
            })),
          },
        },
      });

      for (const line of prepared) {
        if (line.productId && line.stockPortion.gt(0)) {
          await consumeStock(tx, {
            productId: line.productId,
            quantity: line.stockPortion,
            deliveryId: delivery.id,
            userId: input.userId,
          });
        }
      }

      await recordOrderEvent(tx, {
        entityType: "SalesOrder",
        entityId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: `Dispatch ${deliveryNumber}`,
        meta: { deliveryId: delivery.id, lines: prepared.map((line) => ({ id: line.salesOrderLineId, quantity: line.quantity.toFixed(4) })) },
      });
      await refreshSalesOrderStatus(tx, order.id, { id: input.userId, label: input.actorLabel });
      return delivery;
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "delivery.dispatched",
      entityType: "Delivery",
      entityId: created.id,
      meta: {
        deliveryNumber: created.deliveryNumber,
        salesOrderId: order.id,
        lines: prepared.map((line) => ({ lineId: line.salesOrderLineId, quantity: line.quantity.toFixed(4) })),
      },
    });
    return { ok: true, deliveryId: created.id, deliveryNumber: created.deliveryNumber, duplicate: false };
  } catch (error) {
    if (error instanceof DeliveryStockError) return { ok: false, error: error.message };
    if (error instanceof OrderLockError) return { ok: false, error: error.message };
    if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
      const raced = await db.delivery.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: order.organizationId, idempotencyKey } },
      });
      if (raced) return { ok: true, deliveryId: raced.id, deliveryNumber: raced.deliveryNumber, duplicate: true };
    }
    throw error;
  }
}

/** Records proof of delivery for one dispatch and recomputes the order state. */
export async function recordProofOfDelivery(input: {
  deliveryId: string;
  deliveredAt?: Date | string | null;
  receivedBy?: string | null;
  proofPath?: string | null;
  notes?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const delivery = await db.delivery.findUnique({ where: { id: input.deliveryId } });
  if (!delivery) return { ok: false, error: "Delivery not found." };
  if (delivery.status === "DELIVERED") return { ok: true, status: "DELIVERED" };
  if (delivery.status === "CANCELLED") return { ok: false, error: "This delivery was cancelled." };

  const deliveredAtRaw = input.deliveredAt ? new Date(input.deliveredAt) : new Date();
  const deliveredAt = Number.isNaN(deliveredAtRaw.getTime()) ? new Date() : deliveredAtRaw;

  const applied = await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, delivery.salesOrderId);
    const claimed = await tx.delivery.updateMany({
      where: { id: delivery.id, status: "DISPATCHED" },
      data: {
        status: "DELIVERED",
        deliveredAt,
        receivedBy: input.receivedBy?.trim() || null,
        proofOfDeliveryPath: input.proofPath?.trim() || null,
      },
    });
    if (claimed.count === 0) return false;
    await recordOrderEvent(tx, {
      entityType: "SalesOrder",
      entityId: delivery.salesOrderId,
      fromStatus: null,
      toStatus: "DELIVERED",
      actorId: input.userId,
      actorLabel: input.actorLabel,
      reason: `Proof of delivery for ${delivery.deliveryNumber}`,
      meta: { deliveryId: delivery.id, receivedBy: input.receivedBy ?? null, proofPath: input.proofPath ?? null, notes: input.notes ?? null },
    });
    await refreshSalesOrderStatus(tx, delivery.salesOrderId, { id: input.userId, label: input.actorLabel });
    return true;
  });
  if (!applied) return { ok: false, error: "This delivery was already recorded as delivered." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "delivery.proof_recorded",
    entityType: "Delivery",
    entityId: delivery.id,
    meta: { receivedBy: input.receivedBy ?? null, proofPath: input.proofPath ?? null },
  });
  if (!input.proofPath?.trim()) {
    await notifyOwner({
      type: "PROOF_OF_DELIVERY_MISSING",
      title: "Delivery marked delivered without a document",
      body: `${delivery.deliveryNumber} was marked delivered but no signed proof file was recorded.`,
      link: `/orders/${delivery.salesOrderId}`,
    });
  }
  return { ok: true, status: "DELIVERED" };
}

export async function deliveriesForOrder(salesOrderId: string) {
  return db.delivery.findMany({
    where: { salesOrderId },
    orderBy: { dispatchedAt: "desc" },
    include: { lines: { include: { salesOrderLine: { select: { description: true, unit: true } } } } },
  });
}

/** Delivery notes as a printable text block (stored/displayed, never emailed automatically). */
export function deliveryNoteText(input: {
  organizationName: string;
  deliveryNumber: string;
  orderNumber: string;
  customerName: string;
  deliveryAddress: string | null;
  lines: Array<{ description: string; quantity: number; unit: string }>;
}): string {
  return [
    `${input.organizationName}`,
    `DELIVERY NOTE ${input.deliveryNumber}`,
    `Sales order: ${input.orderNumber}`,
    `Customer: ${input.customerName}`,
    input.deliveryAddress ? `Deliver to: ${input.deliveryAddress}` : "",
    "",
    ...input.lines.map((line) => `- ${line.description}: ${line.quantity} ${line.unit}`),
    "",
    "Received by: ____________________    Date: ____________",
  ]
    .filter(Boolean)
    .join("\n");
}

export { dec, sum };
