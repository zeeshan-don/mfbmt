import type { Prisma } from "@prisma/client";
import { money, sum, toNumber } from "./money";
import { orderMetrics } from "./metrics";
import { recordOrderEvent } from "./events";

/**
 * Derives a sales order's lifecycle state from its durable records.
 *
 * The stored status is a materialised summary, never the source of truth. A
 * status can only move forward through the documented sequence; CLOSED is set
 * exclusively by the closure engine.
 */
export const SALES_ORDER_STATUSES = [
  "ORDER_CONFIRMED",
  "PROCUREMENT_IN_PROGRESS",
  "PARTIALLY_RECEIVED",
  "READY_TO_DISPATCH",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "PARTIALLY_INVOICED",
  "INVOICED",
  "PARTIALLY_PAID",
  "SETTLED",
  "CLOSED",
  "CANCELLED",
] as const;

export const SALES_ORDER_STATUS_LABELS: Record<string, string> = {
  ORDER_CONFIRMED: "Order confirmed",
  PROCUREMENT_IN_PROGRESS: "Procurement in progress",
  PARTIALLY_RECEIVED: "Partly received",
  READY_TO_DISPATCH: "Ready to dispatch",
  PARTIALLY_DELIVERED: "Partly delivered",
  DELIVERED: "Delivered",
  PARTIALLY_INVOICED: "Partly invoiced",
  INVOICED: "Invoiced",
  PARTIALLY_PAID: "Partly paid",
  SETTLED: "Settled",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export async function deriveSalesOrderStatus(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
): Promise<string> {
  const metrics = await orderMetrics(tx, salesOrderId);
  const invoices = await tx.customerInvoice.findMany({
    where: { salesOrderId, status: { not: "VOID" } },
    select: { total: true, amountPaid: true },
  });
  const invoiceTotal = money(sum(invoices.map((invoice) => invoice.total)));
  const paidTotal = money(sum(invoices.map((invoice) => invoice.amountPaid)));
  const allInvoiced = metrics.allDelivered && metrics.lines.every((line) => line.remainingToInvoice.lte(0));

  if (metrics.allDelivered) {
    if (allInvoiced) {
      if (invoiceTotal.gt(0) && paidTotal.gte(invoiceTotal)) return "SETTLED";
      if (paidTotal.gt(0)) return "PARTIALLY_PAID";
      return "INVOICED";
    }
    if (invoiceTotal.gt(0)) return "PARTIALLY_INVOICED";
    return "DELIVERED";
  }
  if (metrics.anyDelivered) return "PARTIALLY_DELIVERED";
  if (metrics.allReceivedOrStock) return "READY_TO_DISPATCH";
  if (metrics.anyReceived) return "PARTIALLY_RECEIVED";
  if (metrics.openSupplierQty.gt(0)) return "PROCUREMENT_IN_PROGRESS";
  return "ORDER_CONFIRMED";
}

/** Recomputes and stores the order status, recording one event per transition. */
export async function refreshSalesOrderStatus(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  actor?: { id?: string | null; label?: string },
): Promise<string | null> {
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { status: true, orderNumber: true },
  });
  if (!order) return null;
  if (order.status === "CLOSED" || order.status === "CANCELLED") return order.status;

  const nextStatus = await deriveSalesOrderStatus(tx, salesOrderId);
  if (nextStatus === order.status) return order.status;

  const updated = await tx.salesOrder.updateMany({
    where: { id: salesOrderId, status: order.status },
    data: { status: nextStatus },
  });
  if (updated.count === 0) return null;

  await recordOrderEvent(tx, {
    entityType: "SalesOrder",
    entityId: salesOrderId,
    fromStatus: order.status,
    toStatus: nextStatus,
    actorId: actor?.id ?? null,
    actorLabel: actor?.label ?? "system",
  });
  return nextStatus;
}

export function orderProgress(metrics: Awaited<ReturnType<typeof orderMetrics>>) {
  return {
    ordered: toNumber(metrics.orderQty),
    delivered: toNumber(metrics.deliveredQty),
    invoiced: toNumber(metrics.invoicedQty),
    openSupplier: toNumber(metrics.openSupplierQty),
    unbilledValue: toNumber(metrics.unbilledValue),
    deliveredPct:
      metrics.orderQty.gt(0) ? Math.min(100, Math.round((toNumber(metrics.deliveredQty) / toNumber(metrics.orderQty)) * 100)) : 0,
  };
}

export function initialSalesOrderStatus(input: { allFromStock: boolean }): string {
  return input.allFromStock ? "READY_TO_DISPATCH" : "PROCUREMENT_IN_PROGRESS";
}
