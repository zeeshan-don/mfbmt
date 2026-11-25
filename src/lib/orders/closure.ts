import { db } from "../db";
import { writeAudit } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { dec, money, sum, toMoneyString } from "./money";
import { orderMetrics } from "./metrics";
import { recordOrderEvent } from "./events";

/**
 * Verified deal closure.
 *
 * Closure is computed from the records, never from a status alone. Mandatory
 * obligations (undelivered quantity, open supplier commitments, unbilled value,
 * unpaid customer balance, open discrepancies) block closure. An owner may
 * override with an explicit reason; the override keeps the before/after state.
 */

export type ClosurePolicy = {
  requireFullDelivery: boolean;
  requireFullInvoicing: boolean;
  requireCustomerPaid: boolean;
  requireSupplierSettled: boolean;
  allowOpenDiscrepancies: boolean;
};

export const DEFAULT_CLOSURE_POLICY: ClosurePolicy = {
  requireFullDelivery: true,
  requireFullInvoicing: true,
  requireCustomerPaid: true,
  requireSupplierSettled: false,
  allowOpenDiscrepancies: false,
};

export async function closurePolicy(): Promise<ClosurePolicy> {
  const setting = await db.appSetting.findFirst({ where: { key: "orders.closurePolicy" } });
  const saved = parseJson<Partial<ClosurePolicy>>(setting?.value, {});
  return {
    requireFullDelivery: saved.requireFullDelivery ?? DEFAULT_CLOSURE_POLICY.requireFullDelivery,
    requireFullInvoicing: saved.requireFullInvoicing ?? DEFAULT_CLOSURE_POLICY.requireFullInvoicing,
    requireCustomerPaid: saved.requireCustomerPaid ?? DEFAULT_CLOSURE_POLICY.requireCustomerPaid,
    requireSupplierSettled: saved.requireSupplierSettled ?? DEFAULT_CLOSURE_POLICY.requireSupplierSettled,
    allowOpenDiscrepancies: saved.allowOpenDiscrepancies ?? DEFAULT_CLOSURE_POLICY.allowOpenDiscrepancies,
  };
}

export type ClosureSummary = {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    currency: string;
    total: string;
    customerName: string;
    closedAt: Date | null;
    closureOverrideReason: string | null;
  };
  obligations: {
    undeliveredQty: number;
    undeliveredLines: string[];
    openSupplierQty: number;
    openSupplierValue: string;
    openSupplierOrders: number;
    pendingAcknowledgements: number;
    invoicedTotal: string;
    paidTotal: string;
    outstandingCustomerBalance: string;
    billedBySupplier: string;
    paidToSupplier: string;
    supplierOutstanding: string;
    unbilledValue: string;
    openDiscrepancies: number;
    openQualityIssues: number;
  };
  policy: ClosurePolicy;
  readyToClose: boolean;
  blockingReasons: string[];
};

export async function dealClosureSummary(salesOrderId: string): Promise<ClosureSummary | null> {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      total: true,
      customerName: true,
      closedAt: true,
      closureOverrideReason: true,
    },
  });
  if (!order) return null;

  const [metrics, invoices, bills, discrepancies, pendingAcks, openPos, policy] = await Promise.all([
    db.$transaction((tx) => orderMetrics(tx, salesOrderId)),
    db.customerInvoice.findMany({
      where: { salesOrderId, status: { not: "VOID" } },
      select: { total: true, amountPaid: true },
    }),
    db.supplierBill.findMany({
      where: { purchaseOrder: { salesOrderId } },
      select: { total: true, paidAmount: true, status: true },
    }),
    db.orderDiscrepancy.findMany({ where: { salesOrderId, status: "OPEN" }, select: { code: true, entityType: true } }),
    db.supplierAcknowledgement.count({
      where: { reviewStatus: "PENDING", purchaseOrder: { salesOrderId } },
    }),
    db.purchaseOrder.count({
      where: { salesOrderId, status: { notIn: ["RECEIVED", "COMPLETED", "CANCELLED"] } },
    }),
    closurePolicy(),
  ]);

  const invoicedTotal = money(sum(invoices.map((invoice) => invoice.total)));
  const paidTotal = money(sum(invoices.map((invoice) => invoice.amountPaid)));
  const billedBySupplier = money(sum(bills.map((bill) => bill.total)));
  const paidToSupplier = money(sum(bills.map((bill) => bill.paidAmount)));
  const outstandingCustomerBalance = money(invoicedTotal.minus(paidTotal));
  const supplierOutstanding = money(billedBySupplier.minus(paidToSupplier));
  const undeliveredLines = metrics.lines.filter((line) => line.remainingToDeliver.gt(0)).map((line) => line.description);
  const openQualityIssues = discrepancies.filter((discrepancy) => discrepancy.entityType === "GoodsReceipt").length;

  const blockingReasons: string[] = [];
  if (policy.requireFullDelivery && undeliveredLines.length > 0) {
    blockingReasons.push(`${undeliveredLines.length} line(s) are not fully delivered: ${undeliveredLines.slice(0, 3).join(", ")}.`);
  }
  if (metrics.openSupplierQty.gt(0)) {
    blockingReasons.push(`${metrics.openSupplierQty.toFixed(4)} unit(s) remain open with suppliers (${toMoneyString(metrics.openSupplierValue)}).`);
  }
  if (policy.requireFullInvoicing && metrics.unbilledValue.gt(0)) {
    blockingReasons.push(`${toMoneyString(metrics.unbilledValue)} of delivered value is not invoiced.`);
  }
  if (policy.requireCustomerPaid && outstandingCustomerBalance.gt(0)) {
    blockingReasons.push(`${toMoneyString(outstandingCustomerBalance)} is still receivable from the customer.`);
  }
  if (policy.requireSupplierSettled && supplierOutstanding.gt(0)) {
    blockingReasons.push(`${toMoneyString(supplierOutstanding)} is still payable to suppliers.`);
  }
  if (!policy.allowOpenDiscrepancies && discrepancies.length > 0) {
    blockingReasons.push(`${discrepancies.length} open discrepancy record(s) must be resolved or waived.`);
  }
  if (pendingAcks > 0) {
    blockingReasons.push(`${pendingAcks} supplier reply/replies are awaiting owner review.`);
  }

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      total: toMoneyString(order.total),
      customerName: order.customerName,
      closedAt: order.closedAt,
      closureOverrideReason: order.closureOverrideReason,
    },
    obligations: {
      undeliveredQty: Number(metrics.lines.reduce((total, line) => total.plus(line.remainingToDeliver), dec(0)).toFixed(4)),
      undeliveredLines,
      openSupplierQty: Number(metrics.openSupplierQty.toFixed(4)),
      openSupplierValue: toMoneyString(metrics.openSupplierValue),
      openSupplierOrders: openPos,
      pendingAcknowledgements: pendingAcks,
      invoicedTotal: toMoneyString(invoicedTotal),
      paidTotal: toMoneyString(paidTotal),
      outstandingCustomerBalance: toMoneyString(outstandingCustomerBalance),
      billedBySupplier: toMoneyString(billedBySupplier),
      paidToSupplier: toMoneyString(paidToSupplier),
      supplierOutstanding: toMoneyString(supplierOutstanding),
      unbilledValue: toMoneyString(metrics.unbilledValue),
      openDiscrepancies: discrepancies.length,
      openQualityIssues,
    },
    policy,
    readyToClose: blockingReasons.length === 0,
    blockingReasons,
  };
}

export async function closeSalesOrder(input: {
  salesOrderId: string;
  userId: string;
  actorLabel: string;
  role: "OWNER" | "STAFF" | string;
  overrideReason?: string | null;
  note?: string | null;
}): Promise<{ ok: true; overridden: boolean } | { ok: false; error: string; blockingReasons?: string[] }> {
  const summary = await dealClosureSummary(input.salesOrderId);
  if (!summary) return { ok: false, error: "Sales order not found." };
  if (summary.order.status === "CLOSED") return { ok: false, error: "This deal is already closed." };
  if (summary.order.status === "CANCELLED") return { ok: false, error: "A cancelled order cannot be closed." };

  const overrideReason = input.overrideReason?.trim() || null;
  if (!summary.readyToClose) {
    if (!overrideReason) {
      return {
        ok: false,
        error: "This deal still has mandatory obligations and cannot be closed. Resolve them, or record an explicit owner override reason.",
        blockingReasons: summary.blockingReasons,
      };
    }
    if (input.role !== "OWNER") {
      return {
        ok: false,
        error: "Only the owner can override open obligations to close a deal.",
        blockingReasons: summary.blockingReasons,
      };
    }
  }

  const overridden = !summary.readyToClose;
  const before = {
    status: summary.order.status,
    obligations: summary.obligations,
    blockingReasons: summary.blockingReasons,
  };

  const applied = await db.$transaction(async (tx) => {
    const claimed = await tx.salesOrder.updateMany({
      where: { id: summary.order.id, status: { notIn: ["CLOSED", "CANCELLED"] } },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedById: input.userId,
        closureNote: input.note?.trim() || null,
        ...(overridden
          ? { closureOverrideById: input.userId, closureOverrideReason: overrideReason }
          : {}),
      },
    });
    if (claimed.count === 0) return false;

    await recordOrderEvent(tx, {
      entityType: "SalesOrder",
      entityId: summary.order.id,
      fromStatus: summary.order.status,
      toStatus: "CLOSED",
      actorId: input.userId,
      actorLabel: input.actorLabel,
      reason: overridden ? `Owner override: ${overrideReason}` : input.note?.trim() || "All closure conditions satisfied",
      meta: { overridden, before, after: { status: "CLOSED" } },
    });
    const order = await tx.salesOrder.findUnique({ where: { id: summary.order.id }, select: { enquiryId: true } });
    if (order?.enquiryId) {
      await tx.enquiry.update({ where: { id: order.enquiryId }, data: { status: "CLOSED" } });
    }
    return true;
  });
  if (!applied) return { ok: false, error: "This deal was already closed." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: overridden ? "sales_order.closed_with_override" : "sales_order.closed",
    entityType: "SalesOrder",
    entityId: summary.order.id,
    meta: {
      orderNumber: summary.order.orderNumber,
      overridden,
      overrideReason: overridden ? overrideReason : null,
      note: input.note?.trim() || null,
      before,
      after: { status: "CLOSED", closedAt: new Date().toISOString() },
    },
  });
  return { ok: true, overridden };
}

export async function resolveOrderDiscrepancy(input: {
  discrepancyId: string;
  note: string;
  decision?: "RESOLVED" | "WAIVED";
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.note.trim()) return { ok: false, error: "Record how the discrepancy was resolved." };
  const discrepancy = await db.orderDiscrepancy.findUnique({ where: { id: input.discrepancyId } });
  if (!discrepancy) return { ok: false, error: "Discrepancy not found." };
  if (discrepancy.status !== "OPEN") return { ok: false, error: "This discrepancy is already resolved." };
  const decision = input.decision ?? "RESOLVED";
  const applied = await db.orderDiscrepancy.updateMany({
    where: { id: discrepancy.id, status: "OPEN" },
    data: { status: decision, resolvedById: input.userId, resolvedAt: new Date(), resolutionNote: input.note.trim() },
  });
  if (applied.count === 0) return { ok: false, error: "This discrepancy is already resolved." };
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: `order_discrepancy.${decision.toLowerCase()}`,
    entityType: "OrderDiscrepancy",
    entityId: discrepancy.id,
    meta: {
      code: discrepancy.code,
      entityType: discrepancy.entityType,
      entityId: discrepancy.entityId,
      note: input.note,
      detail: parseJson<Record<string, unknown>>(discrepancy.detailJson, {}),
    },
  });
  return { ok: true };
}

/** Short obligation line for the order list. */
export function closureHeadline(summary: ClosureSummary): string {
  if (summary.order.status === "CLOSED") return "Closed";
  if (summary.readyToClose) return "Ready to close";
  return summary.blockingReasons[0] ?? "In progress";
}

export { stringifyJson };
