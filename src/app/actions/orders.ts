"use server";

import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { revalidateOrgPath } from "@/lib/revalidate";
import { createSalesOrderFromAcceptance, type AcceptanceLineInput } from "@/lib/orders/salesOrder";
import {
  approveSupplierPurchaseOrder,
  createSupplierPurchaseOrders,
  recordSupplierAcknowledgement,
  reviewSupplierAcknowledgement,
  sendSupplierPurchaseOrder,
} from "@/lib/orders/purchaseOrders";
import { recordGoodsReceipt } from "@/lib/orders/receipts";
import { recordDelivery, recordProofOfDelivery } from "@/lib/orders/delivery";
import { issueCustomerInvoice } from "@/lib/orders/invoicing";
import {
  recordCustomerPayment,
  recordSupplierBill,
  recordSupplierPayment,
  reverseCustomerPayment,
} from "@/lib/orders/payments";
import { closeSalesOrder, resolveOrderDiscrepancy } from "@/lib/orders/closure";
import {
  convertAcceptanceReview,
  dismissAcceptanceReview,
  rejectAcceptanceReview,
} from "@/lib/orders/customerAcceptance";

/**
 * Server actions for the commercial lifecycle.
 *
 * Every financial or purchasing decision is owner-only. The forms carry ids,
 * never tenant ids, and each service re-reads and re-validates the record under
 * the signed-in tenant before writing.
 */

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function numberOrNull(formData: FormData, name: string): number | null {
  const raw = text(formData, name).replace(/,/g, "");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function requireOwnerOrLogin() {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  return user;
}

function back(path: string, message: string, extra?: Record<string, string>): never {
  const params = new URLSearchParams({ error: message, ...extra });
  redirect(`${path}?${params.toString()}`);
}

export async function createSalesOrderAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const quotationId = text(formData, "quotationId");
  if (!quotationId) back("/orders", "Choose an approved quotation.");

  const linesByItem = new Map<string, AcceptanceLineInput>();
  for (const [key, raw] of formData.entries()) {
    const match = /^item_(.+)_(qty|price|spec)$/.exec(key);
    if (!match) continue;
    const [, itemId, field] = match;
    const value = String(raw).trim();
    if (!value) continue;
    const line = linesByItem.get(itemId) ?? { quotationItemId: itemId };
    if (field === "qty") line.quantity = value;
    if (field === "price") line.unitPrice = value;
    if (field === "spec") line.specs = value;
    linesByItem.set(itemId, line);
  }

  const decisionRaw = text(formData, "decision");
  const decision =
    decisionRaw === "ACCEPT_ORIGINAL" || decisionRaw === "APPROVE_REVISED" || decisionRaw === "REJECT" ? decisionRaw : null;

  const result = await createSalesOrderFromAcceptance({
    quotationId,
    customerPoNumber: text(formData, "customerPoNumber") || null,
    customerPoReference: text(formData, "customerPoReference") || null,
    currency: text(formData, "currency") || null,
    paymentTerms: text(formData, "paymentTerms") || null,
    deliveryTerms: text(formData, "deliveryTerms") || null,
    deliveryAddress: text(formData, "deliveryAddress") || null,
    deliveryDate: text(formData, "deliveryDate") || null,
    conditions: text(formData, "conditions") || null,
    notes: text(formData, "notes") || null,
    lines: [...linesByItem.values()],
    source: "CUSTOMER_PO",
    evidence: { recordedFrom: "orders screen", enteredBy: user.name },
    resolution: decision ? { decision, reason: text(formData, "reason") || null } : null,
    userId: user.id,
    actorLabel: user.name,
  });

  revalidateOrgPath(user.organizationId, "/orders");
  if (!result.ok) {
    back(
      "/orders",
      result.error,
      result.discrepancies ? { discrepancies: JSON.stringify(result.discrepancies) } : undefined,
    );
  }
  revalidateOrgPath(user.organizationId, `/orders/${result.salesOrderId}`);
  redirect(
    `/orders/${result.salesOrderId}?saved=${encodeURIComponent(
      result.duplicate ? "This acceptance was already converted; the existing sales order is shown." : `Sales order ${result.orderNumber} created.`,
    )}`,
  );
}

export async function convertAcceptanceReviewAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const reviewId = text(formData, "reviewId");
  if (!reviewId) back("/orders", "Choose a customer acceptance to review.");
  const decisionRaw = text(formData, "decision");
  const decision =
    decisionRaw === "APPROVE_REVISED" ? "APPROVE_REVISED" : "ACCEPT_ORIGINAL";
  const result = await convertAcceptanceReview({
    reviewId,
    decision,
    reason: text(formData, "reason") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/orders");
  revalidateOrgPath(user.organizationId, `/orders/acceptance/${reviewId}`);
  if (!result.ok) {
    back(
      `/orders/acceptance/${reviewId}`,
      result.error,
      result.blocking ? { blocking: JSON.stringify(result.blocking) } : undefined,
    );
  }
  revalidateOrgPath(user.organizationId, `/orders/${result.salesOrderId}`);
  redirect(
    `/orders/${result.salesOrderId}?saved=${encodeURIComponent(
      result.duplicate
        ? "This acceptance was already converted; the existing sales order is shown."
        : `Sales order ${result.orderNumber} created from the reviewed customer document.`,
    )}`,
  );
}

export async function rejectAcceptanceReviewAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const reviewId = text(formData, "reviewId");
  if (!reviewId) back("/orders", "Choose a customer acceptance to review.");
  const result = await rejectAcceptanceReview({
    reviewId,
    reason: text(formData, "reason"),
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/orders");
  revalidateOrgPath(user.organizationId, `/orders/acceptance/${reviewId}`);
  if (!result.ok) back(`/orders/acceptance/${reviewId}`, result.error);
  redirect(`/orders/acceptance/${reviewId}?saved=${encodeURIComponent("Customer document rejected; no sales order was created.")}`);
}

export async function dismissAcceptanceReviewAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const reviewId = text(formData, "reviewId");
  if (!reviewId) back("/orders", "Choose a customer acceptance to review.");
  const result = await dismissAcceptanceReview({
    reviewId,
    reason: text(formData, "reason") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/orders");
  revalidateOrgPath(user.organizationId, `/orders/acceptance/${reviewId}`);
  if (!result.ok) back(`/orders/acceptance/${reviewId}`, result.error);
  redirect(`/orders/acceptance/${reviewId}?saved=${encodeURIComponent("Acceptance review dismissed.")}`);
}

export async function createProcurementAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const salesOrderLineId = text(formData, "salesOrderLineId");
  const supplierOfferId = text(formData, "supplierOfferId");
  const quantity = numberOrNull(formData, "quantity");
  const price = numberOrNull(formData, "unitPrice");
  if (!salesOrderId || !salesOrderLineId || !supplierOfferId) {
    back(`/orders/${salesOrderId}`, "Choose an order line and a verified supplier offer.");
  }

  const result = await createSupplierPurchaseOrders({
    salesOrderId,
    selections: [
      {
        salesOrderLineId,
        supplierOfferId,
        quantity,
        unitPrice: price,
        reason: text(formData, "reason") || null,
      },
    ],
    internalNotes: text(formData, "internalNotes") || null,
    supplierNotes: text(formData, "supplierNotes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  const po = result.purchaseOrders[0];
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      po ? `${po.poNumber} created for ${po.supplierName}; it needs your approval.` : "Purchase order already existed.",
    )}`,
  );
}

export async function approvePurchaseOrderAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const purchaseOrderId = text(formData, "purchaseOrderId");
  const salesOrderId = text(formData, "salesOrderId");
  const result = await approveSupplierPurchaseOrder({
    purchaseOrderId,
    userId: user.id,
    actorLabel: user.name,
    reason: text(formData, "reason") || null,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent("Purchase order approved. It has not been sent yet.")}`);
}

export async function sendPurchaseOrderAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const purchaseOrderId = text(formData, "purchaseOrderId");
  const salesOrderId = text(formData, "salesOrderId");
  const result = await sendSupplierPurchaseOrder({
    purchaseOrderId,
    userId: user.id,
    actorLabel: user.name,
    to: text(formData, "to") || null,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent(result.detail)}`);
}

export async function recordAcknowledgementAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const purchaseOrderId = text(formData, "purchaseOrderId");
  const outcome = text(formData, "outcome");
  if (!["ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REJECTED", "REVISED"].includes(outcome)) {
    back(`/orders/${salesOrderId}`, "Choose what the supplier said.");
  }
  const result = await recordSupplierAcknowledgement({
    purchaseOrderId,
    outcome: outcome as "ACKNOWLEDGED" | "PARTIALLY_ACKNOWLEDGED" | "REJECTED" | "REVISED",
    promisedDate: text(formData, "promisedDate") || null,
    notes: text(formData, "notes") || null,
    source: "MANUAL",
    evidence: { recordedByOwner: user.name },
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      `Supplier reply recorded (${result.deviations.length} difference(s)). Review it before the terms change.`,
    )}`,
  );
}

export async function reviewAcknowledgementAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const acknowledgementId = text(formData, "acknowledgementId");
  const decision = text(formData, "decision") === "DISMISS" ? "DISMISS" : "APPROVE";
  const result = await reviewSupplierAcknowledgement({
    acknowledgementId,
    decision,
    note: text(formData, "note") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      decision === "DISMISS" ? "Supplier reply dismissed." : `Supplier reply approved (${result.purchaseOrderStatus}).`,
    )}`,
  );
}

export async function recordReceiptAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const purchaseOrderId = text(formData, "purchaseOrderId");
  const lines: Array<{
    purchaseOrderLineId: string;
    quantityReceived: string;
    quantityAccepted: string | null;
    condition: string;
  }> = [];

  for (const [key, raw] of formData.entries()) {
    const match = /^received_(.+)$/.exec(key);
    if (!match) continue;
    const lineId = match[1];
    const received = String(raw).trim();
    if (!received) continue;
    lines.push({
      purchaseOrderLineId: lineId,
      quantityReceived: received,
      quantityAccepted: text(formData, `accepted_${lineId}`) || null,
      condition: text(formData, `condition_${lineId}`) || "OK",
    });
  }
  if (lines.length === 0) back(`/orders/${salesOrderId}`, "Enter the received quantity on at least one line.");

  const result = await recordGoodsReceipt({
    purchaseOrderId,
    lines,
    receivedAt: text(formData, "receivedAt") || null,
    deliveryNoteRef: text(formData, "deliveryNoteRef") || null,
    inspectionResult: text(formData, "inspectionResult") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      result.duplicate
        ? `Receipt ${result.receiptNumber} was already posted; stock was not counted twice.`
        : `Goods receipt ${result.receiptNumber} posted with ${result.discrepancies.length} discrepancy record(s).`,
    )}`,
  );
}

export async function recordDeliveryAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const lines: Array<{ salesOrderLineId: string; quantity: string }> = [];
  for (const [key, raw] of formData.entries()) {
    const match = /^deliver_(.+)$/.exec(key);
    if (!match) continue;
    const quantity = String(raw).trim();
    if (!quantity) continue;
    lines.push({ salesOrderLineId: match[1], quantity });
  }
  if (lines.length === 0) back(`/orders/${salesOrderId}`, "Enter the dispatched quantity on at least one line.");

  const result = await recordDelivery({
    salesOrderId,
    lines,
    dispatchedAt: text(formData, "dispatchedAt") || null,
    carrier: text(formData, "carrier") || null,
    vehicleRef: text(formData, "vehicleRef") || null,
    trackingRef: text(formData, "trackingRef") || null,
    deliveryAddress: text(formData, "deliveryAddress") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent(`Dispatch ${result.deliveryNumber} recorded.`)}`);
}

export async function recordProofOfDeliveryAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await recordProofOfDelivery({
    deliveryId: text(formData, "deliveryId"),
    deliveredAt: text(formData, "deliveredAt") || null,
    receivedBy: text(formData, "receivedBy") || null,
    proofPath: text(formData, "proofPath") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent("Proof of delivery recorded.")}`);
}

export async function issueInvoiceAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const lines: Array<{ salesOrderLineId: string; quantity: string }> = [];
  for (const [key, raw] of formData.entries()) {
    const match = /^invoice_(.+)$/.exec(key);
    if (!match) continue;
    const quantity = String(raw).trim();
    if (!quantity) continue;
    lines.push({ salesOrderLineId: match[1], quantity });
  }
  const result = await issueCustomerInvoice({
    salesOrderId,
    lines: lines.length > 0 ? lines : null,
    invoiceDate: text(formData, "invoiceDate") || null,
    dueDate: text(formData, "dueDate") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      result.duplicate ? `Invoice ${result.invoiceNumber} already exists.` : `Invoice ${result.invoiceNumber} issued (${result.total}).`,
    )}`,
  );
}

export async function recordPaymentAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const invoiceId = text(formData, "invoiceId");
  const amount = numberOrNull(formData, "amount");
  if (!amount) back(`/orders/${salesOrderId}`, "Enter the amount received.");

  const result = await recordCustomerPayment({
    invoiceId: invoiceId || null,
    amount,
    currency: text(formData, "currency") || null,
    receivedAt: text(formData, "receivedAt") || null,
    method: text(formData, "method") || null,
    reference: text(formData, "reference") || null,
    proofPath: text(formData, "proofPath") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      `Receipt ${result.paymentNumber} recorded; unallocated ${result.unallocated}.`,
    )}`,
  );
}

export async function reversePaymentAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await reverseCustomerPayment({
    paymentId: text(formData, "paymentId"),
    reason: text(formData, "reason"),
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent("Customer payment reversed; the audit trail is intact.")}`);
}

export async function recordSupplierBillAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await recordSupplierBill({
    supplierId: text(formData, "supplierId"),
    purchaseOrderId: text(formData, "purchaseOrderId") || null,
    amount: numberOrNull(formData, "amount") ?? 0,
    taxAmount: numberOrNull(formData, "taxAmount"),
    currency: text(formData, "currency") || null,
    supplierInvoiceRef: text(formData, "supplierInvoiceRef") || null,
    dueDate: text(formData, "dueDate") || null,
    paymentTerms: text(formData, "paymentTerms") || null,
    notes: text(formData, "notes") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent(`Supplier bill ${result.billNumber} recorded.`)}`);
}

export async function recordSupplierPaymentAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await recordSupplierPayment({
    supplierBillId: text(formData, "supplierBillId"),
    amount: numberOrNull(formData, "amount") ?? 0,
    paidAt: text(formData, "paidAt") || null,
    method: text(formData, "method") || null,
    reference: text(formData, "reference") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent(`Supplier payment ${result.paymentNumber} recorded.`)}`);
}

export async function resolveDiscrepancyAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await resolveOrderDiscrepancy({
    discrepancyId: text(formData, "discrepancyId"),
    note: text(formData, "resolutionNote"),
    decision: text(formData, "decision") === "WAIVED" ? "WAIVED" : "RESOLVED",
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  if (!result.ok) back(`/orders/${salesOrderId}`, result.error);
  redirect(`/orders/${salesOrderId}?saved=${encodeURIComponent("Discrepancy resolved and recorded.")}`);
}

export async function closeSalesOrderAction(formData: FormData) {
  const user = await requireOwnerOrLogin();
  const salesOrderId = text(formData, "salesOrderId");
  const result = await closeSalesOrder({
    salesOrderId,
    userId: user.id,
    actorLabel: user.name,
    role: user.role,
    overrideReason: text(formData, "overrideReason") || null,
    note: text(formData, "note") || null,
  });
  revalidateOrgPath(user.organizationId, `/orders/${salesOrderId}`);
  revalidateOrgPath(user.organizationId, "/orders");
  if (!result.ok) {
    back(
      `/orders/${salesOrderId}`,
      result.error,
      result.blockingReasons ? { blocking: JSON.stringify(result.blockingReasons) } : undefined,
    );
  }
  redirect(
    `/orders/${salesOrderId}?saved=${encodeURIComponent(
      result.overridden ? "Deal closed with a recorded owner override." : "Deal closed; all configured obligations were satisfied.",
    )}`,
  );
}
