import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { nextNumber } from "../workflow/sequences";
import { sha256 } from "../crypto";
import { supplierSendGuard } from "../suppliers/sendGuard";
import { sendEmail } from "../email/send";
import { outboundOperationKey, sendOutboundOnce } from "../outbound/messages";
import { dec, lineTotals, money, qty, sum, toMoneyString } from "./money";
import { coverageForPurchaseOrderLine, orderMetrics } from "./metrics";
import { lockPurchaseOrder, lockSalesOrder, OrderLockError } from "./locks";
import { recordOrderEvent, transitionPurchaseOrder } from "./events";
import { refreshSalesOrderStatus } from "./state";
import { correlationReference, correlationTokenFor } from "./tokens";

/**
 * Supplier purchase orders.
 *
 * A PO exists only for quantities that are not covered by stock, uses a
 * supplier offer the owner has verified, and is approved by the owner before it
 * is transmitted. Sending goes through the existing outbound ledger so a retry
 * or double click cannot transmit the same purchase commitment twice.
 */

export const PURCHASE_ORDER_STATUS_LABELS: Record<string, string> = {
  AWAITING_APPROVAL: "Awaiting owner approval",
  APPROVED: "Approved, not sent",
  SENT: "Sent — awaiting supplier",
  ACKNOWLEDGEMENT_RECEIVED: "Supplier replied — needs review",
  ACKNOWLEDGED: "Acknowledged",
  PARTIALLY_ACKNOWLEDGED: "Partly acknowledged",
  REJECTED: "Rejected by supplier",
  REVISED: "Supplier terms approved",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export type OfferForPurchase = {
  id: string;
  supplierId: string | null;
  status: string;
  verificationStatus: string;
  matchStatus: string;
  unitPrice: number | null;
  currency: string | null;
  moq: number | null;
  leadTimeDays: number | null;
  validityDate: Date | null;
  quantityAvailable: number | null;
  deliveryLocation: string | null;
  paymentTerms: string | null;
};

export function supplierOfferBlocker(offer: OfferForPurchase, now = new Date()): string | null {
  if (!offer.supplierId) return "The supplier offer is not linked to a supplier record.";
  if (offer.verificationStatus !== "VERIFIED") return "The supplier offer has not been owner-verified.";
  if (!["QUOTE_RECEIVED", "PRICE_CONFIRMED", "VERIFIED"].includes(offer.status)) {
    return `The supplier offer is "${offer.status}" rather than a confirmed quotation.`;
  }
  if (offer.unitPrice == null || !(offer.unitPrice > 0)) return "The supplier offer has no confirmed unit price.";
  if (offer.validityDate && offer.validityDate.getTime() < now.getTime()) {
    return "The supplier quotation has expired; request a fresh quotation before creating a purchase order.";
  }
  if (!["EXACT", "EQUIVALENT"].includes(offer.matchStatus)) {
    return "The technical match has not been verified as exact or an approved equivalent.";
  }
  return null;
}

export type ProcurementPlanLine = {
  salesOrderLineId: string;
  lineNo: number;
  description: string;
  unit: string;
  orderedQuantity: number;
  stockQuantity: number;
  procureQuantity: number;
  alreadyOrdered: number;
  remainingToOrder: number;
  approvedOfferId: string | null;
  approvedOffer: {
    id: string;
    supplierId: string | null;
    supplierName: string;
    unitPrice: number | null;
    currency: string | null;
    moq: number | null;
    leadTimeDays: number | null;
    validityDate: Date | null;
    eligible: boolean;
    blocker: string | null;
  } | null;
  candidates: Array<{
    id: string;
    supplierId: string | null;
    supplierName: string;
    unitPrice: number | null;
    currency: string | null;
    moq: number | null;
    leadTimeDays: number | null;
    validityDate: Date | null;
    eligible: boolean;
    blocker: string | null;
  }>;
};

/**
 * What each sales-order line still needs from suppliers, after stock cover and
 * purchase orders already raised. Split procurement is preserved per line.
 */
export async function procurementPlan(salesOrderId: string): Promise<{
  order: { id: string; orderNumber: string; currency: string; status: string };
  lines: ProcurementPlanLine[];
} | null> {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!order) return null;

  const enquiryItemIds = order.lines.map((line) => line.enquiryItemId).filter((id): id is string => Boolean(id));
  const [items, offers] = await Promise.all([
    enquiryItemIds.length
      ? db.enquiryItem.findMany({ where: { id: { in: enquiryItemIds } }, select: { id: true, approvedOfferId: true } })
      : Promise.resolve([]),
    enquiryItemIds.length
      ? db.supplierOffer.findMany({
          where: { enquiryItemId: { in: enquiryItemIds } },
          include: { supplier: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const approvedByItem = new Map(items.map((item) => [item.id, item.approvedOfferId]));
  const now = new Date();

  const lines = await Promise.all(
    order.lines.map(async (line) => {
      const poLines = await db.purchaseOrderLine.findMany({
        where: { salesOrderLineId: line.id },
        select: {
          quantity: true,
          acknowledgedQuantity: true,
          purchaseOrder: { select: { status: true } },
          receiptLines: { select: { quantityAccepted: true } },
        },
      });
      // Covered = accepted receipts from every historical PO + the still-open
      // part of live supplier commitments. REJECTED/CANCELLED POs release their
      // unreceived quantity; an approved partial acknowledgement commits only
      // the quantity the supplier actually confirmed.
      const alreadyOrdered = Number(
        sum(
          poLines.map((poLine) => {
            const coverage = coverageForPurchaseOrderLine(poLine);
            return coverage.accepted.plus(coverage.open);
          }),
        ).toFixed(4),
      );
      const procureQuantity = Number(line.procureQuantity);
      const candidateOffers = offers.filter((offer) => offer.enquiryItemId === line.enquiryItemId);
      const approvedOfferId = line.enquiryItemId ? approvedByItem.get(line.enquiryItemId) ?? line.supplierOfferId : line.supplierOfferId;
      const mapOffer = (offer: (typeof offers)[number]) => {
        const blocker = supplierOfferBlocker(offer as OfferForPurchase, now);
        return {
          id: offer.id,
          supplierId: offer.supplierId,
          supplierName: offer.supplier?.name ?? offer.supplierName,
          unitPrice: offer.unitPrice,
          currency: offer.currency,
          moq: offer.moq,
          leadTimeDays: offer.leadTimeDays,
          validityDate: offer.validityDate,
          eligible: blocker === null,
          blocker,
        };
      };
      const approved = candidateOffers.find((offer) => offer.id === approvedOfferId);
      return {
        salesOrderLineId: line.id,
        lineNo: line.lineNo,
        description: line.description,
        unit: line.unit,
        orderedQuantity: Number(line.quantity),
        stockQuantity: Number(line.stockQuantity),
        procureQuantity,
        alreadyOrdered,
        remainingToOrder: Math.max(0, Number((procureQuantity - alreadyOrdered).toFixed(4))),
        approvedOfferId: approvedOfferId ?? null,
        approvedOffer: approved ? mapOffer(approved) : null,
        candidates: candidateOffers
          .map(mapOffer)
          .sort((a, b) => Number(a.eligible ? 0 : 1) - Number(b.eligible ? 0 : 1) || (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity)),
      };
    }),
  );

  return {
    order: { id: order.id, orderNumber: order.orderNumber, currency: order.currency, status: order.status },
    lines,
  };
}

export type PurchaseSelection = {
  salesOrderLineId: string;
  supplierOfferId: string;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  reason?: string | null;
};

export type CreatePurchaseOrdersResult =
  | { ok: true; purchaseOrders: Array<{ id: string; poNumber: string; supplierName: string; duplicate: boolean }> }
  | { ok: false; error: string };

class ProcurementConflictError extends Error {}

/**
 * Creates one owner-approvable PO per supplier from verified supplier offers.
 * Nothing is sent here; each PO starts AWAITING_APPROVAL with an approval row.
 */
export async function createSupplierPurchaseOrders(input: {
  salesOrderId: string;
  selections: PurchaseSelection[];
  userId: string;
  actorLabel: string;
  internalNotes?: string | null;
  supplierNotes?: string | null;
  idempotencyKey?: string | null;
}): Promise<CreatePurchaseOrdersResult> {
  const order = await db.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    include: { lines: true },
  });
  if (!order) return { ok: false, error: "Sales order not found." };
  if (order.status === "CLOSED" || order.status === "CANCELLED") {
    return { ok: false, error: "This sales order is closed; no further purchase orders can be raised." };
  }
  if (input.selections.length === 0) return { ok: false, error: "Select at least one verified supplier offer." };

  const organizationId = order.organizationId;
  const org = await db.organization.findUnique({ where: { id: organizationId } });

  const plan = await procurementPlan(order.id);
  if (!plan) return { ok: false, error: "Sales order not found." };

  type Draft = {
    supplierId: string;
    supplierName: string;
    currency: string;
    paymentTerms: string | null;
    deliveryLocation: string | null;
    expectedDeliveryDate: Date | null;
    lines: Array<{
      salesOrderLineId: string;
      supplierOfferId: string;
      lineNo: number;
      description: string;
      specs: string | null;
      quantity: ReturnType<typeof qty>;
      unit: string;
      unitPrice: ReturnType<typeof money>;
      taxRatePct: ReturnType<typeof dec>;
      taxAmount: ReturnType<typeof money>;
      lineTotal: ReturnType<typeof money>;
      moq: ReturnType<typeof dec> | null;
      leadTimeDays: number | null;
    }>;
  };

  const groups = new Map<string, Draft>();

  for (const selection of input.selections) {
    const line = order.lines.find((candidate) => candidate.id === selection.salesOrderLineId);
    if (!line) return { ok: false, error: "A selected line does not belong to this sales order." };
    if (!line.enquiryItemId) return { ok: false, error: `"${line.description}" has no sourcing record and cannot use a supplier offer.` };

    const offer = await db.supplierOffer.findUnique({
      where: { id: selection.supplierOfferId },
      include: { supplier: { select: { id: true, name: true } } },
    });
    if (!offer || offer.enquiryItemId !== line.enquiryItemId) {
      return { ok: false, error: `The selected offer does not match "${line.description}".` };
    }
    const blocker = supplierOfferBlocker(offer as OfferForPurchase);
    if (blocker) {
      return { ok: false, error: `${offer.supplier?.name ?? offer.supplierName}: ${blocker}` };
    }

    const planLine = plan.lines.find((candidate) => candidate.salesOrderLineId === line.id);
    if (!planLine) return { ok: false, error: "The procurement plan for this line is unavailable." };
    const alreadyGrouped = [...groups.values()]
      .flatMap((draft) => draft.lines)
      .filter((draftLine) => draftLine.salesOrderLineId === line.id)
      .reduce((total, draftLine) => total.plus(draftLine.quantity), dec(0));
    const remaining = qty(planLine.remainingToOrder).minus(alreadyGrouped);
    const requested = selection.quantity != null && String(selection.quantity).trim() !== ""
      ? qty(Number(selection.quantity))
      : remaining;
    if (requested.lte(0)) return { ok: false, error: `"${line.description}" has no remaining quantity to procure.` };
    if (requested.gt(remaining)) {
      return { ok: false, error: `Only ${remaining.toFixed(4)} ${line.unit} of "${line.description}" still needs procurement.` };
    }
    const moq = offer.moq != null ? qty(offer.moq) : null;
    if (moq && moq.gt(0) && requested.lt(moq)) {
      return { ok: false, error: `${offer.supplier?.name ?? offer.supplierName} has a minimum order quantity of ${moq.toFixed(4)} ${line.unit} for "${line.description}".` };
    }

    const offerPrice = money(offer.unitPrice ?? 0);
    const requestedPrice = selection.unitPrice != null && String(selection.unitPrice).trim() !== ""
      ? money(Number(selection.unitPrice))
      : offerPrice;
    if (requestedPrice.lte(0)) return { ok: false, error: `"${line.description}" needs a positive purchase price.` };
    if (!requestedPrice.equals(offerPrice) && !selection.reason?.trim()) {
      return { ok: false, error: `The purchase price for "${line.description}" differs from the verified offer. Record a reason.` };
    }

    const supplierId = offer.supplierId as string;
    const currency = (offer.currency || order.currency).toUpperCase();
    const key = supplierId;
    if (!groups.has(key)) {
      groups.set(key, {
        supplierId,
        supplierName: offer.supplier?.name ?? offer.supplierName,
        currency,
        paymentTerms: offer.paymentTerms,
        deliveryLocation: offer.deliveryLocation,
        expectedDeliveryDate: offer.leadTimeDays != null ? new Date(Date.now() + offer.leadTimeDays * 24 * 60 * 60 * 1000) : null,
        lines: [],
      });
    }
    const group = groups.get(key) as Draft;
    if (group.currency !== currency) {
      return { ok: false, error: `One supplier PO cannot mix currencies (${group.currency} and ${currency}).` };
    }
    const taxRate = dec(org?.taxEnabled ? org.taxRatePct : 0);
    const totals = lineTotals({ quantity: requested, unitPrice: requestedPrice, taxRatePct: taxRate });
    group.lines.push({
      salesOrderLineId: line.id,
      supplierOfferId: offer.id,
      lineNo: group.lines.length + 1,
      description: line.description,
      specs: line.specs,
      quantity: requested,
      unit: line.unit,
      unitPrice: requestedPrice,
      taxRatePct: taxRate,
      taxAmount: totals.taxAmount,
      lineTotal: totals.net,
      moq,
      leadTimeDays: offer.leadTimeDays,
    });
  }

  const signature = sha256(
    JSON.stringify({
      orderId: order.id,
      selections: [...input.selections]
        .map((selection) => ({
          line: selection.salesOrderLineId,
          offer: selection.supplierOfferId,
          quantity: selection.quantity ?? null,
          price: selection.unitPrice ?? null,
        }))
        .sort((a, b) => `${a.line}:${a.offer}`.localeCompare(`${b.line}:${b.offer}`)),
    }),
  );
  const baseKey = input.idempotencyKey?.trim() || `po:${order.id}:${signature.slice(0, 24)}`;

  const results: Array<{ id: string; poNumber: string; supplierName: string; duplicate: boolean }> = [];
  for (const draft of groups.values()) {
    const idempotencyKey = `${baseKey}:${draft.supplierId}`;
    const existing = await db.purchaseOrder.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      select: { id: true, poNumber: true, supplier: { select: { name: true } } },
    });
    if (existing) {
      results.push({ id: existing.id, poNumber: existing.poNumber, supplierName: existing.supplier.name, duplicate: true });
      continue;
    }

    const subtotal = money(sum(draft.lines.map((line) => line.lineTotal)));
    const taxAmount = money(sum(draft.lines.map((line) => line.taxAmount)));
    const total = money(subtotal.plus(taxAmount));
    const poNumber = await nextNumber("PO");

    try {
      const created = await db.$transaction(async (tx) => {
        // Serialize against every other obligation change for this order. The
        // procurement plan was calculated before the transaction and may be
        // stale, so remaining quantities are recomputed from locked rows here.
        const lockedOrder = await lockSalesOrder(tx, order.id, { allowTerminal: true });
        if (lockedOrder.status === "CLOSED" || lockedOrder.status === "CANCELLED") {
          throw new ProcurementConflictError("This sales order is closed; no further purchase orders can be raised.");
        }

        const requestedByLine = new Map<string, ReturnType<typeof qty>>();
        for (const draftLine of draft.lines) {
          requestedByLine.set(
            draftLine.salesOrderLineId,
            (requestedByLine.get(draftLine.salesOrderLineId) ?? qty(0)).plus(draftLine.quantity),
          );
        }
        for (const [salesOrderLineId, requested] of requestedByLine) {
          const salesLine = await tx.salesOrderLine.findUnique({
            where: { id: salesOrderLineId },
            select: { description: true, unit: true, procureQuantity: true },
          });
          if (!salesLine) throw new ProcurementConflictError("A selected line no longer belongs to this sales order.");
          const existingLines = await tx.purchaseOrderLine.findMany({
            where: { salesOrderLineId },
            select: {
              quantity: true,
              acknowledgedQuantity: true,
              purchaseOrder: { select: { status: true } },
              receiptLines: { select: { quantityAccepted: true } },
            },
          });
          const covered = sum(
            existingLines.map((poLine) => {
              const coverage = coverageForPurchaseOrderLine(poLine);
              return coverage.accepted.plus(coverage.open);
            }),
          );
          const remaining = qty(salesLine.procureQuantity).minus(qty(covered));
          if (requested.gt(remaining)) {
            throw new ProcurementConflictError(
              `Only ${(remaining.gt(0) ? remaining : qty(0)).toFixed(4)} ${salesLine.unit} of "${salesLine.description}" still needs procurement. Another purchase order was created concurrently; reload the order.`,
            );
          }
        }

        const po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            idempotencyKey,
            status: "AWAITING_APPROVAL",
            salesOrderId: order.id,
            supplierId: draft.supplierId,
            currency: draft.currency,
            subtotal,
            taxAmount,
            total,
            paymentTerms: draft.paymentTerms,
            deliveryTerms: order.deliveryTerms,
            deliveryLocation: order.deliveryAddress ?? draft.deliveryLocation,
            expectedDeliveryDate: draft.expectedDeliveryDate,
            supplierNotes: input.supplierNotes?.trim() || null,
            internalNotes: input.internalNotes?.trim() || null,
            createdById: input.userId,
            lines: {
              create: draft.lines.map((line) => ({
                salesOrderLineId: line.salesOrderLineId,
                supplierOfferId: line.supplierOfferId,
                lineNo: line.lineNo,
                description: line.description,
                specs: line.specs,
                quantity: line.quantity,
                unit: line.unit,
                unitPrice: line.unitPrice,
                taxRatePct: line.taxRatePct,
                taxAmount: line.taxAmount,
                lineTotal: line.lineTotal,
                moq: line.moq,
                leadTimeDays: line.leadTimeDays,
              })),
            },
          },
        });

        await tx.approval.create({
          data: {
            type: "SUPPLIER_PO",
            entityType: "PurchaseOrder",
            entityId: po.id,
            enquiryId: order.enquiryId,
            status: "PENDING",
            requestedBy: "SYSTEM",
            payloadJson: stringifyJson({
              poNumber: po.poNumber,
              supplierName: draft.supplierName,
              salesOrder: order.orderNumber,
              total: toMoneyString(total),
              currency: draft.currency,
              lines: draft.lines.map((line) => ({
                description: line.description,
                quantity: Number(line.quantity),
                unit: line.unit,
                unitPrice: Number(line.unitPrice),
              })),
            }),
          },
        });

        await recordOrderEvent(tx, {
          entityType: "PurchaseOrder",
          entityId: po.id,
          fromStatus: null,
          toStatus: "AWAITING_APPROVAL",
          actorId: input.userId,
          actorLabel: input.actorLabel,
          reason: "Supplier purchase order drafted for owner approval",
          meta: { salesOrderId: order.id },
        });
        return po;
      });

      await writeAudit({
        actorId: input.userId,
        actorLabel: input.actorLabel,
        action: "purchase_order.created",
        entityType: "PurchaseOrder",
        entityId: created.id,
        meta: {
          poNumber: created.poNumber,
          salesOrderId: order.id,
          supplierId: draft.supplierId,
          total: toMoneyString(total),
          currency: draft.currency,
          selection: input.selections.filter((selection) =>
            draft.lines.some((line) => line.salesOrderLineId === selection.salesOrderLineId),
          ),
        },
      });
      await notifyOwner({
        type: "PURCHASE_ORDER_APPROVAL",
        title: "A supplier purchase order needs your approval",
        body: `${created.poNumber} — ${draft.supplierName}, ${draft.currency} ${toMoneyString(total)}. Nothing has been sent.`,
        link: `/orders/${order.id}`,
      });
      results.push({ id: created.id, poNumber: created.poNumber, supplierName: draft.supplierName, duplicate: false });
    } catch (error) {
      if (error instanceof ProcurementConflictError || error instanceof OrderLockError) {
        return { ok: false, error: error.message };
      }
      if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
        const raced = await db.purchaseOrder.findUnique({
          where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
          select: { id: true, poNumber: true, supplier: { select: { name: true } } },
        });
        if (raced) {
          results.push({ id: raced.id, poNumber: raced.poNumber, supplierName: raced.supplier.name, duplicate: true });
          continue;
        }
      }
      throw error;
    }
  }

  return { ok: true, purchaseOrders: results };
}

/** Owner approval of one supplier PO. Required before any transmission. */
export async function approveSupplierPurchaseOrder(input: {
  purchaseOrderId: string;
  userId: string;
  actorLabel: string;
  reason?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const po = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: { lines: true, supplier: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (po.status !== "AWAITING_APPROVAL") {
    return { ok: false, error: `This purchase order is ${PURCHASE_ORDER_STATUS_LABELS[po.status] ?? po.status} and cannot be approved again.` };
  }
  if (po.lines.length === 0 || po.lines.some((line) => Number(line.quantity) <= 0 || Number(line.unitPrice) <= 0)) {
    return { ok: false, error: "The purchase order has a line without a positive quantity or price." };
  }
  if (!po.supplier.email) {
    return { ok: false, error: "The supplier has no email address; the purchase order cannot be transmitted." };
  }

  const applied = await db.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: "AWAITING_APPROVAL" },
      data: { status: "APPROVED", approvedById: input.userId, approvedAt: new Date() },
    });
    if (claimed.count === 0) return false;
    await tx.approval.updateMany({
      where: { type: "SUPPLIER_PO", entityId: po.id, status: "PENDING" },
      data: { status: "APPROVED", decidedById: input.userId, decidedAt: new Date(), reason: input.reason?.trim() || null },
    });
    await recordOrderEvent(tx, {
      entityType: "PurchaseOrder",
      entityId: po.id,
      fromStatus: "AWAITING_APPROVAL",
      toStatus: "APPROVED",
      actorId: input.userId,
      actorLabel: input.actorLabel,
      reason: input.reason?.trim() || null,
    });
    return true;
  });
  if (!applied) return { ok: false, error: "This purchase order was already decided." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "purchase_order.approved",
    entityType: "PurchaseOrder",
    entityId: po.id,
    meta: { poNumber: po.poNumber, reason: input.reason ?? null },
  });
  return { ok: true };
}

export function purchaseOrderBody(input: {
  organizationName: string;
  poNumber: string;
  supplierName: string;
  salesOrderNumber: string;
  currency: string;
  deliveryLocation: string | null;
  expectedDeliveryDate: Date | null;
  paymentTerms: string | null;
  lines: Array<{ description: string; specs: string | null; quantity: number; unit: string; unitPrice: number; lineTotal: number }>;
  subtotal: number;
  taxAmount: number;
  total: number;
  supplierNotes: string | null;
  reference?: string | null;
}): string {
  const rows = input.lines.map(
    (line, index) =>
      `${index + 1}. ${line.description}${line.specs ? ` (${line.specs})` : ""}\n   ${line.quantity} ${line.unit} × ${input.currency} ${line.unitPrice.toFixed(2)} = ${input.currency} ${line.lineTotal.toFixed(2)}`,
  );
  return [
    `Dear ${input.supplierName},`,
    "",
    `Please supply the following against purchase order ${input.poNumber}.`,
    `Reference: ${input.salesOrderNumber}`,
    input.reference ? `Purchase order reference: ${input.reference}` : "",
    "",
    ...rows,
    "",
    `Subtotal: ${input.currency} ${input.subtotal.toFixed(2)}`,
    `Tax: ${input.currency} ${input.taxAmount.toFixed(2)}`,
    `Total: ${input.currency} ${input.total.toFixed(2)}`,
    input.deliveryLocation ? `Deliver to: ${input.deliveryLocation}` : "",
    input.expectedDeliveryDate ? `Required delivery date: ${input.expectedDeliveryDate.toISOString().slice(0, 10)}` : "",
    input.paymentTerms ? `Payment terms: ${input.paymentTerms}` : "",
    input.supplierNotes ? `Notes: ${input.supplierNotes}` : "",
    "",
    `Thank you,`,
    input.organizationName,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Transmits an approved PO exactly once and stores the sent document. */
export async function sendSupplierPurchaseOrder(input: {
  purchaseOrderId: string;
  userId: string;
  actorLabel: string;
  to?: string | null;
}): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const po = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: { lines: true, supplier: true, salesOrder: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (po.status !== "APPROVED") {
    return { ok: false, error: "The purchase order must be owner-approved before it is sent." };
  }
  if (!po.lines.length) return { ok: false, error: "The purchase order has no lines." };
  const guard = await supplierSendGuard(po.supplierId);
  if (!guard.ok) return { ok: false, error: guard.error ?? "The supplier cannot be contacted." };

  const recipient = (input.to?.trim() || po.supplier.email || "").trim();
  if (!recipient) return { ok: false, error: "The supplier has no email address." };

  // A stable opaque reference travels in the subject so the supplier's reply
  // can be attached to this exact purchase order. It is not authorisation to
  // change the PO: a changed term still needs the owner's review.
  const correlationToken = po.correlationToken ?? correlationTokenFor("PO", po.id);
  if (!po.correlationToken) {
    await db.purchaseOrder.update({ where: { id: po.id }, data: { correlationToken } });
  }
  const reference = correlationReference("PO", correlationToken);

  const org = await db.organization.findUnique({ where: { id: po.organizationId } });
  const body = purchaseOrderBody({
    organizationName: org?.name ?? "Procurement",
    poNumber: po.poNumber,
    supplierName: po.supplier.name,
    salesOrderNumber: po.salesOrder.orderNumber,
    currency: po.currency,
    deliveryLocation: po.deliveryLocation,
    expectedDeliveryDate: po.expectedDeliveryDate,
    paymentTerms: po.paymentTerms,
    lines: po.lines.map((line) => ({
      description: line.description,
      specs: line.specs,
      quantity: Number(line.quantity),
      unit: line.unit,
      unitPrice: Number(line.unitPrice),
      lineTotal: Number(line.lineTotal),
    })),
    subtotal: Number(po.subtotal),
    taxAmount: Number(po.taxAmount),
    total: Number(po.total),
    supplierNotes: po.supplierNotes,
    reference,
  });
  const subject = `Purchase order ${po.poNumber} [${reference}] — ${org?.name ?? ""}`.trim();
  const document = {
    kind: "PURCHASE_ORDER",
    poNumber: po.poNumber,
    version: po.version,
    supplier: { id: po.supplierId, name: po.supplier.name, email: recipient },
    salesOrder: po.salesOrder.orderNumber,
    currency: po.currency,
    subtotal: po.subtotal.toFixed(4),
    taxAmount: po.taxAmount.toFixed(4),
    total: po.total.toFixed(4),
    deliveryLocation: po.deliveryLocation,
    expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
    paymentTerms: po.paymentTerms,
    lines: po.lines.map((line) => ({
      salesOrderLineId: line.salesOrderLineId,
      supplierOfferId: line.supplierOfferId,
      description: line.description,
      quantity: line.quantity.toFixed(4),
      unit: line.unit,
      unitPrice: line.unitPrice.toFixed(4),
      taxRatePct: line.taxRatePct.toFixed(4),
      lineTotal: line.lineTotal.toFixed(4),
    })),
    generatedAt: new Date().toISOString(),
    body,
  };

  let simulated = false;
  const result = await sendOutboundOnce(
    {
      operationKey: outboundOperationKey(["supplier-po", po.id, `v${po.version}`, "EMAIL"]),
      kind: "SUPPLIER_RFQ",
      channel: "EMAIL",
      recipient,
      subject,
      body,
      relatedType: "PurchaseOrder",
      relatedId: po.id,
      metadata: { poNumber: po.poNumber, version: po.version, userId: input.userId },
    },
    async () => {
      const sent = await sendEmail({ to: recipient, subject, text: body });
      if (sent.ok) {
        simulated = Boolean(sent.simulated);
        return {
          outcome: "SENT",
          simulated: sent.simulated,
          providerMessageId: sent.providerIds?.messageId ?? null,
          providerThreadId: sent.providerIds?.threadId ?? null,
          detail: sent.simulated ? `Demo simulation: no email was transmitted to ${recipient}.` : `Emailed to ${recipient}.`,
        };
      }
      return sent.uncertain ? { outcome: "UNKNOWN", error: sent.error } : { outcome: "FAILED_SAFE", error: sent.error };
    },
  );

  if (result.status === "UNCERTAIN" || result.status === "IN_PROGRESS" || result.status === "FAILED_SAFE" || result.status === "EXHAUSTED") {
    await db.purchaseOrder.update({ where: { id: po.id }, data: { lastError: result.detail.slice(0, 600) } });
    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "purchase_order.send_failed",
      entityType: "PurchaseOrder",
      entityId: po.id,
      meta: { status: result.status, error: result.detail },
    });
    return { ok: false, error: result.detail || "The purchase order could not be sent." };
  }

  await db.$transaction(async (tx) => {
    await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: "APPROVED" },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentChannel: simulated ? "DEMO" : "EMAIL",
        sentTo: recipient,
        sentSubject: subject,
        sentDocumentJson: stringifyJson(document),
        correlationToken,
        providerMessageId: result.providerMessageId ?? null,
        providerThreadId: result.providerThreadId ?? null,
        lastError: simulated ? "Demo simulation — no email was transmitted." : null,
      },
    });
    await recordOrderEvent(tx, {
      entityType: "PurchaseOrder",
      entityId: po.id,
      fromStatus: "APPROVED",
      toStatus: "SENT",
      actorId: input.userId,
      actorLabel: input.actorLabel,
      reason: simulated ? "Demo simulation; no message transmitted" : "Approved purchase order emailed to the supplier",
      meta: { recipient, version: po.version },
    });

    // Preserve the exact issued document as version 1. Later approved revisions
    // add immutable versions; the sent snapshot is never rewritten.
    const existingVersion = await tx.purchaseOrderVersion.findUnique({
      where: { purchaseOrderId_version: { purchaseOrderId: po.id, version: po.version } },
      select: { id: true },
    });
    if (!existingVersion) {
      const issuedAt = new Date();
      const lines: SnapshotLine[] = po.lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        description: line.description,
        specs: line.specs,
        quantity: line.quantity.toFixed(4),
        unit: line.unit,
        unitPrice: line.unitPrice.toFixed(4),
        taxRatePct: line.taxRatePct.toFixed(4),
        taxAmount: line.taxAmount.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
        acknowledgedQuantity: line.acknowledgedQuantity?.toFixed(4) ?? null,
        leadTimeDays: line.leadTimeDays,
      }));
      await tx.purchaseOrderVersion.create({
        data: {
          purchaseOrderId: po.id,
          version: po.version,
          status: "SENT",
          reason: simulated ? "Demo simulation; no message transmitted" : "Issued to supplier",
          source: "SENT",
          approvedById: input.userId,
          snapshotJson: buildVersionSnapshot(
            { ...po, status: "SENT", sentAt: issuedAt, sentTo: recipient, sentChannel: simulated ? "DEMO" : "EMAIL" },
            lines,
            { reason: "Issued to supplier", source: "SENT", acknowledgementId: null, approvedById: input.userId },
          ),
          changeSummaryJson: "[]",
        },
      });
    }
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: simulated ? "purchase_order.simulated_sent" : "purchase_order.sent",
    entityType: "PurchaseOrder",
    entityId: po.id,
    meta: { recipient, version: po.version, messageId: result.messageId ?? null },
  });
  return {
    ok: true,
    detail:
      result.status === "ALREADY_SENT"
        ? "This purchase order was already sent; no duplicate message was transmitted."
        : result.detail || `Sent to ${recipient}.`,
  };
}

export type AcknowledgementInput = {
  purchaseOrderId: string;
  outcome: "ACKNOWLEDGED" | "PARTIALLY_ACKNOWLEDGED" | "REJECTED" | "REVISED";
  lines?: Array<{
    purchaseOrderLineId: string;
    acknowledgedQuantity?: number | string | null;
    revisedUnitPrice?: number | string | null;
    promisedDate?: Date | string | null;
  }>;
  promisedDate?: Date | string | null;
  notes?: string | null;
  evidence?: Record<string, unknown>;
  source?: "EMAIL" | "MANUAL";
  /** Set when the acknowledgement was read from an inbound supplier email. */
  supplierReplyId?: string | null;
  userId: string | null;
  actorLabel: string;
};

/** Records what the supplier said. No commercial term changes until review. */
export async function recordSupplierAcknowledgement(
  input: AcknowledgementInput,
): Promise<{ ok: true; acknowledgementId: string; deviations: Array<{ code: string; detail: string }> } | { ok: false; error: string }> {
  const po = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: { lines: true, supplier: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (!["SENT", "ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REVISED", "ACKNOWLEDGEMENT_RECEIVED"].includes(po.status)) {
    return { ok: false, error: "A supplier acknowledgement can only be recorded after the purchase order was sent." };
  }
  if (input.supplierReplyId) {
    const existing = await db.supplierAcknowledgement.findFirst({
      where: { supplierReplyId: input.supplierReplyId },
      select: { id: true, deviationsJson: true },
    });
    if (existing) {
      return {
        ok: true,
        acknowledgementId: existing.id,
        deviations: parseJson<Array<{ code: string; detail: string }>>(existing.deviationsJson, []),
      };
    }
  }

  const deviations: Array<{ code: string; detail: string }> = [];
  const lines: Array<Record<string, unknown>> = [];
  for (const line of input.lines ?? []) {
    const poLine = po.lines.find((candidate) => candidate.id === line.purchaseOrderLineId);
    if (!poLine) return { ok: false, error: "An acknowledged line does not belong to this purchase order." };
    const acknowledged = line.acknowledgedQuantity != null && String(line.acknowledgedQuantity).trim() !== ""
      ? qty(Number(line.acknowledgedQuantity))
      : qty(poLine.quantity);
    if (acknowledged.lt(0) || acknowledged.gt(qty(poLine.quantity))) {
      return { ok: false, error: `Acknowledged quantity for "${poLine.description}" must be between zero and the ordered quantity.` };
    }
    if (acknowledged.lt(qty(poLine.quantity))) {
      deviations.push({
        code: "PARTIAL_QUANTITY",
        detail: `${poLine.description}: supplier acknowledged ${acknowledged.toFixed(4)} of ${qty(poLine.quantity).toFixed(4)} ${poLine.unit}.`,
      });
    }
    const revised = line.revisedUnitPrice != null && String(line.revisedUnitPrice).trim() !== ""
      ? money(Number(line.revisedUnitPrice))
      : null;
    if (revised && !revised.equals(poLine.unitPrice)) {
      deviations.push({
        code: "REVISED_PRICE",
        detail: `${poLine.description}: supplier proposes ${po.currency} ${revised.toFixed(2)} instead of ${money(poLine.unitPrice).toFixed(2)}.`,
      });
    }
    lines.push({
      purchaseOrderLineId: poLine.id,
      description: poLine.description,
      orderedQuantity: Number(qty(poLine.quantity)),
      acknowledgedQuantity: Number(acknowledged),
      revisedUnitPrice: revised ? Number(revised) : null,
      promisedDate: line.promisedDate ? new Date(line.promisedDate).toISOString() : null,
    });
  }

  if (input.outcome === "REJECTED") deviations.push({ code: "SUPPLIER_REJECTED", detail: "The supplier rejected the purchase order." });
  if (input.outcome === "PARTIALLY_ACKNOWLEDGED" && !deviations.some((item) => item.code === "PARTIAL_QUANTITY")) {
    deviations.push({ code: "PARTIAL_QUANTITY", detail: "The supplier confirmed only part of the order." });
  }
  if (input.outcome === "REVISED" && !deviations.some((item) => item.code === "REVISED_PRICE")) {
    deviations.push({ code: "REVISED_TERMS", detail: "The supplier proposed revised commercial terms." });
  }

  const promisedDate = input.promisedDate ? new Date(input.promisedDate) : null;
  if (promisedDate && po.expectedDeliveryDate && promisedDate.getTime() > po.expectedDeliveryDate.getTime()) {
    deviations.push({
      code: "LATE_DELIVERY",
      detail: `Supplier promises ${promisedDate.toISOString().slice(0, 10)}, after the required ${po.expectedDeliveryDate.toISOString().slice(0, 10)}.`,
    });
  }

  const acknowledgement = await db.$transaction(async (tx) => {
    const created = await tx.supplierAcknowledgement.create({
      data: {
        purchaseOrderId: po.id,
        outcome: input.outcome,
        reviewStatus: "PENDING",
        promisedDate: promisedDate && !Number.isNaN(promisedDate.getTime()) ? promisedDate : null,
        linesJson: stringifyJson(lines),
        deviationsJson: stringifyJson(deviations),
        notes: input.notes?.trim() || null,
        evidenceJson: stringifyJson(input.evidence ?? {}),
        source: input.source ?? "MANUAL",
        supplierReplyId: input.supplierReplyId ?? null,
        recordedById: input.userId ?? null,
      },
    });
    await transitionPurchaseOrder(tx, {
      purchaseOrderId: po.id,
      toStatus: "ACKNOWLEDGEMENT_RECEIVED",
      actorId: input.userId,
      actorLabel: input.actorLabel,
      reason: `Supplier replied: ${input.outcome}`,
      meta: { acknowledgementId: created.id, deviations: deviations.length },
    });
    return created;
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "purchase_order.acknowledgement_recorded",
    entityType: "PurchaseOrder",
    entityId: po.id,
    meta: { acknowledgementId: acknowledgement.id, outcome: input.outcome, deviations },
  });
  if (input.outcome !== "ACKNOWLEDGED" || deviations.length > 0) {
    await notifyOwner({
      type: "SUPPLIER_ACKNOWLEDGEMENT",
      title: "A supplier replied with changed terms",
      body: `${po.poNumber} — ${po.supplier.name}: ${input.outcome.replaceAll("_", " ").toLowerCase()} (${deviations.length} difference(s)). Review before it affects the order.`,
      link: `/orders/${po.salesOrderId}`,
    });
  }
  return { ok: true, acknowledgementId: acknowledgement.id, deviations };
}

type SnapshotLine = {
  id: string;
  lineNo: number;
  description: string;
  specs: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRatePct: string;
  taxAmount: string;
  lineTotal: string;
  acknowledgedQuantity: string | null;
  leadTimeDays: number | null;
};

type SnapshotOrder = {
  id: string;
  poNumber: string;
  version: number;
  status: string;
  currency: string;
  subtotal: { toFixed: (digits: number) => string };
  taxAmount: { toFixed: (digits: number) => string };
  total: { toFixed: (digits: number) => string };
  paymentTerms: string | null;
  deliveryTerms: string | null;
  deliveryLocation: string | null;
  expectedDeliveryDate: Date | null;
  supplierNotes: string | null;
  internalNotes: string | null;
  sentAt: Date | null;
  sentTo: string | null;
  sentChannel: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  supplier: { id: string; name: string; email?: string | null };
  salesOrder: { id: string; orderNumber: string };
};

function snapshotLine(line: SnapshotLine): SnapshotLine {
  return { ...line };
}

/** Complete immutable record of one purchase-order version. */
function buildVersionSnapshot(
  po: SnapshotOrder,
  lines: SnapshotLine[],
  meta: { reason: string | null; source: string; acknowledgementId: string | null; approvedById: string | null },
) {
  return stringifyJson({
    purchaseOrderId: po.id,
    poNumber: po.poNumber,
    version: po.version,
    status: po.status,
    supplier: { id: po.supplier.id, name: po.supplier.name, email: po.supplier.email ?? null },
    salesOrder: { id: po.salesOrder.id, orderNumber: po.salesOrder.orderNumber },
    currency: po.currency,
    subtotal: po.subtotal.toFixed(4),
    taxAmount: po.taxAmount.toFixed(4),
    total: po.total.toFixed(4),
    paymentTerms: po.paymentTerms,
    deliveryTerms: po.deliveryTerms,
    deliveryLocation: po.deliveryLocation,
    expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
    supplierNotes: po.supplierNotes,
    internalNotes: po.internalNotes,
    reason: meta.reason,
    source: meta.source,
    acknowledgementId: meta.acknowledgementId,
    approvedById: meta.approvedById,
    sentAt: po.sentAt?.toISOString() ?? null,
    sentTo: po.sentTo,
    sentChannel: po.sentChannel,
    providerMessageId: po.providerMessageId,
    providerThreadId: po.providerThreadId,
    capturedAt: new Date().toISOString(),
    lines: lines.map(snapshotLine),
  });
}

function diffLines(before: SnapshotLine[], after: SnapshotLine[]) {
  return after
    .map((line) => {
      const previous = before.find((candidate) => candidate.id === line.id);
      const changes: Record<string, { before: string | null; after: string | null }> = {};
      if (!previous) {
        changes.added = { before: null, after: `${line.quantity} ${line.unit} @ ${line.unitPrice}` };
      } else {
        if (previous.quantity !== line.quantity) changes.quantity = { before: previous.quantity, after: line.quantity };
        if (previous.unitPrice !== line.unitPrice) changes.unitPrice = { before: previous.unitPrice, after: line.unitPrice };
        if (previous.acknowledgedQuantity !== line.acknowledgedQuantity) {
          changes.acknowledgedQuantity = { before: previous.acknowledgedQuantity, after: line.acknowledgedQuantity };
        }
        if (previous.taxAmount !== line.taxAmount) changes.taxAmount = { before: previous.taxAmount, after: line.taxAmount };
        if (previous.lineTotal !== line.lineTotal) changes.lineTotal = { before: previous.lineTotal, after: line.lineTotal };
      }
      return { lineId: line.id, description: line.description, changes };
    })
    .filter((entry) => Object.keys(entry.changes).length > 0);
}

async function seedCurrentVersionIfMissing(
  tx: import("@prisma/client").Prisma.TransactionClient,
  po: SnapshotOrder,
  lines: SnapshotLine[],
  reason: string,
) {
  const existing = await tx.purchaseOrderVersion.findUnique({
    where: { purchaseOrderId_version: { purchaseOrderId: po.id, version: po.version } },
    select: { id: true },
  });
  if (existing) return;
  await tx.purchaseOrderVersion.create({
    data: {
      purchaseOrderId: po.id,
      version: po.version,
      status: po.status,
      reason,
      source: "BASELINE",
      approvedById: null,
      snapshotJson: buildVersionSnapshot(po, lines, {
        reason,
        source: "BASELINE",
        acknowledgementId: null,
        approvedById: null,
      }),
      changeSummaryJson: "[]",
    },
  });
}

/**
 * Owner review of a supplier acknowledgement.
 *
 * An approval applies only facts the owner explicitly accepted. Revised prices
 * are applied per line, but the PO subtotal, tax and total are always rebuilt
 * from ALL lines, so unchanged lines can never disappear from a revision. The
 * pre-revision document is retained as an immutable `PurchaseOrderVersion`.
 */
export async function reviewSupplierAcknowledgement(input: {
  acknowledgementId: string;
  decision: "APPROVE" | "DISMISS";
  note?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true; purchaseOrderStatus: string; version?: number } | { ok: false; error: string }> {
  const located = await db.supplierAcknowledgement.findUnique({
    where: { id: input.acknowledgementId },
    select: { purchaseOrderId: true },
  });
  if (!located) return { ok: false, error: "Supplier acknowledgement not found." };
  const orderRow = await db.purchaseOrder.findUnique({
    where: { id: located.purchaseOrderId },
    select: { salesOrderId: true },
  });
  if (!orderRow) return { ok: false, error: "Supplier acknowledgement not found." };

  try {
    const result = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderRow.salesOrderId);
      const lock = await lockPurchaseOrder(tx, located.purchaseOrderId);
      if (!lock) return { ok: false as const, error: "Supplier acknowledgement not found." };

      const acknowledgement = await tx.supplierAcknowledgement.findUnique({
        where: { id: input.acknowledgementId },
        include: {
          purchaseOrder: {
            include: {
              lines: { orderBy: { lineNo: "asc" } },
              supplier: true,
              salesOrder: { select: { id: true, orderNumber: true } },
            },
          },
        },
      });
      if (!acknowledgement) return { ok: false as const, error: "Supplier acknowledgement not found." };
      if (acknowledgement.reviewStatus !== "PENDING") {
        return { ok: false as const, error: "This supplier reply was already reviewed." };
      }
      const po = acknowledgement.purchaseOrder;

      if (input.decision === "DISMISS") {
        const claimed = await tx.supplierAcknowledgement.updateMany({
          where: { id: acknowledgement.id, reviewStatus: "PENDING" },
          data: { reviewStatus: "DISMISSED", reviewedById: input.userId, reviewedAt: new Date(), reviewNote: input.note?.trim() || null },
        });
        if (claimed.count === 0) return { ok: false as const, error: "This supplier reply was already reviewed." };
        if (po.status === "ACKNOWLEDGEMENT_RECEIVED") {
          await transitionPurchaseOrder(tx, {
            purchaseOrderId: po.id,
            toStatus: "SENT",
            actorId: input.userId,
            actorLabel: input.actorLabel,
            reason: "Supplier reply dismissed by owner",
            meta: { acknowledgementId: acknowledgement.id },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: input.userId,
            actorLabel: input.actorLabel,
            action: "purchase_order.acknowledgement_dismissed",
            entityType: "PurchaseOrder",
            entityId: po.id,
            metaJson: stringifyJson({ acknowledgementId: acknowledgement.id, note: input.note ?? null }),
          },
        });
        return { ok: true as const, purchaseOrderStatus: po.status, version: po.version };
      }

      if (!input.note?.trim()) {
        return { ok: false as const, error: "Record why the supplier's terms are accepted; the reason is part of the purchase record." };
      }

      const acknowledged = parseJson<
        Array<{ purchaseOrderLineId: string; acknowledgedQuantity?: number | null; revisedUnitPrice?: number | null; promisedDate?: string | null }>
      >(acknowledgement.linesJson, []);
      const byLine = new Map<string, { acknowledgedQuantity: number | null; revisedUnitPrice: number | null; promisedDate: string | null }>();
      for (const line of acknowledged) {
        if (!po.lines.some((poLine) => poLine.id === line.purchaseOrderLineId)) {
          return { ok: false as const, error: "An acknowledged line does not belong to this purchase order." };
        }
        byLine.set(line.purchaseOrderLineId, {
          acknowledgedQuantity: line.acknowledgedQuantity == null ? null : Number(line.acknowledgedQuantity),
          revisedUnitPrice: line.revisedUnitPrice == null ? null : Number(line.revisedUnitPrice),
          promisedDate: line.promisedDate ?? null,
        });
      }

      const isRejected = acknowledgement.outcome === "REJECTED";
      const isPartial = acknowledgement.outcome === "PARTIALLY_ACKNOWLEDGED";
      const beforeLines: SnapshotLine[] = po.lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        description: line.description,
        specs: line.specs,
        quantity: line.quantity.toFixed(4),
        unit: line.unit,
        unitPrice: line.unitPrice.toFixed(4),
        taxRatePct: line.taxRatePct.toFixed(4),
        taxAmount: line.taxAmount.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
        acknowledgedQuantity: line.acknowledgedQuantity?.toFixed(4) ?? null,
        leadTimeDays: line.leadTimeDays,
      }));

      // A price revision may arrive with a partial acknowledgement. Apply the
      // price only where the supplier quoted one, and preserve every other line.
      const revisions = new Map<string, ReturnType<typeof money>>();
      for (const [lineId, fact] of byLine) {
        if (fact.revisedUnitPrice == null) continue;
        if (!Number.isFinite(fact.revisedUnitPrice) || fact.revisedUnitPrice <= 0) {
          return { ok: false as const, error: "A revised unit price must be a positive number." };
        }
        revisions.set(lineId, money(fact.revisedUnitPrice));
      }
      const hasPriceRevision = revisions.size > 0;

      const ackQuantities = new Map<string, ReturnType<typeof qty>>();
      for (const poLine of po.lines) {
        const fact = byLine.get(poLine.id);
        let confirmed: ReturnType<typeof qty>;
        if (isRejected) {
          confirmed = qty(0);
        } else if (fact && fact.acknowledgedQuantity != null) {
          confirmed = qty(fact.acknowledgedQuantity);
        } else if (isPartial) {
          // The supplier replied but did not confirm this line.
          confirmed = qty(0);
        } else {
          confirmed = qty(poLine.quantity);
        }
        if (confirmed.lt(0) || confirmed.gt(qty(poLine.quantity))) {
          return {
            ok: false as const,
            error: `Acknowledged quantity for "${poLine.description}" must be between zero and the ordered quantity.`,
          };
        }
        ackQuantities.set(poLine.id, confirmed);
      }

      const targetStatus = isRejected
        ? "REJECTED"
        : isPartial
          ? "PARTIALLY_ACKNOWLEDGED"
          : acknowledgement.outcome === "REVISED" || hasPriceRevision
            ? "REVISED"
            : "ACKNOWLEDGED";
      const nextVersion = po.version + 1;
      const structuralChange = isRejected || hasPriceRevision || isPartial || acknowledgement.outcome === "REVISED";

      if (!isRejected) {
        for (const poLine of po.lines) {
          const unitPrice = revisions.get(poLine.id) ?? money(poLine.unitPrice);
          const totals = lineTotals({ quantity: poLine.quantity, unitPrice, taxRatePct: poLine.taxRatePct });
          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: {
              unitPrice,
              taxAmount: totals.taxAmount,
              lineTotal: totals.net,
              acknowledgedQuantity: ackQuantities.get(poLine.id) ?? qty(0),
            },
          });
        }
      } else {
        await tx.purchaseOrderLine.updateMany({
          where: { purchaseOrderId: po.id },
          data: { acknowledgedQuantity: 0 },
        });
      }

      // Rebuild the complete PO total from every line, never only changed ones.
      const finalLines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id },
        orderBy: { lineNo: "asc" },
      });
      const subtotal = money(sum(finalLines.map((line) => line.lineTotal)));
      const taxAmount = money(sum(finalLines.map((line) => line.taxAmount)));
      const total = money(subtotal.plus(taxAmount));

      const afterLines: SnapshotLine[] = finalLines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        description: line.description,
        specs: line.specs,
        quantity: line.quantity.toFixed(4),
        unit: line.unit,
        unitPrice: line.unitPrice.toFixed(4),
        taxRatePct: line.taxRatePct.toFixed(4),
        taxAmount: line.taxAmount.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
        acknowledgedQuantity: line.acknowledgedQuantity?.toFixed(4) ?? null,
        leadTimeDays: line.leadTimeDays,
      }));

      if (structuralChange) {
        await seedCurrentVersionIfMissing(tx, po, beforeLines, "Snapshot before the approved supplier revision");
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id: po.id, status: lock.status },
        data: {
          status: targetStatus,
          subtotal,
          taxAmount,
          total,
          ...(hasPriceRevision || acknowledgement.outcome === "REVISED" ? { version: nextVersion } : {}),
        },
      });
      if (claimed.count === 0) {
        return { ok: false as const, error: "The purchase order changed while the reply was being approved; reload and review again." };
      }

      const versionCreated = hasPriceRevision || acknowledgement.outcome === "REVISED";
      if (versionCreated) {
        await tx.purchaseOrderVersion.create({
          data: {
            purchaseOrderId: po.id,
            version: nextVersion,
            status: targetStatus,
            reason: input.note.trim(),
            source: "SUPPLIER_ACKNOWLEDGEMENT",
            acknowledgementId: acknowledgement.id,
            approvedById: input.userId,
            snapshotJson: buildVersionSnapshot(
              { ...po, version: nextVersion, status: targetStatus, subtotal, taxAmount, total },
              afterLines,
              {
                reason: input.note.trim(),
                source: "SUPPLIER_ACKNOWLEDGEMENT",
                acknowledgementId: acknowledgement.id,
                approvedById: input.userId,
              },
            ),
            changeSummaryJson: stringifyJson(diffLines(beforeLines, afterLines)),
          },
        });
      }

      await tx.supplierAcknowledgement.updateMany({
        where: { id: acknowledgement.id, reviewStatus: "PENDING" },
        data: { reviewStatus: "APPROVED", reviewedById: input.userId, reviewedAt: new Date(), reviewNote: input.note.trim() },
      });

      await recordOrderEvent(tx, {
        entityType: "PurchaseOrder",
        entityId: po.id,
        fromStatus: lock.status,
        toStatus: targetStatus,
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: input.note.trim(),
        meta: {
          acknowledgementId: acknowledgement.id,
          outcome: acknowledgement.outcome,
          version: versionCreated ? nextVersion : po.version,
          totalBefore: po.total.toFixed(4),
          totalAfter: total.toFixed(4),
          linesBefore: beforeLines,
          linesAfter: afterLines,
          changeSummary: diffLines(beforeLines, afterLines),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.userId,
          actorLabel: input.actorLabel,
          action: "purchase_order.acknowledgement_approved",
          entityType: "PurchaseOrder",
          entityId: po.id,
          metaJson: stringifyJson({
            acknowledgementId: acknowledgement.id,
            outcome: acknowledgement.outcome,
            note: input.note.trim(),
            targetStatus,
            version: versionCreated ? nextVersion : po.version,
            totalBefore: po.total.toFixed(4),
            totalAfter: total.toFixed(4),
          }),
        },
      });

      return {
        ok: true as const,
        purchaseOrderStatus: targetStatus,
        version: versionCreated ? nextVersion : po.version,
      };
    });
    return result;
  } catch (error) {
    if (error instanceof OrderLockError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Refreshes the sales-order status after procurement changes. */
export async function refreshOrderFromProcurement(salesOrderId: string, actor: { id?: string | null; label?: string }) {
  return db.$transaction((tx) => refreshSalesOrderStatus(tx, salesOrderId, actor));
}

/** Order-level view used by the order screen. */
export async function purchaseOrdersForOrder(salesOrderId: string) {
  return db.purchaseOrder.findMany({
    where: { salesOrderId },
    orderBy: { createdAt: "asc" },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      lines: { orderBy: { lineNo: "asc" } },
      acknowledgements: { orderBy: { createdAt: "desc" } },
      receipts: { orderBy: { receivedAt: "desc" }, include: { lines: true } },
      supplierBills: true,
      versions: {
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          status: true,
          reason: true,
          source: true,
          approvedById: true,
          changeSummaryJson: true,
          createdAt: true,
        },
      },
    },
  });
}

/** Metrics used to show received quantities after a receipt is posted. */
export async function orderReceivedMetrics(salesOrderId: string) {
  return db.$transaction((tx) => orderMetrics(tx, salesOrderId));
}
