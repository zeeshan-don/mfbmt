import type { Prisma } from "@prisma/client";
import { dec, money, qty, sum, toNumber, type Dec } from "./money";

/**
 * Per-line fulfilment and financial metrics, derived from durable records only.
 * Nothing here is a cached counter that can drift: receipt, delivery and invoice
 * lines are aggregated on every read.
 */
export type LineMetrics = {
  id: string;
  lineNo: number;
  description: string;
  unit: string;
  quantity: Dec;
  unitPrice: Dec;
  taxRatePct: Dec;
  stockQuantity: Dec;
  procureQuantity: Dec;
  orderedFromSuppliers: Dec;
  receivedAccepted: Dec;
  openSupplierCommitment: Dec;
  dispatched: Dec;
  delivered: Dec;
  invoiced: Dec;
  availableToDispatch: Dec;
  remainingToReceive: Dec;
  remainingToDeliver: Dec;
  remainingToInvoice: Dec;
};

export type OrderMetrics = {
  lines: LineMetrics[];
  orderQty: Dec;
  deliveredQty: Dec;
  invoicedQty: Dec;
  deliveredValue: Dec;
  unbilledValue: Dec;
  openSupplierQty: Dec;
  openSupplierValue: Dec;
  allDelivered: boolean;
  allReceivedOrStock: boolean;
  anyDelivered: boolean;
  anyReceived: boolean;
};

type LineRow = Prisma.SalesOrderLineGetPayload<{
  include: {
    purchaseOrderLines: {
      select: {
        id: true;
        quantity: true;
        unitPrice: true;
        purchaseOrder: { select: { status: true } };
        receiptLines: { select: { quantityAccepted: true } };
      };
    };
    deliveryLines: { select: { quantity: true; delivery: { select: { status: true } } } };
    invoiceLines: { select: { quantity: true; invoice: { select: { status: true } } } };
  };
}>;

const CANCELLED = new Set(["CANCELLED"]);

export async function loadOrderLines(tx: Prisma.TransactionClient, salesOrderId: string): Promise<LineRow[]> {
  return tx.salesOrderLine.findMany({
    where: { salesOrderId },
    orderBy: { lineNo: "asc" },
    include: {
      purchaseOrderLines: {
        select: {
          id: true,
          quantity: true,
          unitPrice: true,
          purchaseOrder: { select: { status: true } },
          receiptLines: { select: { quantityAccepted: true } },
        },
      },
      deliveryLines: { select: { quantity: true, delivery: { select: { status: true } } } },
      invoiceLines: { select: { quantity: true, invoice: { select: { status: true } } } },
    },
  });
}

/** Metrics for one order from a single consistent snapshot of its records. */
export async function orderMetrics(tx: Prisma.TransactionClient, salesOrderId: string): Promise<OrderMetrics> {
  const rows = await loadOrderLines(tx, salesOrderId);
  const lines: LineMetrics[] = rows.map((row) => {
    let receivedAccepted = dec(0);
    let orderedFromSuppliers = dec(0);
    let openSupplierCommitment = dec(0);
    let openSupplierValue = dec(0);
    for (const poLine of row.purchaseOrderLines) {
      if (CANCELLED.has(poLine.purchaseOrder.status)) continue;
      const ordered = qty(poLine.quantity);
      const accepted = qty(sum(poLine.receiptLines.map((line) => line.quantityAccepted)));
      orderedFromSuppliers = orderedFromSuppliers.plus(ordered);
      receivedAccepted = receivedAccepted.plus(accepted);
      const open = qty(ordered.minus(accepted));
      if (open.gt(0)) {
        openSupplierCommitment = openSupplierCommitment.plus(open);
        openSupplierValue = openSupplierValue.plus(money(open.times(poLine.unitPrice)));
      }
    }

    const dispatched = qty(
      sum(
        row.deliveryLines
          .filter((line) => line.delivery.status !== "CANCELLED")
          .map((line) => line.quantity),
      ),
    );
    const delivered = qty(
      sum(
        row.deliveryLines
          .filter((line) => line.delivery.status === "DELIVERED")
          .map((line) => line.quantity),
      ),
    );
    const invoiced = qty(
      sum(
        row.invoiceLines
          .filter((line) => line.invoice.status !== "VOID")
          .map((line) => line.quantity),
      ),
    );

    const quantity = qty(row.quantity);
    const stockQuantity = qty(row.stockQuantity);
    const procureQuantity = qty(row.procureQuantity);
    const availableToDispatch = qty(stockQuantity.plus(receivedAccepted).minus(dispatched));
    const remainingToReceive = qty(procureQuantity.minus(receivedAccepted));

    const remainingToInvoiceQty = qty(delivered.minus(invoiced));
    const unitNet = money(row.unitPrice);
    const unbilled = remainingToInvoiceQty.gt(0)
      ? money(
          remainingToInvoiceQty
            .times(unitNet)
            .times(dec(1).minus(dec(row.discountPct).div(100)))
            .times(dec(1).plus(dec(row.taxRatePct).div(100))),
        )
      : dec(0);

    return {
      id: row.id,
      lineNo: row.lineNo,
      description: row.description,
      unit: row.unit,
      quantity,
      unitPrice: unitNet,
      taxRatePct: dec(row.taxRatePct),
      stockQuantity,
      procureQuantity,
      orderedFromSuppliers,
      receivedAccepted,
      openSupplierCommitment,
      dispatched,
      delivered,
      invoiced,
      availableToDispatch,
      remainingToReceive,
      remainingToDeliver: qty(quantity.minus(delivered)),
      remainingToInvoice: remainingToInvoiceQty,
      unbilledValue: unbilled,
    } as LineMetrics & { unbilledValue: Dec };
  });

  const deliveredValue = money(
    lines.reduce((total, line) => {
      const ratio = line.quantity.gt(0) ? line.delivered.div(line.quantity) : dec(0);
      const orderValue = money(line.quantity.times(line.unitPrice));
      return total.plus(money(orderValue.times(ratio)).times(dec(1).plus(line.taxRatePct.div(100))));
    }, dec(0)),
  );
  const unbilledValue = money(lines.reduce((total, line) => total.plus((line as LineMetrics & { unbilledValue: Dec }).unbilledValue), dec(0)));

  return {
    lines,
    orderQty: qty(sum(lines.map((line) => line.quantity))),
    deliveredQty: qty(sum(lines.map((line) => line.delivered))),
    invoicedQty: qty(sum(lines.map((line) => line.invoiced))),
    deliveredValue,
    unbilledValue,
    openSupplierQty: qty(sum(lines.map((line) => line.openSupplierCommitment))),
    openSupplierValue: money(
      lines.reduce((total, line) => total.plus(money(line.openSupplierCommitment.times(line.unitPrice))), dec(0)),
    ),
    allDelivered: lines.length > 0 && lines.every((line) => line.remainingToDeliver.lte(0)),
    allReceivedOrStock: lines.length > 0 && lines.every((line) => line.remainingToReceive.lte(0)),
    anyDelivered: lines.some((line) => line.delivered.gt(0)),
    anyReceived: lines.some((line) => line.receivedAccepted.gt(0)),
  };
}

export type DeliveryLineAvailability = {
  lineId: string;
  description: string;
  unit: string;
  ordered: number;
  available: number;
  delivered: number;
  remaining: number;
};

/** Quantities that may still be dispatched, per line (for the delivery form). */
export function deliveryAvailability(metrics: OrderMetrics): DeliveryLineAvailability[] {
  return metrics.lines.map((line) => ({
    lineId: line.id,
    description: line.description,
    unit: line.unit,
    ordered: toNumber(line.quantity),
    available: toNumber(line.availableToDispatch),
    delivered: toNumber(line.delivered),
    remaining: toNumber(line.remainingToDeliver),
  }));
}
