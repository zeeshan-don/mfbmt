import type { Prisma } from "@prisma/client";
import { stringifyJson } from "../json";

/**
 * Records a durable order-lifecycle transition. Status changes are never
 * inferred later from timestamps: each one carries the acting identity, the
 * previous and new state, and an optional reason.
 */
export async function recordOrderEvent(
  tx: Prisma.TransactionClient,
  input: {
    entityType: "SalesOrder" | "PurchaseOrder" | "CustomerInvoice" | "SupplierBill";
    entityId: string;
    fromStatus: string | null;
    toStatus: string;
    actorId?: string | null;
    actorLabel?: string;
    reason?: string | null;
    meta?: Record<string, unknown>;
    salesOrderId?: string | null;
  },
): Promise<void> {
  await tx.orderStatusEvent.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      salesOrderId: input.salesOrderId ?? (input.entityType === "SalesOrder" ? input.entityId : null),
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? "system",
      reason: input.reason?.trim() || null,
      metaJson: stringifyJson(input.meta ?? {}),
    },
  });
}

/** Applies a status change inside a transaction and records it once. */
export async function transitionPurchaseOrder(
  tx: Prisma.TransactionClient,
  input: {
    purchaseOrderId: string;
    toStatus: string;
    actorId?: string | null;
    actorLabel?: string;
    reason?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<boolean> {
  const current = await tx.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    select: { status: true },
  });
  if (!current || current.status === input.toStatus) return false;
  const updated = await tx.purchaseOrder.updateMany({
    where: { id: input.purchaseOrderId, status: current.status },
    data: { status: input.toStatus },
  });
  if (updated.count === 0) return false;
  await recordOrderEvent(tx, {
    entityType: "PurchaseOrder",
    entityId: input.purchaseOrderId,
    fromStatus: current.status,
    toStatus: input.toStatus,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    reason: input.reason,
    meta: input.meta,
  });
  return true;
}
