import { db } from "../db";
import { dec, money, sum, toMoneyString } from "./money";

/**
 * Owner operations board.
 *
 * Every figure is an aggregate over durable records for the signed-in tenant.
 * Financial totals are grouped by currency: amounts in different currencies are
 * never added together, because no exchange-rate evidence exists for a blended
 * figure.
 */

export type CurrencyTotals = { currency: string; amount: string };

async function totalsByCurrency(
  groupBy: () => Promise<Array<{ currency: string; _sum: Record<string, unknown> }>>,
  field: string,
): Promise<CurrencyTotals[]> {
  const rows = await groupBy();
  return rows
    .map((row) => ({ currency: row.currency, amount: toMoneyString(dec((row._sum[field] as never) ?? 0)) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function ownerOperationsBoard() {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const [
    needsReview,
    clarifications,
    sourcingApprovals,
    supplierRfqApprovals,
    supplierReplies,
    quotationApprovals,
    customerPoDiscrepancies,
    supplierPoApprovals,
    lateAcknowledgements,
    overdueDeliveries,
    receiptDiscrepancies,
    overdueInvoices,
    outstandingInvoices,
    activeEnquiries,
    openSalesOrders,
    openSupplierPos,
    ordersInProcurement,
    ordersInFulfilment,
    quotationsOutstanding,
    settledDeals,
    lostDeals,
    pendingSupplierReplies,
  ] = await Promise.all([
    db.enquiry.count({ where: { status: "NEEDS_REVIEW" } }),
    db.enquiryItem.count({ where: { reviewStatus: "NEEDS_CLARIFICATION" } }),
    db.approval.count({ where: { status: "PENDING", type: "SOURCING" } }),
    db.approval.count({ where: { status: "PENDING", type: "SUPPLIER_QUOTE_SEND" } }),
    db.supplierOffer.count({ where: { status: { in: ["QUOTE_RECEIVED", "PRICE_CONFIRMED"] }, verificationStatus: "UNVERIFIED" } }),
    db.approval.count({ where: { status: "PENDING", type: "CUSTOMER_QUOTATION" } }),
    db.orderDiscrepancy.count({ where: { entityType: "SalesOrder", severity: "BLOCKING", status: "OPEN" } }),
    db.purchaseOrder.count({ where: { status: "AWAITING_APPROVAL" } }),
    db.purchaseOrder.count({
      where: { status: { in: ["SENT", "ACKNOWLEDGEMENT_RECEIVED"] }, sentAt: { lt: threeDaysAgo } },
    }),
    db.purchaseOrder.count({
      where: {
        expectedDeliveryDate: { lt: now },
        status: { notIn: ["RECEIVED", "COMPLETED", "CANCELLED"] },
      },
    }),
    db.orderDiscrepancy.count({ where: { entityType: "GoodsReceipt", status: "OPEN" } }),
    db.customerInvoice.count({
      where: { dueDate: { lt: now }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    }),
    db.customerInvoice.count({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } } }),
    db.enquiry.count({ where: { status: { notIn: ["CLOSED", "IGNORED"] } } }),
    db.salesOrder.count({ where: { status: { notIn: ["CLOSED", "CANCELLED"] } } }),
    db.purchaseOrder.count({ where: { status: { notIn: ["RECEIVED", "COMPLETED", "CANCELLED"] } } }),
    db.salesOrder.count({ where: { status: { in: ["ORDER_CONFIRMED", "PROCUREMENT_IN_PROGRESS", "PARTIALLY_RECEIVED"] } } }),
    db.salesOrder.count({
      where: { status: { in: ["READY_TO_DISPATCH", "PARTIALLY_DELIVERED", "DELIVERED", "PARTIALLY_INVOICED"] } },
    }),
    db.customerQuotation.count({ where: { status: "SENT", outcome: null } }),
    db.customerQuotation.count({ where: { outcome: "WON", salesOrders: { some: { status: "CLOSED" } } } }),
    db.customerQuotation.count({ where: { outcome: "LOST" } }),
    db.supplierAcknowledgement.count({ where: { reviewStatus: "PENDING" } }),
  ]);

  const [
    quotedRevenue,
    confirmedOrderValue,
    invoicedAmount,
    receivables,
    payables,
  ] = await Promise.all([
    totalsByCurrency(
      () =>
        db.customerQuotation.groupBy({
          by: ["currency"],
          where: { status: { in: ["APPROVED", "SENT"] }, outcome: null },
          _sum: { total: true },
        }) as never,
      "total",
    ),
    totalsByCurrency(
      () =>
        db.salesOrder.groupBy({
          by: ["currency"],
          where: { status: { notIn: ["CLOSED", "CANCELLED"] } },
          _sum: { total: true },
        }) as never,
      "total",
    ),
    totalsByCurrency(
      () =>
        db.customerInvoice.groupBy({
          by: ["currency"],
          where: { status: { not: "VOID" } },
          _sum: { total: true },
        }) as never,
      "total",
    ),
    receivablesByCurrency(),
    payablesByCurrency(),
  ]);

  const attention = [
    { count: needsReview, title: "enquiries need review", href: "/enquiries?status=NEEDS_REVIEW", code: "ENQUIRY_REVIEW" },
    { count: clarifications, title: "lines need missing details", href: "/enquiries?filter=clarify", code: "CLARIFICATION" },
    { count: sourcingApprovals, title: "sourcing results need approval", href: "/approvals", code: "SOURCING_APPROVAL" },
    { count: supplierRfqApprovals, title: "supplier RFQs await approval", href: "/approvals", code: "RFQ_APPROVAL" },
    { count: supplierReplies, title: "supplier quotations need verification", href: "/sourcing?tab=responses", code: "OFFER_VERIFICATION" },
    { count: quotationApprovals, title: "customer quotations await approval", href: "/approvals", code: "QUOTATION_APPROVAL" },
    { count: customerPoDiscrepancies, title: "customer PO discrepancies open", href: "/orders", code: "PO_DISCREPANCY" },
    { count: supplierPoApprovals, title: "supplier POs await approval", href: "/orders", code: "PO_APPROVAL" },
    { count: pendingSupplierReplies, title: "supplier replies await review", href: "/orders", code: "ACK_REVIEW" },
    { count: lateAcknowledgements, title: "supplier acknowledgements are late", href: "/orders", code: "ACK_LATE" },
    { count: overdueDeliveries, title: "supplier deliveries are overdue", href: "/orders", code: "DELIVERY_OVERDUE" },
    { count: receiptDiscrepancies, title: "goods receipt discrepancies open", href: "/orders", code: "RECEIPT_DISCREPANCY" },
    { count: overdueInvoices, title: "customer invoices are overdue", href: "/orders", code: "INVOICE_OVERDUE" },
    { count: outstandingInvoices, title: "invoices have an open balance", href: "/orders", code: "OUTSTANDING" },
  ].filter((entry) => entry.count > 0);

  return {
    attention,
    overview: {
      activeEnquiries,
      openSalesOrders,
      openSupplierPos,
      ordersInProcurement,
      ordersInFulfilment,
      quotationsOutstanding,
      settledDeals,
      lostDeals,
    },
    money: {
      quotedRevenue,
      confirmedOrderValue,
      invoicedAmount,
      receivables,
      payables,
    },
  };
}

async function receivablesByCurrency(): Promise<CurrencyTotals[]> {
  const invoices = await db.customerInvoice.findMany({
    where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    select: { currency: true, total: true, amountPaid: true },
  });
  const byCurrency = new Map<string, ReturnType<typeof money>>();
  for (const invoice of invoices) {
    const balance = money(dec(invoice.total).minus(dec(invoice.amountPaid)));
    if (balance.lte(0)) continue;
    byCurrency.set(invoice.currency, (byCurrency.get(invoice.currency) ?? money(0)).plus(balance));
  }
  return [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: toMoneyString(amount) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

async function payablesByCurrency(): Promise<CurrencyTotals[]> {
  const bills = await db.supplierBill.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_PAID", "DISPUTED"] } },
    select: { currency: true, total: true, paidAmount: true },
  });
  const byCurrency = new Map<string, ReturnType<typeof money>>();
  for (const bill of bills) {
    const balance = money(dec(bill.total).minus(dec(bill.paidAmount)));
    if (balance.lte(0)) continue;
    byCurrency.set(bill.currency, (byCurrency.get(bill.currency) ?? money(0)).plus(balance));
  }
  return [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: toMoneyString(amount) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Order list rows for the /orders screen. */
export async function salesOrderList() {
  const orders = await db.salesOrder.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      lines: { select: { quantity: true, description: true } },
      purchaseOrders: { select: { id: true, status: true } },
      invoices: { select: { id: true, status: true, total: true, amountPaid: true, currency: true } },
      deliveries: { select: { id: true, status: true } },
      _count: { select: { discrepancies: { where: { status: "OPEN" } } } },
    },
  });
  return orders.map((order) => ({
    ...order,
    totalQty: Number(sum(order.lines.map((line) => dec(line.quantity))).toFixed(4)),
    openSupplierPos: order.purchaseOrders.filter((po) => !["RECEIVED", "COMPLETED", "CANCELLED"].includes(po.status)).length,
    overdueBalance: order.invoices
      .filter((invoice) => invoice.status !== "VOID")
      .reduce((total, invoice) => total.plus(money(dec(invoice.total).minus(dec(invoice.amountPaid)))), money(0)),
    deliveredCount: order.deliveries.filter((delivery) => delivery.status === "DELIVERED").length,
  }));
}
