import type { Prisma } from "@prisma/client";
import { dec, money, qty, sum, toNumber, type Dec } from "./money";

/**
 * Per-line fulfilment and financial metrics, derived from durable records only.
 * Nothing here is a cached counter that can drift: receipt, delivery and invoice
 * lines are aggregated on every read.
 *
 * Supplier commitment rules:
 *  - accepted receipts count as received stock regardless of the PO's later
 *    status, so cancelling/rejecting a PO never erases goods already accepted;
 *  - REJECTED/CANCELLED release only the unreceived part of the commitment;
 *  - an approved acknowledgement (including PARTIALLY_ACKNOWLEDGED) commits the
 *    quantity the supplier actually confirmed, never the full ordered quantity;
 *  - a SENT/ACKNOWLEDGEMENT_RECEIVED PO without owner approval is shown as a
 *    provisional commitment, not a confirmed one.
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
  provisionalSupplierQty: Dec;
  acknowledgedSupplierQty: Dec;
  releasedSupplierQty: Dec;
  receivedAccepted: Dec;
  openSupplierCommitment: Dec;
  dispatched: Dec;
  delivered: Dec;
  invoiced: Dec;
  availableToDispatch: Dec;
  remainingToReceive: Dec;
  remainingToProcure: Dec;
  remainingToDeliver: Dec;
  remainingToInvoice: Dec;
  unbilledValue: Dec;
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
  provisionalSupplierQty: Dec;
  acknowledgedSupplierQty: Dec;
  releasedSupplierQty: Dec;
  remainingToProcureQty: Dec;
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
        acknowledgedQuantity: true;
        purchaseOrder: { select: { status: true } };
        receiptLines: { select: { quantityAccepted: true } };
      };
    };
    deliveryLines: { select: { quantity: true; delivery: { select: { status: true } } } };
    invoiceLines: { select: { quantity: true; invoice: { select: { status: true } } } };
  };
}>;

export type PurchaseOrderLineCoverage = {
  ordered: Dec;
  accepted: Dec;
  committed: Dec;
  open: Dec;
  provisional: Dec;
  acknowledged: Dec;
  released: Dec;
};

const RELEASED_STATUSES = new Set(["REJECTED", "CANCELLED"]);
const PROVISIONAL_STATUSES = new Set(["SENT", "ACKNOWLEDGEMENT_RECEIVED"]);

/**
 * Coverage contributed by one PO line. `accepted` is always counted; only the
 * still-open part of a live commitment is added so receipts are not double
 * counted. A rejected/cancelled line contributes its receipts but releases the
 * unreceived remainder.
 */
export function coverageForPurchaseOrderLine(line: {
  quantity: Prisma.Decimal.Value;
  acknowledgedQuantity: Prisma.Decimal.Value | null;
  purchaseOrder: { status: string };
  receiptLines: Array<{ quantityAccepted: Prisma.Decimal.Value }>;
}): PurchaseOrderLineCoverage {
  const ordered = qty(line.quantity);
  const accepted = qty(sum(line.receiptLines.map((receipt) => receipt.quantityAccepted)));
  const released = RELEASED_STATUSES.has(line.purchaseOrder.status);
  const committed = released ? qty(0) : qty(line.acknowledgedQuantity ?? ordered);
  const open = committed.minus(accepted).gt(0) ? qty(committed.minus(accepted)) : qty(0);
  const provisional = !released && line.acknowledgedQuantity == null && PROVISIONAL_STATUSES.has(line.purchaseOrder.status)
    ? open
    : qty(0);
  const acknowledged = !released && line.acknowledgedQuantity != null ? committed : qty(0);
  const releasedQty = released && ordered.minus(accepted).gt(0) ? qty(ordered.minus(accepted)) : qty(0);
  return { ordered, accepted, committed, open, provisional, acknowledged, released: releasedQty };
}

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
          acknowledgedQuantity: true,
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
    let provisionalSupplierQty = dec(0);
    let acknowledgedSupplierQty = dec(0);
    let releasedSupplierQty = dec(0);

    for (const poLine of row.purchaseOrderLines) {
      const coverage = coverageForPurchaseOrderLine(poLine);
      receivedAccepted = receivedAccepted.plus(coverage.accepted);
      orderedFromSuppliers = orderedFromSuppliers.plus(coverage.committed);
      openSupplierCommitment = openSupplierCommitment.plus(coverage.open);
      openSupplierValue = openSupplierValue.plus(money(coverage.open.times(poLine.unitPrice)));
      provisionalSupplierQty = provisionalSupplierQty.plus(coverage.provisional);
      acknowledgedSupplierQty = acknowledgedSupplierQty.plus(coverage.acknowledged);
      releasedSupplierQty = releasedSupplierQty.plus(coverage.released);
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
    const remainingToReceive = qty(procureQuantity.minus(receivedAccepted).lt(0) ? dec(0) : procureQuantity.minus(receivedAccepted));
    const remainingToProcure = qty(
      procureQuantity.minus(receivedAccepted).minus(openSupplierCommitment).lt(0)
        ? dec(0)
        : procureQuantity.minus(receivedAccepted).minus(openSupplierCommitment),
    );

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
      provisionalSupplierQty,
      acknowledgedSupplierQty,
      releasedSupplierQty,
      receivedAccepted,
      openSupplierCommitment,
      dispatched,
      delivered,
      invoiced,
      availableToDispatch,
      remainingToReceive,
      remainingToProcure,
      remainingToDeliver: qty(quantity.minus(delivered)),
      remainingToInvoice: remainingToInvoiceQty,
      unbilledValue: unbilled,
    };
  });

  const deliveredValue = money(
    lines.reduce((total, line) => {
      const ratio = line.quantity.gt(0) ? line.delivered.div(line.quantity) : dec(0);
      const orderValue = money(line.quantity.times(line.unitPrice));
      return total.plus(money(orderValue.times(ratio)).times(dec(1).plus(line.taxRatePct.div(100))));
    }, dec(0)),
  );
  const unbilledValue = money(lines.reduce((total, line) => total.plus(line.unbilledValue), dec(0)));

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
    provisionalSupplierQty: qty(sum(lines.map((line) => line.provisionalSupplierQty))),
    acknowledgedSupplierQty: qty(sum(lines.map((line) => line.acknowledgedSupplierQty))),
    releasedSupplierQty: qty(sum(lines.map((line) => line.releasedSupplierQty))),
    remainingToProcureQty: qty(sum(lines.map((line) => line.remainingToProcure))),
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
