import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { stringifyJson } from "../json";
import { sha256 } from "../crypto";
import { nextNumber } from "../workflow/sequences";
import { dec, money, qty, sum } from "./money";
import { recordOrderEvent, transitionPurchaseOrder } from "./events";
import { refreshSalesOrderStatus } from "./state";
import { lockPurchaseOrder, lockSalesOrder, OrderLockError } from "./locks";

/**
 * Goods receipt.
 *
 * Accepted quantities are posted to inventory transactionally; rejected,
 * damaged or wrong quantities are kept out of usable stock and recorded as an
 * open discrepancy. A receipt is idempotent: replaying the same key returns the
 * existing receipt and never posts the same stock twice.
 */

export const RECEIPT_CONDITIONS = ["OK", "DAMAGED", "WRONG_PRODUCT", "WRONG_SPEC", "SHORT", "EXCESS"] as const;
export type ReceiptCondition = (typeof RECEIPT_CONDITIONS)[number];

export type GoodsReceiptLineInput = {
  purchaseOrderLineId: string;
  quantityReceived: number | string;
  quantityAccepted?: number | string | null;
  quantityRejected?: number | string | null;
  condition?: ReceiptCondition | string | null;
  inspectionResult?: "PASSED" | "FAILED" | "PARTIAL" | string | null;
  batchNo?: string | null;
  discrepancyNote?: string | null;
};

export type RecordGoodsReceiptInput = {
  purchaseOrderId: string;
  lines: GoodsReceiptLineInput[];
  receivedAt?: Date | string | null;
  deliveryNoteRef?: string | null;
  condition?: string | null;
  inspectionResult?: string | null;
  notes?: string | null;
  photoPath?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
};

const NON_USABLE_CONDITIONS = new Set(["DAMAGED", "WRONG_PRODUCT", "WRONG_SPEC"]);

function receiptKey(poId: string, lines: GoodsReceiptLineInput[], deliveryNoteRef: string | null): string {
  const signature = sha256(
    JSON.stringify({
      poId,
      deliveryNoteRef,
      lines: lines
        .map((line) => ({
          id: line.purchaseOrderLineId,
          received: String(line.quantityReceived),
          accepted: line.quantityAccepted == null ? null : String(line.quantityAccepted),
          rejected: line.quantityRejected == null ? null : String(line.quantityRejected),
          condition: line.condition ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
  return `gr:${poId}:${signature.slice(0, 32)}`;
}

async function postAcceptedStock(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    quantity: ReturnType<typeof qty>;
    receiptId: string;
    userId: string;
  },
): Promise<void> {
  if (input.quantity.lte(0)) return;
  let location = await tx.inventoryLocation.findFirst({ orderBy: { code: "asc" } });
  if (!location) {
    location = await tx.inventoryLocation.create({ data: { code: "MAIN", name: "Main store" } });
  }
  await tx.inventoryStock.upsert({
    where: { productId_locationId: { productId: input.productId, locationId: location.id } },
    update: { quantityOnHand: { increment: Number(input.quantity) }, lastUpdatedAt: new Date() },
    create: {
      productId: input.productId,
      locationId: location.id,
      quantityOnHand: Number(input.quantity),
      source: "ADJUSTMENT",
    },
  });
  await tx.inventoryMovement.create({
    data: {
      productId: input.productId,
      locationId: location.id,
      delta: Number(input.quantity),
      reason: "GOODS_RECEIPT",
      refType: "GoodsReceipt",
      refId: input.receiptId,
      userId: input.userId,
    },
  });
}

export type RecordGoodsReceiptResult =
  | {
      ok: true;
      receiptId: string;
      receiptNumber: string;
      duplicate: boolean;
      discrepancies: Array<{ code: string; detail: string }>;
    }
  | { ok: false; error: string };

export async function recordGoodsReceipt(input: RecordGoodsReceiptInput): Promise<RecordGoodsReceiptResult> {
  const po = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: {
      supplier: true,
      salesOrder: true,
      lines: { include: { salesOrderLine: true } },
    },
  });
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (po.status === "AWAITING_APPROVAL" || po.status === "APPROVED") {
    return { ok: false, error: "This purchase order has not been sent to the supplier yet." };
  }
  if (po.status === "CANCELLED" || po.status === "REJECTED") {
    return { ok: false, error: "A receipt cannot be recorded against a cancelled or rejected purchase order." };
  }
  if (input.lines.length === 0) return { ok: false, error: "Add at least one received line." };

  const deliveryNoteRef = input.deliveryNoteRef?.trim() || null;
  const idempotencyKey = input.idempotencyKey?.trim() || receiptKey(po.id, input.lines, deliveryNoteRef);
  const existing = await db.goodsReceipt.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: po.organizationId, idempotencyKey } },
    include: { lines: true },
  });
  if (existing) {
    return { ok: true, receiptId: existing.id, receiptNumber: existing.receiptNumber, duplicate: true, discrepancies: [] };
  }

  const receivedBefore = await db.goodsReceiptLine.findMany({
    where: { purchaseOrderLine: { purchaseOrderId: po.id } },
    select: { purchaseOrderLineId: true, quantityAccepted: true },
  });
  const acceptedBefore = new Map<string, ReturnType<typeof qty>>();
  for (const row of receivedBefore) {
    acceptedBefore.set(row.purchaseOrderLineId, (acceptedBefore.get(row.purchaseOrderLineId) ?? qty(0)).plus(qty(row.quantityAccepted)));
  }

  type PreparedLine = {
    purchaseOrderLineId: string;
    quantityOrdered: ReturnType<typeof qty>;
    quantityReceived: ReturnType<typeof qty>;
    quantityAccepted: ReturnType<typeof qty>;
    quantityRejected: ReturnType<typeof qty>;
    batchNo: string | null;
    condition: string;
    inspectionResult: string | null;
    discrepancyType: string | null;
    discrepancyNote: string | null;
    productId: string | null;
  };

  const prepared: PreparedLine[] = [];
  const discrepancies: Array<{ code: string; detail: string }> = [];

  for (const line of input.lines) {
    const poLine = po.lines.find((candidate) => candidate.id === line.purchaseOrderLineId);
    if (!poLine) return { ok: false, error: "A received line does not belong to this purchase order." };

    const ordered = qty(poLine.quantity);
    const alreadyAccepted = acceptedBefore.get(poLine.id) ?? qty(0);
    const remaining = qty(ordered.minus(alreadyAccepted));
    const received = qty(line.quantityReceived);
    if (received.lte(0)) return { ok: false, error: `Received quantity for "${poLine.description}" must be positive.` };

    const condition = (line.condition ?? input.condition ?? "OK").toString().toUpperCase();
    if (!RECEIPT_CONDITIONS.includes(condition as ReceiptCondition)) {
      return { ok: false, error: `Unknown condition "${condition}" for "${poLine.description}".` };
    }

    const declaredAccepted =
      line.quantityAccepted != null && String(line.quantityAccepted).trim() !== "" ? qty(Number(line.quantityAccepted)) : received;
    const declaredRejected =
      line.quantityRejected != null && String(line.quantityRejected).trim() !== ""
        ? qty(Number(line.quantityRejected))
        : qty(received.minus(declaredAccepted));

    if (declaredAccepted.lt(0) || declaredRejected.lt(0)) {
      return { ok: false, error: `Accepted and rejected quantities cannot be negative (${poLine.description}).` };
    }
    if (!declaredAccepted.plus(declaredRejected).equals(received)) {
      return { ok: false, error: `For "${poLine.description}", accepted + rejected must equal the received quantity.` };
    }

    // A damaged or wrong delivery is never posted as usable stock, even if the
    // caller asked to accept it. It stays visible as a discrepancy to resolve.
    let accepted = declaredAccepted;
    let rejected = declaredRejected;
    let discrepancyType: string | null = null;
    let discrepancyNote: string | null = line.discrepancyNote?.trim() || null;

    if (NON_USABLE_CONDITIONS.has(condition)) {
      if (accepted.gt(0)) {
        rejected = qty(rejected.plus(accepted));
        accepted = qty(0);
        discrepancyNote = [discrepancyNote, "Quantity was not accepted into usable stock."].filter(Boolean).join(" ");
      }
      discrepancyType = condition;
      discrepancies.push({
        code: condition,
        detail: `${poLine.description}: ${received.toFixed(4)} ${poLine.unit} recorded as ${condition.replaceAll("_", " ").toLowerCase()}.`,
      });
    }

    if (remaining.lte(0)) {
      discrepancies.push({
        code: "EXCESS",
        detail: `${poLine.description}: the full ordered quantity was already accepted; this delivery is excess.`,
      });
      discrepancyType = discrepancyType ?? "EXCESS";
      rejected = qty(rejected.plus(accepted));
      accepted = qty(0);
    } else if (accepted.gt(remaining)) {
      const excess = qty(accepted.minus(remaining));
      accepted = remaining;
      rejected = qty(rejected.plus(excess));
      discrepancyType = discrepancyType ?? "EXCESS";
      discrepancies.push({
        code: "EXCESS",
        detail: `${poLine.description}: ${excess.toFixed(4)} ${poLine.unit} exceeds the remaining ordered quantity and was not added to stock.`,
      });
    }

    if (received.lt(ordered.minus(alreadyAccepted)) && condition === "OK") {
      discrepancyType = discrepancyType ?? "SHORT";
      discrepancies.push({
        code: "SHORT",
        detail: `${poLine.description}: received ${received.toFixed(4)} of the remaining ${remaining.toFixed(4)} ${poLine.unit}.`,
      });
    }

    if (line.inspectionResult === "FAILED" && accepted.gt(0)) {
      rejected = qty(rejected.plus(accepted));
      accepted = qty(0);
      discrepancyType = discrepancyType ?? "INSPECTION_FAILED";
      discrepancies.push({
        code: "INSPECTION_FAILED",
        detail: `${poLine.description}: inspection failed; nothing was added to usable stock.`,
      });
    }

    prepared.push({
      purchaseOrderLineId: poLine.id,
      quantityOrdered: ordered,
      quantityReceived: received,
      quantityAccepted: accepted,
      quantityRejected: rejected,
      batchNo: line.batchNo?.trim() || null,
      condition,
      inspectionResult: line.inspectionResult ?? input.inspectionResult ?? null,
      discrepancyType,
      discrepancyNote,
      productId: poLine.salesOrderLine.productId,
    });
  }

  const receiptNumber = await nextNumber("GR");
  const receivedAtRaw = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const receivedAt = Number.isNaN(receivedAtRaw.getTime()) ? new Date() : receivedAtRaw;

  try {
    const created = await db.$transaction(async (tx) => {
      // Serialize receipts for one purchase order. The remaining quantity is
      // re-read under the lock, so two simultaneous deliveries cannot both
      // accept stock against the same ordered quantity.
      // Same order -> PO lock order as closure, procurement and dispatch.
      await lockSalesOrder(tx, po.salesOrderId);
      const lockedPo = await lockPurchaseOrder(tx, po.id);
      if (!lockedPo) throw new Error("Purchase order not found.");
      const acceptedNow = new Map<string, ReturnType<typeof qty>>();
      const posted = await tx.goodsReceiptLine.findMany({
        where: { purchaseOrderLine: { purchaseOrderId: po.id } },
        select: { purchaseOrderLineId: true, quantityAccepted: true },
      });
      for (const row of posted) {
        acceptedNow.set(row.purchaseOrderLineId, (acceptedNow.get(row.purchaseOrderLineId) ?? qty(0)).plus(qty(row.quantityAccepted)));
      }
      for (const line of prepared) {
        const remaining = qty(line.quantityOrdered.minus(acceptedNow.get(line.purchaseOrderLineId) ?? qty(0)));
        if (remaining.lte(0)) {
          line.quantityRejected = qty(line.quantityRejected.plus(line.quantityAccepted));
          line.quantityAccepted = qty(0);
          line.discrepancyType = line.discrepancyType ?? "EXCESS";
          discrepancies.push({
            code: "EXCESS",
            detail: `${line.purchaseOrderLineId}: the ordered quantity was already fully accepted by a concurrent receipt; this delivery is excess.`,
          });
        } else if (line.quantityAccepted.gt(remaining)) {
          const excess = qty(line.quantityAccepted.minus(remaining));
          line.quantityAccepted = remaining;
          line.quantityRejected = qty(line.quantityRejected.plus(excess));
          line.discrepancyType = line.discrepancyType ?? "EXCESS";
          discrepancies.push({
            code: "EXCESS",
            detail: `${line.purchaseOrderLineId}: ${excess.toFixed(4)} exceeded the remaining ordered quantity and was not added to stock.`,
          });
        }
      }

      const receipt = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          idempotencyKey,
          purchaseOrderId: po.id,
          supplierId: po.supplierId,
          receivedAt,
          deliveryNoteRef,
          condition: input.condition?.toUpperCase() || "OK",
          inspectionResult: input.inspectionResult ?? null,
          notes: input.notes?.trim() || null,
          photoPath: input.photoPath?.trim() || null,
          recordedById: input.userId,
          lines: {
            create: prepared.map((line) => ({
              purchaseOrderLineId: line.purchaseOrderLineId,
              quantityOrdered: line.quantityOrdered,
              quantityReceived: line.quantityReceived,
              quantityAccepted: line.quantityAccepted,
              quantityRejected: line.quantityRejected,
              batchNo: line.batchNo,
              condition: line.condition,
              inspectionResult: line.inspectionResult,
              discrepancyType: line.discrepancyType,
              discrepancyNote: line.discrepancyNote,
            })),
          },
        },
      });

      for (const line of prepared) {
        if (line.productId && line.quantityAccepted.gt(0)) {
          await postAcceptedStock(tx, {
            productId: line.productId,
            quantity: line.quantityAccepted,
            receiptId: receipt.id,
            userId: input.userId,
          });
        }
      }

      for (const discrepancy of discrepancies) {
        await tx.orderDiscrepancy.create({
          data: {
            entityType: "GoodsReceipt",
            entityId: receipt.id,
            salesOrderId: po.salesOrderId,
            code: discrepancy.code,
            severity: "BLOCKING",
            status: "OPEN",
            detailJson: stringifyJson({ ...discrepancy, purchaseOrderId: po.id, receiptNumber }),
            note: discrepancy.detail,
          },
        });
      }

      const after = await tx.goodsReceiptLine.findMany({
        where: { purchaseOrderLine: { purchaseOrderId: po.id } },
        select: { purchaseOrderLineId: true, quantityAccepted: true },
      });
      const acceptedTotals = new Map<string, ReturnType<typeof qty>>();
      for (const row of after) {
        acceptedTotals.set(row.purchaseOrderLineId, (acceptedTotals.get(row.purchaseOrderLineId) ?? qty(0)).plus(qty(row.quantityAccepted)));
      }
      const fullyReceived = po.lines.every((poLine) => (acceptedTotals.get(poLine.id) ?? qty(0)).gte(qty(poLine.quantity)));
      if (fullyReceived) {
        // A partial receipt is legitimately short until the balance arrives.
        // Once the PO is fully accepted, that short-delivery record is settled
        // by the records themselves rather than left blocking closure.
        await tx.orderDiscrepancy.updateMany({
          where: {
            salesOrderId: po.salesOrderId,
            entityType: "GoodsReceipt",
            code: "SHORT",
            status: "OPEN",
            detailJson: { contains: po.id },
          },
          data: {
            status: "RESOLVED",
            resolvedById: input.userId,
            resolvedAt: new Date(),
            resolutionNote: "Remaining ordered quantity received; the delivery is no longer short.",
          },
        });
      }
      await transitionPurchaseOrder(tx, {
        purchaseOrderId: po.id,
        toStatus: fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED",
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: `Goods receipt ${receiptNumber}`,
        meta: { receiptId: receipt.id, discrepancies: discrepancies.length },
      });
      await refreshSalesOrderStatus(tx, po.salesOrderId, { id: input.userId, label: input.actorLabel });
      return receipt;
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "goods_receipt.posted",
      entityType: "GoodsReceipt",
      entityId: created.id,
      meta: {
        receiptNumber: created.receiptNumber,
        purchaseOrderId: po.id,
        lines: prepared.map((line) => ({
          lineId: line.purchaseOrderLineId,
          received: line.quantityReceived.toFixed(4),
          accepted: line.quantityAccepted.toFixed(4),
          rejected: line.quantityRejected.toFixed(4),
          condition: line.condition,
        })),
        discrepancies,
      },
    });
    if (discrepancies.length > 0) {
      await notifyOwner({
        type: "GOODS_RECEIPT_DISCREPANCY",
        title: "A goods receipt has a discrepancy",
        body: `${po.poNumber} — ${discrepancies.length} issue(s) need review. Rejected quantity was not added to usable stock.`,
        link: `/orders/${po.salesOrderId}`,
      });
    }
    return { ok: true, receiptId: created.id, receiptNumber: created.receiptNumber, duplicate: false, discrepancies };
  } catch (error) {
    if (error instanceof OrderLockError) return { ok: false, error: error.message };
    if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
      const raced = await db.goodsReceipt.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: po.organizationId, idempotencyKey } },
      });
      if (raced) {
        return { ok: true, receiptId: raced.id, receiptNumber: raced.receiptNumber, duplicate: true, discrepancies: [] };
      }
    }
    throw error;
  }
}

/** Received totals for one purchase order (for the receipt form and display). */
export async function purchaseOrderReceiptState(purchaseOrderId: string) {
  const po = await db.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      lines: { orderBy: { lineNo: "asc" }, include: { receiptLines: true, salesOrderLine: true } },
      supplier: { select: { name: true } },
    },
  });
  if (!po) return null;
  return {
    purchaseOrder: po,
    lines: po.lines.map((line) => {
      const accepted = qty(sum(line.receiptLines.map((row) => row.quantityAccepted)));
      const rejected = qty(sum(line.receiptLines.map((row) => row.quantityRejected)));
      return {
        id: line.id,
        description: line.description,
        unit: line.unit,
        ordered: Number(qty(line.quantity)),
        accepted: Number(accepted),
        rejected: Number(rejected),
        remaining: Number(qty(line.quantity).minus(accepted)),
      };
    }),
  };
}

/** Open receipt discrepancies for an order. */
export async function openReceiptDiscrepancies(salesOrderId: string) {
  return db.orderDiscrepancy.findMany({
    where: { salesOrderId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
}

/** Utility used by tests and the UI: accepted stock for a product. */
export async function stockOnHand(productId: string): Promise<number> {
  const rows = await db.inventoryStock.findMany({ where: { productId }, select: { quantityOnHand: true } });
  return Number(sum(rows.map((row) => dec(row.quantityOnHand))).toFixed(4));
}

export function recordReceiptEvent(
  tx: Prisma.TransactionClient,
  input: { salesOrderId: string; receiptId: string; receiptNumber: string; actorId: string; actorLabel: string },
) {
  return recordOrderEvent(tx, {
    entityType: "SalesOrder",
    entityId: input.salesOrderId,
    fromStatus: null,
    toStatus: "PARTIALLY_RECEIVED",
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    reason: `Goods receipt ${input.receiptNumber}`,
    meta: { receiptId: input.receiptId },
  });
}

export function acceptedValue(lines: Array<{ quantityAccepted: unknown; unitPrice: unknown }>): ReturnType<typeof money> {
  return money(sum(lines.map((line) => qty(line.quantityAccepted as number).times(dec(line.unitPrice as number)))));
}
