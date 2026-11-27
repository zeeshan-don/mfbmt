import { db } from "../db";

export type OwnerWorkPriority = "urgent" | "high" | "normal";

export type OwnerWorkItem = {
  id: string;
  dealKey: string;
  kind: string;
  title: string;
  detail: string;
  action: string;
  href: string;
  priority: OwnerWorkPriority;
  createdAt: Date;
};

const PRIORITY_RANK: Record<OwnerWorkPriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
};

/**
 * Keep one primary action per enquiry/order. When several records in the same
 * deal need attention, show the highest-priority action first; the next one
 * becomes visible after the current blocker is resolved.
 *
 * Pure and separately tested so the owner queue can be verified without a DB.
 */
export function selectPrimaryOwnerActions(items: OwnerWorkItem[], limit = 12): OwnerWorkItem[] {
  const primaryByDeal = new Map<string, OwnerWorkItem>();

  for (const item of items) {
    const current = primaryByDeal.get(item.dealKey);
    if (!current) {
      primaryByDeal.set(item.dealKey, item);
      continue;
    }
    const rankDifference = PRIORITY_RANK[item.priority] - PRIORITY_RANK[current.priority];
    if (rankDifference > 0 || (rankDifference === 0 && item.createdAt.getTime() < current.createdAt.getTime())) {
      primaryByDeal.set(item.dealKey, item);
    }
  }

  return [...primaryByDeal.values()]
    .sort((a, b) => {
      const priorityDifference = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      return priorityDifference || a.createdAt.getTime() - b.createdAt.getTime();
    })
    .slice(0, Math.max(0, limit));
}


/**
 * Once an enquiry has exactly one active sales order, treat its remaining
 * enquiry-level work as part of that order. This prevents the owner dashboard
 * from presenting the same deal twice during the transition from quoting to
 * fulfilment. If an enquiry has multiple active orders, keep enquiry-level work
 * separate because it cannot safely be assigned to one order.
 */
export function createEnquiryDealKeyResolver(orders: Array<{ id: string; enquiryId: string | null }>) {
  const orderIdsByEnquiry = new Map<string, string[]>();
  for (const order of orders) {
    if (!order.enquiryId) continue;
    const ids = orderIdsByEnquiry.get(order.enquiryId) ?? [];
    ids.push(order.id);
    orderIdsByEnquiry.set(order.enquiryId, ids);
  }

  return (enquiryId: string | null | undefined): string => {
    if (!enquiryId) return "enquiry:unlinked";
    const orderIds = orderIdsByEnquiry.get(enquiryId) ?? [];
    return orderIds.length === 1 ? `order:${orderIds[0]}` : `enquiry:${enquiryId}`;
  };
}

function agePriority(date: Date, now: Date, overdueMs: number): OwnerWorkPriority {
  return now.getTime() - date.getTime() >= overdueMs ? "urgent" : "high";
}

/**
 * Builds the owner's operational queue directly from current tenant records.
 * This deliberately does not create a second mutable workflow/status table:
 * each action links to the module that owns the real transaction.
 */
export async function getOwnerWorkQueue(options?: { limit?: number; now?: Date }): Promise<{ items: OwnerWorkItem[]; total: number }> {
  const now = options?.now ?? new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const [enquiries, approvals, offers, acceptances, purchaseOrders, overduePurchaseOrders, acknowledgements, discrepancies, overdueInvoices, overdueBills, customerQuotes, draftCustomerQuotes, approvedCustomerQuotes, supplierQuotes, failedResearch, activeOrders] = await Promise.all([
    db.enquiry.findMany({
      where: {
        status: { notIn: ["CLOSED", "IGNORED", "REJECTED"] },
        OR: [
          { status: "NEEDS_REVIEW" },
          { status: "READY" },
          { items: { some: { reviewStatus: "NEEDS_CLARIFICATION" } } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 30,
      select: {
        id: true,
        publicRef: true,
        customerName: true,
        status: true,
        createdAt: true,
        items: { where: { reviewStatus: "NEEDS_CLARIFICATION" }, select: { id: true } },
      },
    }),
    db.approval.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 30,
      include: { enquiry: { select: { id: true, publicRef: true, customerName: true } } },
    }),
    db.supplierOffer.findMany({
      where: {
        verificationStatus: "UNVERIFIED",
        status: { in: ["QUOTE_RECEIVED", "PRICE_CONFIRMED"] },
      },
      orderBy: { updatedAt: "asc" },
      take: 30,
      include: {
        enquiryItem: { select: { id: true, description: true, enquiry: { select: { id: true, publicRef: true, customerName: true } } } },
      },
    }),
    db.customerAcceptanceReview.findMany({
      where: { status: "PENDING" },
      orderBy: { receivedAt: "asc" },
      take: 20,
      include: { quotation: { select: { id: true, quoteNumber: true, customerName: true, enquiryId: true } } },
    }),
    db.purchaseOrder.findMany({
      where: { status: { in: ["AWAITING_APPROVAL", "APPROVED"] } },
      orderBy: { createdAt: "asc" },
      take: 20,
      include: { salesOrder: { select: { id: true, orderNumber: true, customerName: true } }, supplier: { select: { name: true } } },
    }),
    db.purchaseOrder.findMany({
      where: {
        expectedDeliveryDate: { lt: now },
        // A delivery is only overdue after the supplier-facing PO has actually
        // been sent or acknowledged. Draft, awaiting-approval and approved-but-
        // unsent POs must not appear as late supplier deliveries.
        status: { in: ["SENT", "ACKNOWLEDGED", "ACKNOWLEDGEMENT_RECEIVED", "PARTIALLY_ACKNOWLEDGED", "REVISED", "PARTIALLY_RECEIVED"] },
      },
      orderBy: { expectedDeliveryDate: "asc" },
      take: 20,
      include: { salesOrder: { select: { id: true, orderNumber: true, customerName: true } }, supplier: { select: { name: true } } },
    }),
    db.supplierAcknowledgement.findMany({
      where: { reviewStatus: "PENDING" },
      orderBy: { receivedAt: "asc" },
      take: 20,
      include: { purchaseOrder: { select: { id: true, poNumber: true, salesOrder: { select: { id: true, orderNumber: true, customerName: true } }, supplier: { select: { name: true } } } } },
    }),
    db.orderDiscrepancy.findMany({
      where: { status: "OPEN", severity: { in: ["BLOCKING", "HIGH"] } },
      orderBy: { createdAt: "asc" },
      take: 20,
      include: { salesOrder: { select: { id: true, orderNumber: true, customerName: true } } },
    }),
    db.customerInvoice.findMany({
      where: { dueDate: { lt: now }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      orderBy: { dueDate: "asc" },
      take: 20,
      include: { salesOrder: { select: { id: true, orderNumber: true, customerName: true } } },
    }),
    db.supplierBill.findMany({
      where: { dueDate: { lt: now }, status: { in: ["OPEN", "PARTIALLY_PAID", "DISPUTED"] } },
      orderBy: { dueDate: "asc" },
      take: 20,
      include: {
        supplier: { select: { name: true } },
        purchaseOrder: { select: { salesOrder: { select: { id: true, orderNumber: true, customerName: true } } } },
      },
    }),
    db.customerQuotation.findMany({
      where: {
        status: "SENT",
        outcome: null,
        sentAt: { lt: threeDaysAgo },
        acceptanceReviews: { none: { status: "PENDING" } },
      },
      orderBy: { sentAt: "asc" },
      take: 20,
      include: { enquiry: { select: { id: true, publicRef: true } } },
    }),
    db.customerQuotation.findMany({
      where: { status: "DRAFT" },
      orderBy: { updatedAt: "asc" },
      take: 20,
      include: { enquiry: { select: { id: true, publicRef: true } } },
    }),
    db.customerQuotation.findMany({
      where: { status: "APPROVED", sentAt: null },
      orderBy: { approvedAt: "asc" },
      take: 20,
      include: { enquiry: { select: { id: true, publicRef: true } } },
    }),
    db.supplierQuote.findMany({
      where: { status: "SENT", sentAt: { lt: threeDaysAgo } },
      orderBy: { sentAt: "asc" },
      take: 20,
      include: {
        supplier: { select: { name: true } },
        enquiryItem: { select: { description: true, enquiry: { select: { id: true, publicRef: true, customerName: true } } } },
      },
    }),
    db.researchRun.findMany({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: 10,
      include: { enquiry: { select: { id: true, publicRef: true, customerName: true } }, enquiryItem: { select: { id: true, description: true } } },
    }),
    db.salesOrder.findMany({
      where: { status: { notIn: ["CLOSED", "CANCELLED"] } },
      orderBy: { updatedAt: "asc" },
      take: 100,
      select: { id: true, enquiryId: true, orderNumber: true, customerName: true, status: true, updatedAt: true },
    }),
  ]);

  const dealKeyForEnquiry = createEnquiryDealKeyResolver(activeOrders);
  const items: OwnerWorkItem[] = [];
  const add = (item: OwnerWorkItem) => items.push(item);

  for (const enquiry of enquiries) {
    const customer = enquiry.customerName || "Customer not identified";
    if (enquiry.status === "NEEDS_REVIEW") {
      add({
        id: `enquiry-review:${enquiry.id}`,
        dealKey: dealKeyForEnquiry(enquiry.id),
        kind: "ENQUIRY_REVIEW",
        title: "Review the customer request",
        detail: `${customer} · ${enquiry.publicRef} · Confirm the extracted requirements before sourcing.`,
        action: "Review enquiry",
        href: `/enquiries/${enquiry.id}`,
        priority: "high",
        createdAt: enquiry.createdAt,
      });
    } else if (enquiry.items.length > 0) {
      add({
        id: `enquiry-clarification:${enquiry.id}`,
        dealKey: dealKeyForEnquiry(enquiry.id),
        kind: "CLARIFICATION",
        title: `Clarify ${enquiry.items.length} product line${enquiry.items.length === 1 ? "" : "s"}`,
        detail: `${customer} · ${enquiry.publicRef} · Missing technical details could make supplier matching unreliable.`,
        action: "Review missing details",
        href: `/enquiries/${enquiry.id}?filter=clarify`,
        priority: "high",
        createdAt: enquiry.createdAt,
      });
    } else if (enquiry.status === "READY") {
      add({
        id: `enquiry-ready:${enquiry.id}`,
        dealKey: dealKeyForEnquiry(enquiry.id),
        kind: "READY_TO_SOURCE",
        title: "Review products and start sourcing",
        detail: `${customer} · ${enquiry.publicRef} · Requirements are ready for stock and supplier checks.`,
        action: "Open enquiry",
        href: `/enquiries/${enquiry.id}`,
        priority: "normal",
        createdAt: enquiry.createdAt,
      });
    }
  }

  for (const approval of approvals) {
    // Supplier PO approvals are represented by the PO row below, where the
    // owner lands directly on the order's purchasing section.
    if (approval.type === "SUPPLIER_PO" || approval.entityType === "PurchaseOrder") continue;
    const customer = approval.enquiry?.customerName || "";
    const reference = approval.enquiry?.publicRef || "";
    const labels: Record<string, { title: string; action: string }> = {
      SOURCING: { title: "Review supplier research", action: "Review options" },
      SUPPLIER_QUOTE_SEND: { title: "Approve supplier RFQ", action: "Review RFQ" },
      CUSTOMER_QUOTATION: { title: "Approve customer quotation", action: "Review quotation" },
      PRICING_OVERRIDE: { title: "Review pricing exception", action: "Review pricing" },
      SUPPLIER_PO: { title: "Approve supplier purchase order", action: "Review purchase order" },
    };
    const label = labels[approval.type] ?? { title: "Review pending approval", action: "Review approval" };
    const isOrderApproval = approval.type === "SUPPLIER_PO" || approval.entityType === "PurchaseOrder";
    add({
      id: `approval:${approval.id}`,
      dealKey: approval.enquiryId ? dealKeyForEnquiry(approval.enquiryId) : `approval:${approval.id}`,
      kind: approval.type,
      title: label.title,
      detail: [customer, reference, approval.reason].filter(Boolean).join(" · ") || "A decision is waiting for you.",
      action: label.action,
      href: isOrderApproval ? "/orders" : `/approvals/${approval.id}`,
      priority: "high",
      createdAt: approval.createdAt,
    });
  }

  for (const offer of offers) {
    const enquiry = offer.enquiryItem.enquiry;
    add({
      id: `offer-verification:${offer.id}`,
      dealKey: dealKeyForEnquiry(enquiry.id),
      kind: "OFFER_VERIFICATION",
      title: "Verify a supplier quotation",
      detail: `${offer.supplierName} · ${offer.enquiryItem.description} · ${enquiry.publicRef}`,
      action: "Review supplier reply",
      href: "/suppliers/replies",
      priority: "high",
      createdAt: offer.updatedAt,
    });
  }

  for (const review of acceptances) {
    add({
      id: `customer-acceptance:${review.id}`,
      dealKey: dealKeyForEnquiry(review.quotation.enquiryId),
      kind: "CUSTOMER_ACCEPTANCE",
      title: "Review customer acceptance or PO",
      detail: `${review.quotation.customerName} · ${review.quotation.quoteNumber} v${review.quotationVersion} · Received ${review.receivedAt.toLocaleDateString("en-GB")}.`,
      action: "Compare with quotation",
      href: `/orders/acceptance/${review.id}`,
      priority: "urgent",
      createdAt: review.receivedAt,
    });
  }

  for (const po of purchaseOrders) {
    const awaitingApproval = po.status === "AWAITING_APPROVAL";
    add({
      id: `po-next:${po.id}`,
      dealKey: `order:${po.salesOrder.id}`,
      kind: awaitingApproval ? "PURCHASE_ORDER_APPROVAL" : "PURCHASE_ORDER_SEND",
      title: awaitingApproval ? "Approve supplier purchase order" : "Send approved supplier purchase order",
      detail: `${po.supplier.name} · ${po.poNumber} · ${po.salesOrder.customerName} · ${po.salesOrder.orderNumber}`,
      action: awaitingApproval ? "Review purchase order" : "Send approved PO",
      href: `/orders/${po.salesOrder.id}`,
      priority: "high",
      createdAt: po.createdAt,
    });
  }

  for (const po of overduePurchaseOrders) {
    add({
      id: `po-overdue:${po.id}`,
      dealKey: `order:${po.salesOrder.id}`,
      kind: "SUPPLIER_DELIVERY_OVERDUE",
      title: "Check an overdue supplier delivery",
      detail: `${po.supplier.name} · ${po.poNumber} · ${po.salesOrder.customerName} · ${po.salesOrder.orderNumber} · Expected ${po.expectedDeliveryDate?.toLocaleDateString("en-GB") ?? "date unavailable"}.`,
      action: "Review procurement",
      href: `/orders/${po.salesOrder.id}`,
      priority: "urgent",
      createdAt: po.expectedDeliveryDate ?? po.createdAt,
    });
  }

  for (const acknowledgement of acknowledgements) {
    const order = acknowledgement.purchaseOrder.salesOrder;
    add({
      id: `supplier-ack:${acknowledgement.id}`,
      dealKey: `order:${order.id}`,
      kind: "SUPPLIER_ACKNOWLEDGEMENT",
      title: "Review supplier's confirmation",
      detail: `${acknowledgement.purchaseOrder.supplier.name} · ${acknowledgement.purchaseOrder.poNumber} · ${order.customerName} · ${order.orderNumber}`,
      action: "Review supplier response",
      href: `/orders/${order.id}`,
      priority: "high",
      createdAt: acknowledgement.receivedAt,
    });
  }

  for (const discrepancy of discrepancies) {
    const order = discrepancy.salesOrder;
    add({
      id: `discrepancy:${discrepancy.id}`,
      dealKey: order ? `order:${order.id}` : `discrepancy:${discrepancy.id}`,
      kind: "ORDER_DISCREPANCY",
      title: "Resolve an order discrepancy",
      detail: `${order ? `${order.customerName} · ${order.orderNumber} · ` : ""}${discrepancy.code.replaceAll("_", " ")}${discrepancy.note ? ` · ${discrepancy.note}` : ""}`,
      action: "Resolve issue",
      href: order ? `/orders/${order.id}` : "/orders",
      priority: discrepancy.severity === "BLOCKING" ? "urgent" : "high",
      createdAt: discrepancy.createdAt,
    });
  }

  for (const invoice of overdueInvoices) {
    add({
      id: `customer-invoice:${invoice.id}`,
      dealKey: `order:${invoice.salesOrder.id}`,
      kind: "CUSTOMER_INVOICE_OVERDUE",
      title: "Follow up an overdue customer invoice",
      detail: `${invoice.salesOrder.customerName} · ${invoice.invoiceNumber} · Due ${invoice.dueDate?.toLocaleDateString("en-GB") ?? "date unavailable"}.`,
      action: "Review receivable",
      href: `/orders/${invoice.salesOrder.id}`,
      priority: "urgent",
      createdAt: invoice.dueDate ?? invoice.createdAt,
    });
  }

  for (const bill of overdueBills) {
    const order = bill.purchaseOrder?.salesOrder;
    add({
      id: `supplier-bill:${bill.id}`,
      dealKey: order ? `order:${order.id}` : `supplier-bill:${bill.id}`,
      kind: "SUPPLIER_BILL_OVERDUE",
      title: "Review an overdue supplier bill",
      detail: `${bill.supplier.name} · ${bill.billNumber} · Due ${bill.dueDate?.toLocaleDateString("en-GB") ?? "date unavailable"}.`,
      action: "Review payable",
      href: order ? `/orders/${order.id}` : "/orders",
      priority: "urgent",
      createdAt: bill.dueDate ?? bill.createdAt,
    });
  }

  for (const quotation of customerQuotes) {
    add({
      id: `customer-follow-up:${quotation.id}`,
      dealKey: dealKeyForEnquiry(quotation.enquiry.id),
      kind: "CUSTOMER_FOLLOW_UP",
      title: "Follow up with the customer",
      detail: `${quotation.customerName} · ${quotation.quoteNumber} · Sent ${quotation.sentAt?.toLocaleDateString("en-GB") ?? "date unavailable"}; no response recorded.`,
      action: "Open quotation",
      href: `/quotations/${quotation.id}`,
      priority: agePriority(quotation.sentAt ?? quotation.updatedAt, now, 7 * 24 * 60 * 60 * 1000),
      createdAt: quotation.sentAt ?? quotation.createdAt,
    });
  }

  for (const quotation of draftCustomerQuotes) {
    add({
      id: `customer-quote-draft:${quotation.id}`,
      dealKey: dealKeyForEnquiry(quotation.enquiry.id),
      kind: "CUSTOMER_QUOTATION_DRAFT",
      title: "Finish the customer quotation",
      detail: `${quotation.customerName} · ${quotation.quoteNumber} v${quotation.version} · Draft saved and awaiting preparation/review.`,
      action: "Open quotation draft",
      href: `/quotations/${quotation.id}`,
      priority: "normal",
      createdAt: quotation.updatedAt,
    });
  }

  for (const quotation of approvedCustomerQuotes) {
    add({
      id: `customer-quote-send:${quotation.id}`,
      dealKey: dealKeyForEnquiry(quotation.enquiry.id),
      kind: "CUSTOMER_QUOTATION_SEND",
      title: "Send the approved customer quotation",
      detail: `${quotation.customerName} · ${quotation.quoteNumber} v${quotation.version} · Approved and waiting to be sent.`,
      action: "Review and send quote",
      href: `/quotations/${quotation.id}`,
      priority: "high",
      createdAt: quotation.approvedAt ?? quotation.updatedAt,
    });
  }

  for (const quote of supplierQuotes) {
    const enquiry = quote.enquiryItem?.enquiry;
    add({
      id: `supplier-follow-up:${quote.id}`,
      dealKey: enquiry ? dealKeyForEnquiry(enquiry.id) : `supplier-quote:${quote.id}`,
      kind: "SUPPLIER_FOLLOW_UP",
      title: "Check a pending supplier response",
      detail: `${quote.supplier.name} · ${quote.enquiryItem?.description ?? "RFQ"}${enquiry ? ` · ${enquiry.publicRef}` : ""} · Sent ${quote.sentAt?.toLocaleDateString("en-GB") ?? "date unavailable"}.`,
      action: "Review supplier request",
      href: "/sourcing?tab=responses",
      priority: "high",
      createdAt: quote.sentAt ?? quote.createdAt,
    });
  }

  for (const run of failedResearch) {
    if (!run.enquiryItem) continue;
    add({
      id: `research-failed:${run.id}`,
      dealKey: dealKeyForEnquiry(run.enquiry.id),
      kind: "RESEARCH_FAILED",
      title: "Supplier research needs attention",
      detail: `${run.enquiry.customerName || run.enquiry.publicRef} · ${run.enquiryItem.description} · ${run.error || "Research did not complete."}`,
      action: "Review sourcing",
      href: `/sourcing/${run.enquiryItem.id}`,
      priority: "high",
      createdAt: run.updatedAt,
    });
  }

  for (const order of activeOrders) {
    const statusAction: Record<string, { title: string; detail: string; action: string; priority: OwnerWorkPriority }> = {
      ORDER_CONFIRMED: { title: "Check the procurement plan", detail: "Confirm that stock allocations and supplier commitments cover this order.", action: "Open order", priority: "normal" },
      PROCUREMENT_IN_PROGRESS: { title: "Check procurement progress", detail: "Review supplier commitments and quantities still to receive.", action: "Review procurement", priority: "normal" },
      PARTIALLY_RECEIVED: { title: "Complete goods receiving", detail: "Some order quantities have arrived; review remaining receipts and inspection.", action: "Review goods receipt", priority: "high" },
      READY_TO_DISPATCH: { title: "Prepare the customer delivery", detail: "Accepted stock is available for dispatch against this order.", action: "Prepare dispatch", priority: "high" },
      PARTIALLY_DELIVERED: { title: "Complete the remaining delivery", detail: "The customer has received part of the order; review the undelivered quantities.", action: "Review delivery", priority: "high" },
      DELIVERED: { title: "Prepare the customer invoice", detail: "Delivery is recorded; review the invoiceable amount and issue the customer invoice.", action: "Review invoicing", priority: "high" },
      PARTIALLY_INVOICED: { title: "Complete customer invoicing", detail: "Some delivered value remains uninvoiced.", action: "Review invoices", priority: "high" },
      SETTLED: { title: "Review the order for closure", detail: "Customer invoices are settled; check the remaining closure conditions.", action: "Review closure", priority: "normal" },
    };
    const next = statusAction[order.status];
    if (!next) continue;
    add({
      id: `order-next:${order.id}`,
      dealKey: `order:${order.id}`,
      kind: `ORDER_${order.status}`,
      title: next.title,
      detail: `${order.customerName} · ${order.orderNumber} · ${next.detail}`,
      action: next.action,
      href: `/orders/${order.id}`,
      priority: next.priority,
      createdAt: order.updatedAt,
    });
  }

  const uniqueDealCount = new Set(items.map((item) => item.dealKey)).size;
  return {
    items: selectPrimaryOwnerActions(items, options?.limit ?? 12),
    total: uniqueDealCount,
  };
}
