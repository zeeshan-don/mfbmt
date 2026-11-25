import { db } from "../db";
import { getSettingJson, setSettingJson } from "../settings";
import { notifyOwner } from "../audit";
import { dec, money, toMoneyString } from "./money";

/**
 * Order lifecycle reminders.
 *
 * These run inside the existing durable OPS_CHECK job. They only create in-app
 * owner notifications: no customer or supplier message is transmitted here.
 * Supplier messages remain behind the existing approval and guarded-send path.
 *
 * Each reminder is recorded once per entity per day so a ten-minute scheduler
 * cannot produce a stream of duplicates.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function oncePerDay(key: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const last = await getSettingJson<string>(key, "");
  if (last === today) return false;
  await setSettingJson(key, today);
  return true;
}

export async function runOrderReminderCheck(now = new Date()): Promise<{ notified: number }> {
  const ackDays = await getSettingJson<number>("orders.ackReminderDays", 3);
  const ackCutoff = new Date(now.getTime() - Math.max(1, ackDays) * DAY_MS);
  let notified = 0;

  const awaitingAcknowledgement = await db.purchaseOrder.findMany({
    where: {
      status: "SENT",
      sentAt: { lte: ackCutoff },
      acknowledgements: { none: {} },
    },
    orderBy: { sentAt: "asc" },
    take: 10,
    select: {
      id: true,
      poNumber: true,
      sentAt: true,
      supplier: { select: { name: true } },
      salesOrder: { select: { id: true, orderNumber: true } },
    },
  });
  for (const po of awaitingAcknowledgement) {
    if (!(await oncePerDay(`orders.reminder:ack:${po.id}`))) continue;
    await notifyOwner({
      type: "ORDER_ACK_OVERDUE",
      title: `Supplier acknowledgement is late for ${po.poNumber}`,
      body: `${po.supplier.name} has not acknowledged the purchase order sent on ${po.sentAt?.toISOString().slice(0, 10) ?? "record"}. Nothing has been re-sent automatically.`,
      link: `/orders/${po.salesOrder.id}`,
    });
    notified += 1;
  }

  const overdueDeliveries = await db.purchaseOrder.findMany({
    where: {
      expectedDeliveryDate: { lt: now },
      status: { notIn: ["RECEIVED", "COMPLETED", "CANCELLED"] },
    },
    orderBy: { expectedDeliveryDate: "asc" },
    take: 10,
    select: {
      id: true,
      poNumber: true,
      expectedDeliveryDate: true,
      supplier: { select: { name: true } },
      salesOrder: { select: { id: true, orderNumber: true } },
    },
  });
  for (const po of overdueDeliveries) {
    if (!(await oncePerDay(`orders.reminder:delivery:${po.id}`))) continue;
    await notifyOwner({
      type: "ORDER_DELIVERY_OVERDUE",
      title: `Supplier delivery is overdue for ${po.poNumber}`,
      body: `${po.supplier.name} was expected to deliver on ${po.expectedDeliveryDate?.toISOString().slice(0, 10) ?? "the agreed date"}. The order is not marked received.`,
      link: `/orders/${po.salesOrder.id}`,
    });
    notified += 1;
  }

  const overdueInvoices = await db.customerInvoice.findMany({
    where: { dueDate: { lt: now }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    orderBy: { dueDate: "asc" },
    take: 10,
    select: {
      id: true,
      invoiceNumber: true,
      currency: true,
      total: true,
      amountPaid: true,
      dueDate: true,
      salesOrder: { select: { id: true } },
      customer: { select: { name: true } },
    },
  });
  for (const invoice of overdueInvoices) {
    if (!(await oncePerDay(`orders.reminder:invoice:${invoice.id}`))) continue;
    const balance = money(dec(invoice.total).minus(dec(invoice.amountPaid)));
    await notifyOwner({
      type: "ORDER_INVOICE_OVERDUE",
      title: `Invoice ${invoice.invoiceNumber} is overdue`,
      body: `${invoice.customer?.name ?? "The customer"} owes ${invoice.currency} ${toMoneyString(balance)}. No payment reminder was sent to the customer automatically.`,
      link: `/orders/${invoice.salesOrder.id}`,
    });
    notified += 1;
  }

  const openReceiptIssues = await db.orderDiscrepancy.findMany({
    where: { entityType: "GoodsReceipt", status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true, code: true, note: true, salesOrderId: true },
  });
  for (const issue of openReceiptIssues) {
    if (!(await oncePerDay(`orders.reminder:receipt:${issue.id}`))) continue;
    await notifyOwner({
      type: "ORDER_RECEIPT_DISCREPANCY",
      title: `Goods receipt issue remains open (${issue.code.replaceAll("_", " ").toLowerCase()})`,
      body: issue.note ?? "A receipt discrepancy has not been resolved. The affected quantity was not added to usable stock.",
      link: issue.salesOrderId ? `/orders/${issue.salesOrderId}` : "/orders",
    });
    notified += 1;
  }

  return { notified };
}
