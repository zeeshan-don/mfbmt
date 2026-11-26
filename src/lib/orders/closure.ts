import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { writeAudit } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { dec, money, qty, sum, toMoneyString } from "./money";
import { coverageForPurchaseOrderLine, orderMetrics } from "./metrics";
import { recordOrderEvent } from "./events";
import { lockSalesOrder, OrderLockError } from "./locks";

/**
 * Verified deal closure.
 *
 * Closure is computed from the records, never from a status alone. Mandatory
 * obligations (undelivered quantity, open supplier commitments, unbilled value,
 * unpaid customer balance, open discrepancies) block closure. An owner may
 * override with an explicit reason; the override keeps the before/after state.
 *
 * The authoritative summary is always calculated inside the transaction that
 * holds the sales-order lock and performs the status change. A summary read
 * before the transaction is display-only and never authorises closure.
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

type ReadClient = Pick<Prisma.TransactionClient, "appSetting">;

export async function closurePolicy(client?: ReadClient): Promise<ClosurePolicy> {
  const setting = await (client ?? db).appSetting.findFirst({ where: { key: "orders.closurePolicy" } });
  const saved = parseJson<Partial<ClosurePolicy>>(setting?.value, {});
  return {
    requireFullDelivery: saved.requireFullDelivery ?? DEFAULT_CLOSURE_POLICY.requireFullDelivery,
    requireFullInvoicing: saved.requireFullInvoicing ?? DEFAULT_CLOSURE_POLICY.requireFullInvoicing,
    requireCustomerPaid: saved.requireCustomerPaid ?? DEFAULT_CLOSURE_POLICY.requireCustomerPaid,
    requireSupplierSettled: saved.requireSupplierSettled ?? DEFAULT_CLOSURE_POLICY.requireSupplierSettled,
    allowOpenDiscrepancies: saved.allowOpenDiscrepancies ?? DEFAULT_CLOSURE_POLICY.allowOpenDiscrepancies,
  };
}

export type CurrencyObligations = {
  openCommitment: string;
  billed: string;
  paid: string;
  outstanding: string;
};

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
    openSupplierValueByCurrency: Record<string, string>;
    openSupplierOrders: number;
    pendingAcknowledgements: number;
    invoicedTotal: string;
    paidTotal: string;
    outstandingCustomerBalance: string;
    billedBySupplier: string;
    paidToSupplier: string;
    supplierOutstanding: string;
    supplierOutstandingByCurrency: Record<string, CurrencyObligations>;
    unbilledValue: string;
    openDiscrepancies: number;
    openQualityIssues: number;
  };
  policy: ClosurePolicy;
  readyToClose: boolean;
  blockingReasons: string[];
};

const addCurrency = (map: Record<string, Prisma.Decimal>, currency: string, amount: Prisma.Decimal) => {
  map[currency] = money((map[currency] ?? dec(0)).plus(amount));
};

/**
 * The authoritative calculation. Every query runs on the supplied transaction
 * client so the caller has locked the order and sees one consistent snapshot.
 */
export async function dealClosureSummaryTx(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
): Promise<ClosureSummary | null> {
  const order = await tx.salesOrder.findUnique({
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

  const [metrics, invoices, bills, discrepancies, pendingAcks, pos, policy] = await Promise.all([
    orderMetrics(tx, salesOrderId),
    tx.customerInvoice.findMany({
      where: { salesOrderId, status: { not: "VOID" } },
      select: { total: true, amountPaid: true, currency: true },
    }),
    tx.supplierBill.findMany({
      where: { purchaseOrder: { salesOrderId } },
      select: { total: true, paidAmount: true, currency: true, status: true },
    }),
    tx.orderDiscrepancy.findMany({ where: { salesOrderId, status: "OPEN" }, select: { code: true, entityType: true } }),
    tx.supplierAcknowledgement.count({
      where: { reviewStatus: "PENDING", purchaseOrder: { salesOrderId } },
    }),
    tx.purchaseOrder.findMany({
      where: { salesOrderId },
      select: {
        id: true,
        currency: true,
        status: true,
        lines: {
          select: {
            quantity: true,
            acknowledgedQuantity: true,
            unitPrice: true,
            receiptLines: { select: { quantityAccepted: true } },
          },
        },
      },
    }),
    closurePolicy(tx),
  ]);

  const invoicedTotal = money(sum(invoices.map((invoice) => invoice.total)));
  const paidTotal = money(sum(invoices.map((invoice) => invoice.amountPaid)));
  const billedBySupplier = money(sum(bills.map((bill) => bill.total)));
  const paidToSupplier = money(sum(bills.map((bill) => bill.paidAmount)));
  const outstandingCustomerBalance = money(invoicedTotal.minus(paidTotal));
  const undeliveredLines = metrics.lines.filter((line) => line.remainingToDeliver.gt(0)).map((line) => line.description);
  const openQualityIssues = discrepancies.filter((discrepancy) => discrepancy.entityType === "GoodsReceipt").length;

  // Supplier money is only ever compared/added inside one currency.
  const supplierOutstandingByCurrency: Record<string, CurrencyObligations> = {};
  const openSupplierValueByCurrency: Record<string, Prisma.Decimal> = {};
  const billedByCurrency: Record<string, Prisma.Decimal> = {};
  const paidByCurrency: Record<string, Prisma.Decimal> = {};

  for (const bill of bills) {
    addCurrency(billedByCurrency, bill.currency, dec(bill.total));
    addCurrency(paidByCurrency, bill.currency, dec(bill.paidAmount));
  }
  for (const currency of new Set([...Object.keys(billedByCurrency), ...Object.keys(paidByCurrency)])) {
    const billed = money(billedByCurrency[currency] ?? dec(0));
    const paid = money(paidByCurrency[currency] ?? dec(0));
    supplierOutstandingByCurrency[currency] = {
      openCommitment: "0.00",
      billed: toMoneyString(billed),
      paid: toMoneyString(paid),
      outstanding: toMoneyString(money(billed.minus(paid))),
    };
  }

  let openSupplierOrders = 0;
  for (const po of pos) {
    if (["REJECTED", "CANCELLED"].includes(po.status)) continue;
    let open = dec(0);
    for (const line of po.lines) {
      const coverage = coverageForPurchaseOrderLine({
        quantity: line.quantity,
        acknowledgedQuantity: line.acknowledgedQuantity,
        purchaseOrder: { status: po.status },
        receiptLines: line.receiptLines,
      });
      open = open.plus(coverage.open);
      if (coverage.open.gt(0)) {
        addCurrency(openSupplierValueByCurrency, po.currency, money(coverage.open.times(line.unitPrice)));
      }
    }
    if (open.gt(0)) openSupplierOrders += 1;
  }
  for (const currency of Object.keys(openSupplierValueByCurrency)) {
    const existing = supplierOutstandingByCurrency[currency];
    supplierOutstandingByCurrency[currency] = {
      openCommitment: toMoneyString(openSupplierValueByCurrency[currency]),
      billed: existing?.billed ?? "0.00",
      paid: existing?.paid ?? "0.00",
      outstanding: existing?.outstanding ?? "0.00",
    };
  }

  const orderCurrencyOpenValue = openSupplierValueByCurrency[order.currency] ?? dec(0);
  const orderCurrencyOutstanding = supplierOutstandingByCurrency[order.currency]?.outstanding ?? "0.00";

  const blockingReasons: string[] = [];
  if (policy.requireFullDelivery && undeliveredLines.length > 0) {
    blockingReasons.push(`${undeliveredLines.length} line(s) are not fully delivered: ${undeliveredLines.slice(0, 3).join(", ")}.`);
  }
  if (metrics.openSupplierQty.gt(0)) {
    const currencyDetail = Object.entries(openSupplierValueByCurrency)
      .map(([currency, value]) => `${currency} ${toMoneyString(value)}`)
      .join(", ");
    blockingReasons.push(`${metrics.openSupplierQty.toFixed(4)} unit(s) remain open with suppliers (${currencyDetail}).`);
  }
  if (policy.requireFullInvoicing && metrics.unbilledValue.gt(0)) {
    blockingReasons.push(`${toMoneyString(metrics.unbilledValue)} of delivered value is not invoiced.`);
  }
  if (policy.requireCustomerPaid && outstandingCustomerBalance.gt(0)) {
    blockingReasons.push(`${order.currency} ${toMoneyString(outstandingCustomerBalance)} is still receivable from the customer.`);
  }
  if (policy.requireSupplierSettled) {
    // Checked independently per currency; unlike currencies are never added.
    for (const [currency, amounts] of Object.entries(supplierOutstandingByCurrency)) {
      if (money(amounts.outstanding).gt(0)) {
        blockingReasons.push(`${currency} ${amounts.outstanding} is still payable to suppliers.`);
      }
    }
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
      openSupplierValue: toMoneyString(orderCurrencyOpenValue),
      openSupplierValueByCurrency: Object.fromEntries(
        Object.entries(openSupplierValueByCurrency).map(([currency, value]) => [currency, toMoneyString(value)]),
      ),
      openSupplierOrders,
      pendingAcknowledgements: pendingAcks,
      invoicedTotal: toMoneyString(invoicedTotal),
      paidTotal: toMoneyString(paidTotal),
      outstandingCustomerBalance: toMoneyString(outstandingCustomerBalance),
      billedBySupplier: toMoneyString(billedBySupplier),
      paidToSupplier: toMoneyString(paidToSupplier),
      supplierOutstanding: orderCurrencyOutstanding,
      supplierOutstandingByCurrency,
      unbilledValue: toMoneyString(metrics.unbilledValue),
      openDiscrepancies: discrepancies.length,
      openQualityIssues,
    },
    policy,
    readyToClose: blockingReasons.length === 0,
    blockingReasons,
  };
}

/** Display-only summary. Closure itself always recalculates under the lock. */
export async function dealClosureSummary(salesOrderId: string): Promise<ClosureSummary | null> {
  return db.$transaction((tx) => dealClosureSummaryTx(tx, salesOrderId));
}

export async function closeSalesOrder(input: {
  salesOrderId: string;
  userId: string;
  actorLabel: string;
  role: "OWNER" | "STAFF" | string;
  overrideReason?: string | null;
  note?: string | null;
}): Promise<{ ok: true; overridden: boolean } | { ok: false; error: string; blockingReasons?: string[] }> {
  const overrideReason = input.overrideReason?.trim() || null;

  try {
    return await db.$transaction(async (tx) => {
      // The lock is acquired before any obligation is read. Every other
      // commercial mutation takes the same lock, so no new PO, receipt,
      // delivery, invoice or payment can appear after this validation.
      const locked = await lockSalesOrder(tx, input.salesOrderId, { allowTerminal: true });
      if (locked.status === "CLOSED") return { ok: false as const, error: "This deal is already closed." };
      if (locked.status === "CANCELLED") return { ok: false as const, error: "A cancelled order cannot be closed." };

      const summary = await dealClosureSummaryTx(tx, input.salesOrderId);
      if (!summary) return { ok: false as const, error: "Sales order not found." };

      if (!summary.readyToClose) {
        if (!overrideReason) {
          return {
            ok: false as const,
            error: "This deal still has mandatory obligations and cannot be closed. Resolve them, or record an explicit owner override reason.",
            blockingReasons: summary.blockingReasons,
          };
        }
        if (input.role !== "OWNER") {
          return {
            ok: false as const,
            error: "Only the owner can override open obligations to close a deal.",
            blockingReasons: summary.blockingReasons,
          };
        }
      }

      const overridden = !summary.readyToClose;
      const before = {
        status: locked.status,
        obligations: summary.obligations,
        blockingReasons: summary.blockingReasons,
      };
      const closedAt = new Date();

      const claimed = await tx.salesOrder.updateMany({
        where: { id: locked.id, status: locked.status },
        data: {
          status: "CLOSED",
          closedAt,
          closedById: input.userId,
          closureNote: input.note?.trim() || null,
          ...(overridden
            ? { closureOverrideById: input.userId, closureOverrideReason: overrideReason }
            : {}),
        },
      });
      if (claimed.count === 0) {
        return { ok: false as const, error: "The order changed while it was being closed; reload and try again." };
      }

      await recordOrderEvent(tx, {
        entityType: "SalesOrder",
        entityId: locked.id,
        fromStatus: locked.status,
        toStatus: "CLOSED",
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: overridden ? `Owner override: ${overrideReason}` : input.note?.trim() || "All closure conditions satisfied",
        meta: { overridden, before, after: { status: "CLOSED", closedAt: closedAt.toISOString() } },
      });
      const order = await tx.salesOrder.findUnique({ where: { id: locked.id }, select: { enquiryId: true } });
      if (order?.enquiryId) {
        await tx.enquiry.update({ where: { id: order.enquiryId }, data: { status: "CLOSED" } });
      }
      await tx.auditLog.create({
        data: {
          actorId: input.userId,
          actorLabel: input.actorLabel,
          action: overridden ? "sales_order.closed_with_override" : "sales_order.closed",
          entityType: "SalesOrder",
          entityId: locked.id,
          metaJson: stringifyJson({
            orderNumber: locked.orderNumber,
            overridden,
            overrideReason: overridden ? overrideReason : null,
            note: input.note?.trim() || null,
            before,
            after: { status: "CLOSED", closedAt: closedAt.toISOString() },
          }),
        },
      });

      return { ok: true as const, overridden };
    });
  } catch (error) {
    if (error instanceof OrderLockError) return { ok: false, error: error.message };
    throw error;
  }
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

export { qty };
