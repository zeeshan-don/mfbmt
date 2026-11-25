import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import { authorizeOwner } from "../src/lib/auth";
import {
  compareAcceptanceToQuotation,
  createSalesOrderFromAcceptance,
  previewCustomerAcceptance,
} from "../src/lib/orders/salesOrder";
import {
  approveSupplierPurchaseOrder,
  createSupplierPurchaseOrders,
  procurementPlan,
  recordSupplierAcknowledgement,
  reviewSupplierAcknowledgement,
  sendSupplierPurchaseOrder,
} from "../src/lib/orders/purchaseOrders";
import { recordGoodsReceipt, stockOnHand } from "../src/lib/orders/receipts";
import { recordDelivery, recordProofOfDelivery } from "../src/lib/orders/delivery";
import { issueCustomerInvoice } from "../src/lib/orders/invoicing";
import {
  recordCustomerPayment,
  recordSupplierBill,
  recordSupplierPayment,
  reverseCustomerPayment,
} from "../src/lib/orders/payments";
import { closeSalesOrder, dealClosureSummary, resolveOrderDiscrepancy } from "../src/lib/orders/closure";
import { orderMetrics } from "../src/lib/orders/metrics";
import { runOrderReminderCheck } from "../src/lib/orders/reminders";

// The only mocked external boundary: no email leaves the machine. The outbound
// ledger, guard, PO versioning and audit trail are the real implementations.
vi.mock("../src/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, simulated: true })),
}));

async function clean() {
  await db.paymentAllocation.deleteMany();
  await db.customerPayment.deleteMany();
  await db.supplierPayment.deleteMany();
  await db.customerInvoiceLine.deleteMany();
  await db.customerInvoice.deleteMany();
  await db.supplierBill.deleteMany();
  await db.deliveryLine.deleteMany();
  await db.delivery.deleteMany();
  await db.goodsReceiptLine.deleteMany();
  await db.goodsReceipt.deleteMany();
  await db.supplierAcknowledgement.deleteMany();
  await db.purchaseOrderLine.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.salesOrderLine.deleteMany();
  await db.salesOrder.deleteMany();
  await db.orderStatusEvent.deleteMany();
  await db.orderDiscrepancy.deleteMany();
  await db.stockReservation.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.supplier.deleteMany();
  await db.customer.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.inventoryStock.deleteMany();
  await db.inventoryLocation.deleteMany();
  await db.product.deleteMany();
  await db.approval.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.appSetting.deleteMany();
  await db.user.deleteMany();
  await db.organization.update({ where: { id: "org_mfbmt" }, data: { taxEnabled: false, taxRatePct: 0 } });
}

beforeEach(clean);
afterAll(clean);

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { email: `owner-${suffix}@example.com`, name: "Owner Test", passwordHash: "not-used", role: "OWNER" },
  });
  const staff = await db.user.create({
    data: { email: `staff-${suffix}@example.com`, name: "Staff Test", passwordHash: "not-used", role: "STAFF" },
  });
  const customer = await db.customer.create({
    data: { name: `Gulf Projects ${suffix}`, email: `buyer-${suffix}@example.com` },
  });
  const enquiry = await db.enquiry.create({
    data: {
      publicRef: `ENQ-${suffix}`,
      channel: "MANUAL",
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      rawText: "10 hex bolts M12x60 and 5 gate valves 2 inch SS316",
      status: "QUOTED",
      currency: "AED",
    },
  });
  const itemA = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      lineNo: 1,
      description: "Hex bolt M12x60 zinc plated",
      category: "Fasteners",
      unit: "pcs",
      quantity: 10,
      quantityFromStock: 4,
      quantityToSource: 6,
      reviewStatus: "CONFIRMED",
      inventoryStatus: "PARTIAL",
    },
  });
  const itemB = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      lineNo: 2,
      description: "Gate valve 2 inch SS316 Class 150",
      category: "Valves",
      unit: "pcs",
      quantity: 5,
      quantityToSource: 5,
      reviewStatus: "CONFIRMED",
    },
  });
  const productA = await db.product.create({
    data: { sku: `HEX-${suffix}`, name: "Hex bolt M12x60", category: "Fasteners", unit: "pcs" },
  });
  await db.enquiryItem.update({ where: { id: itemA.id }, data: { matchedProductId: productA.id } });
  const location = await db.inventoryLocation.create({ data: { code: `MAIN-${suffix}`, name: "Main store" } });
  await db.inventoryStock.create({
    data: { productId: productA.id, locationId: location.id, quantityOnHand: 4, quantityReserved: 4 },
  });

  const supplierA = await db.supplier.create({
    data: { name: `Fastener Trader ${suffix}`, email: `sales-${suffix}@fastener.example`, status: "ACTIVE", identityStatus: "VERIFIED" },
  });
  const supplierB = await db.supplier.create({
    data: { name: `Valve Works ${suffix}`, email: `valves-${suffix}@valve.example`, status: "ACTIVE", identityStatus: "VERIFIED" },
  });

  const offerA = await db.supplierOffer.create({
    data: {
      enquiryItemId: itemA.id,
      supplierId: supplierA.id,
      supplierName: supplierA.name,
      productTitle: "Hex bolt M12x60 8.8 zinc",
      matchStatus: "EXACT",
      unitPrice: 3,
      currency: "AED",
      moq: 1,
      leadTimeDays: 5,
      validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "QUOTE_RECEIVED",
      verificationStatus: "VERIFIED",
      isEligible: true,
      deliveryLocation: "Dubai",
      paymentTerms: "Net 30",
    },
  });
  const offerB = await db.supplierOffer.create({
    data: {
      enquiryItemId: itemB.id,
      supplierId: supplierB.id,
      supplierName: supplierB.name,
      productTitle: "Gate valve 2 inch SS316 Class 150",
      matchStatus: "EXACT",
      unitPrice: 70,
      currency: "AED",
      moq: 1,
      leadTimeDays: 7,
      validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "QUOTE_RECEIVED",
      verificationStatus: "VERIFIED",
      isEligible: true,
      deliveryLocation: "Dubai",
      paymentTerms: "Net 30",
    },
  });

  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      customerId: customer.id,
      quoteNumber: `QT-${suffix}`,
      version: 1,
      customerName: customer.name,
      customerEmail: customer.email,
      currency: "AED",
      subtotal: 550,
      taxAmount: 0,
      total: 550,
      terms: "Net 30 days",
      validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: "APPROVED",
      approvedById: owner.id,
      approvedAt: new Date(),
      sentAt: new Date(),
      items: {
        create: [
          {
            description: "Hex bolt M12x60 zinc plated",
            specs: "M12 x 60, grade 8.8, zinc plated",
            quantity: 10,
            unit: "pcs",
            unitPrice: 5,
            lineTotal: 50,
            priceStatus: "PRICED",
            costStatus: "COMPLETE",
            stockQuantity: 4,
            procureQuantity: 6,
            enquiryItemId: itemA.id,
            supplierOfferId: offerA.id,
          },
          {
            description: "Gate valve 2 inch SS316 Class 150",
            specs: "2 inch, SS316 body, Class 150",
            quantity: 5,
            unit: "pcs",
            unitPrice: 100,
            lineTotal: 500,
            priceStatus: "PRICED",
            costStatus: "COMPLETE",
            stockQuantity: 0,
            procureQuantity: 5,
            enquiryItemId: itemB.id,
            supplierOfferId: offerB.id,
          },
        ],
      },
    },
  });

  const items = await db.customerQuotationItem.findMany({
    where: { quotationId: quotation.id },
    orderBy: { description: "asc" },
  });

  return { suffix, owner, staff, customer, enquiry, itemA, itemB, productA, location, supplierA, supplierB, offerA, offerB, quotation, items };
}

function acceptedOrder(seedValue: Seed) {
  return createSalesOrderFromAcceptance({
    quotationId: seedValue.quotation.id,
    customerPoNumber: `PO-${seedValue.suffix}`,
    source: "CUSTOMER_PO",
    evidence: { emailId: `msg-${seedValue.suffix}` },
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
}

async function raisePurchaseOrder(
  seedValue: Seed,
  orderId: string,
  selections?: Array<{ salesOrderLineId: string; supplierOfferId: string; quantity?: number }>,
) {
  const plan = await procurementPlan(orderId);
  if (!plan) throw new Error("plan missing");
  const chosen =
    selections ??
    plan.lines.map((line) => ({
      salesOrderLineId: line.salesOrderLineId,
      supplierOfferId: line.approvedOfferId as string,
      quantity: line.remainingToOrder,
    }));
  const result = await createSupplierPurchaseOrders({
    salesOrderId: orderId,
    selections: chosen,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
  if (!result.ok) throw new Error(result.error);
  return result.purchaseOrders;
}

async function sendPo(seedValue: Seed, poId: string) {
  const approved = await approveSupplierPurchaseOrder({
    purchaseOrderId: poId,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
    reason: "Checked against the verified offer",
  });
  if (!approved.ok) throw new Error(approved.error);
  const sent = await sendSupplierPurchaseOrder({
    purchaseOrderId: poId,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
  if (!sent.ok) throw new Error(sent.error);
}

/** Receives only what is still outstanding on a PO, so a replay is never excess. */
async function receiveRemaining(seedValue: Seed, poId: string, deliveryNoteRef = `DN-${randomUUID().slice(0, 6)}`) {
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: { include: { receiptLines: true } } },
  });
  if (!po) throw new Error("po missing");
  const lines = po.lines
    .map((line) => ({
      purchaseOrderLineId: line.id,
      remaining: Number(line.quantity) - line.receiptLines.reduce((total, row) => total + Number(row.quantityAccepted), 0),
    }))
    .filter((line) => line.remaining > 0.0001)
    .map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, quantityReceived: line.remaining }));
  return recordGoodsReceipt({
    purchaseOrderId: poId,
    lines,
    deliveryNoteRef,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
}

async function raiseSendReceiveAll(seedValue: Seed, orderId: string) {
  const pos = await raisePurchaseOrder(seedValue, orderId);
  for (const po of pos) await sendPo(seedValue, po.id);
  for (const po of pos) {
    const receipt = await receiveRemaining(seedValue, po.id);
    if (!receipt.ok) throw new Error(receipt.error);
  }
  return pos;
}

async function deliverAll(seedValue: Seed, orderId: string) {
  const metrics = await db.$transaction((tx) => orderMetrics(tx, orderId));
  const lines = metrics.lines
    .filter((line) => line.availableToDispatch.gt(0))
    .map((line) => ({ salesOrderLineId: line.id, quantity: line.availableToDispatch.toFixed(4) }));
  const delivery = await recordDelivery({
    salesOrderId: orderId,
    lines,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
  if (!delivery.ok) throw new Error(delivery.error);
  const pod = await recordProofOfDelivery({
    deliveryId: delivery.deliveryId,
    receivedBy: "Site storekeeper",
    proofPath: `pod-${delivery.deliveryNumber}.pdf`,
    userId: seedValue.owner.id,
    actorLabel: seedValue.owner.name,
  });
  if (!pod.ok) throw new Error(pod.error);
  return delivery;
}

async function orderLineId(orderId: string, needle: string) {
  const line = await db.salesOrderLine.findFirst({ where: { salesOrderId: orderId, description: { contains: needle } } });
  if (!line) throw new Error(`line ${needle} missing`);
  return line.id;
}

describe("customer acceptance and sales order conversion", () => {
  it("creates one sales order bound to the exact accepted quotation version", async () => {
    const fixture = await seed();
    const result = await acceptedOrder(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.salesOrder.findUnique({
      where: { id: result.salesOrderId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    expect(order?.quotationId).toBe(fixture.quotation.id);
    expect(order?.quotationVersion).toBe(1);
    expect(order?.acceptedAt).toBeInstanceOf(Date);
    expect(order?.customerPoNumber).toBe(`PO-${fixture.suffix}`);
    expect(order?.total.toFixed(2)).toBe("550.00");
    expect(order?.lines).toHaveLength(2);
    expect(order?.lines[0].stockQuantity.toFixed(4)).toBe("4.0000");
    expect(order?.lines[0].procureQuantity.toFixed(4)).toBe("6.0000");
    expect(order?.lines[0].productId).toBe(fixture.productA.id);
    expect(order?.lines[1].procureQuantity.toFixed(4)).toBe("5.0000");
    expect(order?.status).toBe("PROCUREMENT_IN_PROGRESS");

    const quotation = await db.customerQuotation.findUnique({ where: { id: fixture.quotation.id } });
    expect(quotation?.outcome).toBe("WON");
    const event = await db.orderStatusEvent.findFirst({ where: { entityType: "SalesOrder", entityId: order!.id } });
    expect(event?.actorLabel).toBe("Owner Test");
  });

  it("is idempotent when the same acceptance is processed twice", async () => {
    const fixture = await seed();
    const first = await acceptedOrder(fixture);
    expect(first.ok).toBe(true);
    const second = await acceptedOrder(fixture);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.salesOrderId).toBe(first.salesOrderId);
    expect(second.duplicate).toBe(true);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("flags a changed price and only applies it with a recorded owner decision", async () => {
    const fixture = await seed();
    const changed = fixture.items.find((item) => item.description.includes("Gate valve"))!;
    const attempted = await createSalesOrderFromAcceptance({
      quotationId: fixture.quotation.id,
      lines: [{ quotationItemId: changed.id, unitPrice: 90 }],
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(attempted.ok).toBe(false);
    if (attempted.ok) return;
    expect(attempted.code).toBe("DISCREPANCY");
    expect(attempted.discrepancies?.some((entry) => entry.code === "PRICE")).toBe(true);
    expect(await db.salesOrder.count()).toBe(0);

    const noReason = await createSalesOrderFromAcceptance({
      quotationId: fixture.quotation.id,
      lines: [{ quotationItemId: changed.id, unitPrice: 90 }],
      resolution: { decision: "APPROVE_REVISED" },
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(noReason.ok).toBe(false);

    const approved = await createSalesOrderFromAcceptance({
      quotationId: fixture.quotation.id,
      lines: [{ quotationItemId: changed.id, unitPrice: 90 }],
      resolution: { decision: "APPROVE_REVISED", reason: "Customer agreed a lower valve price after negotiation." },
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const line = await db.salesOrderLine.findFirst({
      where: { salesOrderId: approved.salesOrderId, description: changed.description },
    });
    expect(line?.unitPrice.toFixed(2)).toBe("90.00");
    const order = await db.salesOrder.findUnique({ where: { id: approved.salesOrderId } });
    // The approved revision contains only the renegotiated valve line.
    expect(order?.total.toFixed(2)).toBe("450.00");
    const discrepancy = await db.orderDiscrepancy.findFirst({ where: { salesOrderId: approved.salesOrderId, code: "PRICE" } });
    expect(discrepancy?.status).toBe("RESOLVED");
    expect(discrepancy?.resolutionNote).toMatch(/lower valve price/i);
  });

  it("rejects changed quantity and specification without an approval", async () => {
    const fixture = await seed();
    const valve = fixture.items.find((item) => item.description.includes("Gate valve"))!;
    for (const [line, code] of [
      [{ quotationItemId: valve.id, quantity: 8 }, "QUANTITY"],
      [{ quotationItemId: valve.id, specs: "2 inch, SS304 body, Class 150" }, "SPEC"],
    ] as const) {
      const result = await createSalesOrderFromAcceptance({
        quotationId: fixture.quotation.id,
        lines: [line as never],
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.discrepancies?.some((entry) => entry.code === code)).toBe(true);
    }
  });

  it("compares a document against the sent version without mutating it", async () => {
    const fixture = await seed();
    const preview = await previewCustomerAcceptance({
      quotationId: fixture.quotation.id,
      currency: "USD",
      lines: [{ quotationItemId: fixture.items[0].id, unitPrice: 1 }],
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.blocking.map((entry) => entry.code)).toEqual(expect.arrayContaining(["CURRENCY", "PRICE"]));
    const stored = await db.customerQuotation.findUnique({ where: { id: fixture.quotation.id } });
    expect(stored?.total).toBe(550);
    expect(stored?.version).toBe(1);
  });
});

describe("procurement, supplier commitments and receipts", () => {
  it("covers stock first and creates one approved-then-sent PO for multiple lines", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);

    const plan = await procurementPlan(order.salesOrderId);
    expect(plan?.lines.map((line) => line.remainingToOrder)).toEqual([6, 5]);

    const boltOnly = await createSupplierPurchaseOrders({
      salesOrderId: order.salesOrderId,
      selections: [
        {
          salesOrderLineId: plan!.lines[0].salesOrderLineId,
          supplierOfferId: plan!.lines[0].approvedOfferId as string,
        },
      ],
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(boltOnly.ok).toBe(true);
    if (!boltOnly.ok) return;
    const [po] = boltOnly.purchaseOrders;
    const stored = await db.purchaseOrder.findUnique({ where: { id: po.id }, include: { lines: true } });
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.status).toBe("AWAITING_APPROVAL");
    expect(stored?.total.toFixed(2)).toBe("18.00");
    const pendingApproval = await db.approval.findFirst({ where: { type: "SUPPLIER_PO", entityId: po.id, status: "PENDING" } });
    expect(pendingApproval).not.toBeNull();

    const notApproved = await sendSupplierPurchaseOrder({
      purchaseOrderId: po.id,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(notApproved.ok).toBe(false);

    await sendPo(fixture, po.id);
    const sent = await db.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(sent?.status).toBe("SENT");
    expect(sent?.sentDocumentJson).toBeTruthy();
    expect(sent?.sentTo).toContain("@fastener.example");
    expect((await db.approval.findFirst({ where: { type: "SUPPLIER_PO", entityId: po.id } }))?.status).toBe("APPROVED");

    const twice = await sendSupplierPurchaseOrder({
      purchaseOrderId: po.id,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(twice.ok).toBe(false);
    expect(await db.outboundMessage.count({ where: { relatedId: po.id } })).toBe(1);
  });

  it("refuses an unverified supplier offer as a purchase commitment", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    await db.supplierOffer.update({ where: { id: fixture.offerB.id }, data: { verificationStatus: "UNVERIFIED" } });
    const plan = await procurementPlan(order.salesOrderId);
    const result = await createSupplierPurchaseOrders({
      salesOrderId: order.salesOrderId,
      selections: [{ salesOrderLineId: plan!.lines[1].salesOrderLineId, supplierOfferId: fixture.offerB.id }],
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not been owner-verified/i);
    expect(await db.purchaseOrder.count()).toBe(0);
  });

  it("supports split procurement across two suppliers for one sales-order line", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const valveLine = (await procurementPlan(order.salesOrderId))!.lines[1];
    const secondSupplier = await db.supplier.create({
      data: { name: "Second Valve Co", email: "sales@second-valve.example", status: "ACTIVE", identityStatus: "VERIFIED" },
    });
    const secondOffer = await db.supplierOffer.create({
      data: {
        enquiryItemId: fixture.itemB.id,
        supplierId: secondSupplier.id,
        supplierName: "Second Valve Co",
        productTitle: "Gate valve 2 inch SS316",
        matchStatus: "EQUIVALENT",
        unitPrice: 75,
        currency: "AED",
        moq: 1,
        leadTimeDays: 9,
        validityDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        status: "QUOTE_RECEIVED",
        verificationStatus: "VERIFIED",
        isEligible: true,
      },
    });
    const result = await createSupplierPurchaseOrders({
      salesOrderId: order.salesOrderId,
      selections: [
        { salesOrderLineId: valveLine.salesOrderLineId, supplierOfferId: valveLine.approvedOfferId as string, quantity: 3 },
        { salesOrderLineId: valveLine.salesOrderLineId, supplierOfferId: secondOffer.id, quantity: 2 },
      ],
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purchaseOrders).toHaveLength(2);
    const stored = await db.purchaseOrderLine.findMany({ where: { salesOrderLineId: valveLine.salesOrderLineId } });
    expect(stored.reduce((total, line) => total + Number(line.quantity), 0)).toBe(5);
    for (const po of result.purchaseOrders) await sendPo(fixture, po.id);
    expect((await procurementPlan(order.salesOrderId))?.lines[1].remainingToOrder).toBe(0);
  });

  it("records partial acknowledgement and applies revised terms only after owner review", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const pos = await raisePurchaseOrder(fixture, order.salesOrderId);
    for (const po of pos) await sendPo(fixture, po.id);
    const boltPo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: order.salesOrderId, lines: { some: { description: { contains: "Hex bolt" } } } },
      include: { lines: true },
    });
    if (!boltPo) throw new Error("bolt PO missing");

    const ack = await recordSupplierAcknowledgement({
      purchaseOrderId: boltPo.id,
      outcome: "PARTIALLY_ACKNOWLEDGED",
      lines: [{ purchaseOrderLineId: boltPo.lines[0].id, acknowledgedQuantity: 3, revisedUnitPrice: 3.5 }],
      promisedDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      notes: "Supplier confirmed 3 bolts at a revised price.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.deviations.map((entry) => entry.code)).toEqual(expect.arrayContaining(["PARTIAL_QUANTITY", "REVISED_PRICE"]));
    expect((await db.purchaseOrder.findUnique({ where: { id: boltPo.id } }))?.status).toBe("ACKNOWLEDGEMENT_RECEIVED");
    expect((await db.purchaseOrder.findUnique({ where: { id: boltPo.id } }))?.total.toFixed(2)).toBe("18.00");

    const reviewed = await reviewSupplierAcknowledgement({
      acknowledgementId: ack.acknowledgementId,
      decision: "APPROVE",
      note: "Accepted the partial quantity.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(reviewed.ok).toBe(true);
    expect((await db.purchaseOrder.findUnique({ where: { id: boltPo.id } }))?.status).toBe("PARTIALLY_ACKNOWLEDGED");
  });

  it("posts partial receipts once, keeps rejected goods out of stock, and records discrepancies", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const pos = await raisePurchaseOrder(fixture, order.salesOrderId);
    const boltPo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: order.salesOrderId, lines: { some: { description: { contains: "Hex bolt" } } } },
      include: { lines: true },
    });
    if (!boltPo) throw new Error("bolt PO missing");
    await sendPo(fixture, boltPo.id);
    const boltLine = boltPo.lines[0];

    const partial = await recordGoodsReceipt({
      purchaseOrderId: boltPo.id,
      lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 3, quantityAccepted: 3 }],
      deliveryNoteRef: "NOTE-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(partial.ok).toBe(true);
    expect(await stockOnHand(fixture.productA.id)).toBe(7);
    expect((await db.purchaseOrder.findUnique({ where: { id: boltPo.id } }))?.status).toBe("PARTIALLY_RECEIVED");

    const duplicate = await recordGoodsReceipt({
      purchaseOrderId: boltPo.id,
      lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 3, quantityAccepted: 3 }],
      deliveryNoteRef: "NOTE-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(duplicate.ok && duplicate.duplicate).toBe(true);
    expect(await stockOnHand(fixture.productA.id)).toBe(7);

    const wrong = await recordGoodsReceipt({
      purchaseOrderId: boltPo.id,
      lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 1, condition: "WRONG_PRODUCT" }],
      deliveryNoteRef: "NOTE-2",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    expect(wrong.discrepancies.some((entry) => entry.code === "WRONG_PRODUCT")).toBe(true);
    expect(await stockOnHand(fixture.productA.id)).toBe(7);

    const damaged = await recordGoodsReceipt({
      purchaseOrderId: boltPo.id,
      lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 1, condition: "DAMAGED" }],
      deliveryNoteRef: "NOTE-3",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(damaged.ok).toBe(true);
    expect(await stockOnHand(fixture.productA.id)).toBe(7);
    const open = await db.orderDiscrepancy.findMany({ where: { salesOrderId: order.salesOrderId, status: "OPEN" } });
    expect(open.length).toBeGreaterThanOrEqual(2);
    const summary = await dealClosureSummary(order.salesOrderId);
    expect(summary?.readyToClose).toBe(false);
    expect(summary?.blockingReasons.some((reason) => reason.includes("discrepancy"))).toBe(true);

    for (const discrepancy of open) {
      const resolved = await resolveOrderDiscrepancy({
        discrepancyId: discrepancy.id,
        note: "Rejected quantity returned to the supplier.",
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      });
      expect(resolved.ok).toBe(true);
    }

    await receiveRemaining(fixture, boltPo.id, "NOTE-4");
    expect(await stockOnHand(fixture.productA.id)).toBe(10);
    expect((await db.purchaseOrder.findUnique({ where: { id: boltPo.id } }))?.status).toBe("RECEIVED");
    expect(pos.length).toBe(2);
  });
});

describe("delivery, invoicing, payments and closure", () => {
  it("runs the full lifecycle from acceptance to verified closure", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const orderId = order.salesOrderId;

    const pos = await raisePurchaseOrder(fixture, orderId);
    expect(pos).toHaveLength(2);
    for (const po of pos) await sendPo(fixture, po.id);
    const boltPo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: orderId, lines: { some: { description: { contains: "Hex bolt" } } } },
      include: { lines: true },
    });
    const valvePo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: orderId, lines: { some: { description: { contains: "Gate valve" } } } },
      include: { lines: true },
    });
    if (!boltPo || !valvePo) throw new Error("purchase orders missing");

    const ack = await recordSupplierAcknowledgement({
      purchaseOrderId: boltPo.id,
      outcome: "PARTIALLY_ACKNOWLEDGED",
      lines: [{ purchaseOrderLineId: boltPo.lines[0].id, acknowledgedQuantity: 3 }],
      notes: "First batch confirmed.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    if (!ack.ok) throw new Error(ack.error);
    const reviewed = await reviewSupplierAcknowledgement({
      acknowledgementId: ack.acknowledgementId,
      decision: "APPROVE",
      note: "Partial first batch accepted.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(reviewed.ok).toBe(true);

    const firstReceipt = await recordGoodsReceipt({
      purchaseOrderId: boltPo.id,
      lines: [{ purchaseOrderLineId: boltPo.lines[0].id, quantityReceived: 3 }],
      deliveryNoteRef: "GR-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(firstReceipt.ok).toBe(true);
    const boltLineId = await orderLineId(orderId, "Hex bolt");

    const firstDelivery = await recordDelivery({
      salesOrderId: orderId,
      lines: [{ salesOrderLineId: boltLineId, quantity: 3 }],
      carrier: "Company van",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(firstDelivery.ok).toBe(true);
    if (!firstDelivery.ok) return;
    const pod = await recordProofOfDelivery({
      deliveryId: firstDelivery.deliveryId,
      receivedBy: "Site engineer",
      proofPath: "pod-first.pdf",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(pod.ok).toBe(true);
    expect((await db.salesOrder.findUnique({ where: { id: orderId } }))?.status).toBe("PARTIALLY_DELIVERED");

    const partialInvoice = await issueCustomerInvoice({
      salesOrderId: orderId,
      lines: [{ salesOrderLineId: boltLineId, quantity: 3 }],
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(partialInvoice.ok).toBe(true);
    if (!partialInvoice.ok) return;
    expect(partialInvoice.total).toBe("15.00");

    const firstPayment = await recordCustomerPayment({
      invoiceId: partialInvoice.invoiceId,
      amount: 10,
      reference: "BANK-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(firstPayment.ok).toBe(true);

    const blocked = await closeSalesOrder({
      salesOrderId: orderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
      role: "OWNER",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.blockingReasons?.length).toBeGreaterThan(0);
      expect(blocked.blockingReasons?.some((reason) => reason.includes("not fully delivered"))).toBe(true);
    }
    const staffOverride = await closeSalesOrder({
      salesOrderId: orderId,
      userId: fixture.staff.id,
      actorLabel: fixture.staff.name,
      role: "STAFF",
      overrideReason: "Trying to close early",
    });
    expect(staffOverride.ok).toBe(false);
    if (!staffOverride.ok) expect(staffOverride.error).toMatch(/only the owner/i);

    const boltRemainder = await receiveRemaining(fixture, boltPo.id, "GR-2");
    expect(boltRemainder.ok).toBe(true);
    const valveReceipt = await receiveRemaining(fixture, valvePo.id, "GR-3");
    expect(valveReceipt.ok).toBe(true);
    // Opening stock 4 + accepted 6 - the first dispatch of 3.
    expect(await stockOnHand(fixture.productA.id)).toBe(7);

    const finalDelivery = await deliverAll(fixture, orderId);
    expect(finalDelivery.ok).toBe(true);
    expect((await db.salesOrder.findUnique({ where: { id: orderId } }))?.status).toBe("PARTIALLY_INVOICED");
    expect(await stockOnHand(fixture.productA.id)).toBe(0);

    const finalInvoice = await issueCustomerInvoice({
      salesOrderId: orderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(finalInvoice.ok).toBe(true);
    if (!finalInvoice.ok) return;
    expect(finalInvoice.total).toBe("535.00");
    const invoices = await db.customerInvoice.findMany({ where: { salesOrderId: orderId }, orderBy: { invoiceNumber: "asc" } });
    expect(invoices.reduce((total, invoice) => total + Number(invoice.total), 0)).toBe(550);

    const settlement = await recordCustomerPayment({
      amount: 540,
      currency: "AED",
      allocations: invoices.map((invoice) => ({
        invoiceId: invoice.id,
        amount: Number(invoice.total) - Number(invoice.amountPaid),
      })),
      reference: "BANK-2",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(settlement.ok).toBe(true);
    if (!settlement.ok) return;
    expect(settlement.unallocated).toBe("0.00");
    const paidInvoices = await db.customerInvoice.findMany({ where: { salesOrderId: orderId } });
    expect(paidInvoices.every((invoice) => invoice.status === "PAID")).toBe(true);
    expect(paidInvoices.reduce((total, invoice) => total + Number(invoice.amountPaid), 0)).toBe(550);
    expect((await db.salesOrder.findUnique({ where: { id: orderId } }))?.status).toBe("SETTLED");

    const bill = await recordSupplierBill({
      supplierId: fixture.supplierB.id,
      purchaseOrderId: valvePo.id,
      amount: 350,
      taxAmount: 0,
      supplierInvoiceRef: "SUP-INV-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(bill.ok).toBe(true);
    if (!bill.ok) return;
    const partPayment = await recordSupplierPayment({
      supplierBillId: bill.billId,
      amount: 100,
      reference: "OUT-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(partPayment.ok).toBe(true);
    const summary = await dealClosureSummary(orderId);
    expect(summary?.obligations.supplierOutstanding).toBe("250.00");
    expect(summary?.readyToClose, JSON.stringify(summary?.blockingReasons)).toBe(true);

    const closed = await closeSalesOrder({
      salesOrderId: orderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
      role: "OWNER",
      note: "Delivered, invoiced and paid in full.",
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.overridden).toBe(false);
    const closedOrder = await db.salesOrder.findUnique({ where: { id: orderId } });
    expect(closedOrder?.status).toBe("CLOSED");
    expect(closedOrder?.closedAt).toBeInstanceOf(Date);
    const lifecycleEvents = await db.orderStatusEvent.count({ where: { OR: [{ entityId: orderId }, { salesOrderId: orderId }] } });
    expect(lifecycleEvents).toBeGreaterThan(3);
  });

  it("records a payment reversal without losing its history", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    await raiseSendReceiveAll(fixture, order.salesOrderId);
    await deliverAll(fixture, order.salesOrderId);
    const invoice = await issueCustomerInvoice({
      salesOrderId: order.salesOrderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    if (!invoice.ok) throw new Error(invoice.error);
    expect(invoice.total).toBe("550.00");
    const payment = await recordCustomerPayment({
      invoiceId: invoice.invoiceId,
      amount: 250,
      reference: "BANK-REV",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    if (!payment.ok) throw new Error(payment.error);

    const reversed = await reverseCustomerPayment({
      paymentId: payment.paymentId,
      reason: "Bank returned the transfer.",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(reversed.ok).toBe(true);
    const stored = await db.customerPayment.findUnique({
      where: { id: payment.paymentId },
      include: { allocations: true },
    });
    expect(stored?.status).toBe("REVERSED");
    expect(stored?.allocations).toHaveLength(1);
    const invoiceAfter = await db.customerInvoice.findUnique({ where: { id: invoice.invoiceId } });
    expect(invoiceAfter?.amountPaid.toFixed(2)).toBe("0.00");
    expect(invoiceAfter?.status).toBe("ISSUED");
  });

  it("requires a reason and the owner role for an override, and keeps the before/after state", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const noReason = await closeSalesOrder({
      salesOrderId: order.salesOrderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
      role: "OWNER",
    });
    expect(noReason.ok).toBe(false);
    const staff = await closeSalesOrder({
      salesOrderId: order.salesOrderId,
      userId: fixture.staff.id,
      actorLabel: fixture.staff.name,
      role: "STAFF",
      overrideReason: "Owner asked me to",
    });
    expect(staff.ok).toBe(false);

    const override = await closeSalesOrder({
      salesOrderId: order.salesOrderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
      role: "OWNER",
      overrideReason: "Customer cancelled the remaining quantity in writing; deposit retained.",
    });
    expect(override.ok).toBe(true);
    if (!override.ok) return;
    expect(override.overridden).toBe(true);
    const stored = await db.salesOrder.findUnique({ where: { id: order.salesOrderId } });
    expect(stored?.closureOverrideReason).toMatch(/cancelled/i);
    expect(stored?.closureOverrideById).toBe(fixture.owner.id);
    const audit = await db.auditLog.findFirst({
      where: { entityId: order.salesOrderId, action: "sales_order.closed_with_override" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metaJson).toMatch(/blockingReasons/);
  });

  it("rejects a payment currency that does not match the invoice", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    await raiseSendReceiveAll(fixture, order.salesOrderId);
    await deliverAll(fixture, order.salesOrderId);
    const invoice = await issueCustomerInvoice({
      salesOrderId: order.salesOrderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    if (!invoice.ok) throw new Error(invoice.error);
    const mismatch = await recordCustomerPayment({
      invoiceId: invoice.invoiceId,
      amount: 100,
      currency: "USD",
      reference: "USD-1",
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("CURRENCY_MISMATCH");
  });
});

describe("isolation, concurrency and authorization", () => {
  it("keeps every new lifecycle record inside its tenant", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const [po] = await raisePurchaseOrder(fixture, order.salesOrderId);

    await runWithTenant({ organizationId: "org_ogs", source: "test" }, async () => {
      expect(await db.salesOrder.count()).toBe(0);
      expect(await db.purchaseOrder.count()).toBe(0);
      expect(await db.salesOrder.findUnique({ where: { id: order.salesOrderId } })).toBeNull();
      const crossed = await createSalesOrderFromAcceptance({
        quotationId: fixture.quotation.id,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      });
      expect(crossed.ok).toBe(false);
      const crossedApproval = await approveSupplierPurchaseOrder({
        purchaseOrderId: po.id,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      });
      expect(crossedApproval.ok).toBe(false);
    });
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("does not double-post stock or over-allocate money under concurrent requests", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const pos = await raisePurchaseOrder(fixture, order.salesOrderId);
    const boltPo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: order.salesOrderId, lines: { some: { description: { contains: "Hex bolt" } } } },
      include: { lines: true },
    });
    if (!boltPo) throw new Error("bolt PO missing");
    await sendPo(fixture, boltPo.id);
    expect(pos.length).toBe(2);
    const boltLine = boltPo.lines[0];

    const receipts = await Promise.all([
      recordGoodsReceipt({
        purchaseOrderId: boltPo.id,
        lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 6 }],
        deliveryNoteRef: "CONCURRENT-A",
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
      recordGoodsReceipt({
        purchaseOrderId: boltPo.id,
        lines: [{ purchaseOrderLineId: boltLine.id, quantityReceived: 6 }],
        deliveryNoteRef: "CONCURRENT-B",
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
    ]);
    expect(receipts.every((receipt) => receipt.ok)).toBe(true);
    expect(await stockOnHand(fixture.productA.id)).toBe(10);
    const accepted = await db.goodsReceiptLine.aggregate({
      where: { purchaseOrderLineId: boltLine.id },
      _sum: { quantityAccepted: true },
    });
    expect(Number(accepted._sum.quantityAccepted)).toBe(6);

    const deliver = await deliverAll(fixture, order.salesOrderId);
    expect(deliver.ok).toBe(true);
    const invoice = await issueCustomerInvoice({
      salesOrderId: order.salesOrderId,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    if (!invoice.ok) throw new Error(invoice.error);
    expect(invoice.total).toBe("50.00");

    const payments = await Promise.all([
      recordCustomerPayment({
        invoiceId: invoice.invoiceId,
        amount: 50,
        reference: "CONCURRENT-PAY-A",
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
      recordCustomerPayment({
        invoiceId: invoice.invoiceId,
        amount: 50,
        reference: "CONCURRENT-PAY-B",
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
    ]);
    expect(payments.filter((payment) => payment.ok)).toHaveLength(1);
    const storedInvoice = await db.customerInvoice.findUnique({ where: { id: invoice.invoiceId } });
    expect(storedInvoice?.amountPaid.toFixed(2)).toBe("50.00");
    const allocations = await db.paymentAllocation.aggregate({
      where: { invoiceId: invoice.invoiceId },
      _sum: { amount: true },
    });
    expect(Number(allocations._sum.amount)).toBe(50);
  });

  it("does not authorize an owner without an authenticated request", async () => {
    await expect(authorizeOwner()).rejects.toThrow();
  });

  it("raises in-app owner reminders for overdue commitments without sending supplier messages", async () => {
    const fixture = await seed();
    const order = await acceptedOrder(fixture);
    if (!order.ok) throw new Error(order.error);
    const pos = await raisePurchaseOrder(fixture, order.salesOrderId);
    const boltPo = await db.purchaseOrder.findFirst({
      where: { salesOrderId: order.salesOrderId, lines: { some: { description: { contains: "Hex bolt" } } } },
    });
    if (!boltPo) throw new Error("bolt PO missing");
    await sendPo(fixture, boltPo.id);
    await db.purchaseOrder.update({
      where: { id: boltPo.id },
      data: {
        sentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        expectedDeliveryDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    expect(pos.length).toBe(2);
    const beforePosMessages = await db.outboundMessage.count({ where: { relatedType: "PurchaseOrder" } });
    const result = await runOrderReminderCheck(new Date());
    expect(result.notified).toBeGreaterThanOrEqual(2);
    expect(await db.outboundMessage.count({ where: { relatedType: "PurchaseOrder" } })).toBe(beforePosMessages);
    const types = await db.notification.findMany({ select: { type: true } });
    expect(types.map((row) => row.type)).toEqual(expect.arrayContaining(["ORDER_ACK_OVERDUE", "ORDER_DELIVERY_OVERDUE"]));
    const secondRun = await runOrderReminderCheck(new Date());
    expect(secondRun.notified).toBe(0);
  });
});

describe("pure acceptance comparison", () => {
  it("treats an exact acceptance as having no blocking differences", () => {
    const snapshot = {
      id: "q",
      quoteNumber: "QT-1",
      version: 1,
      currency: "AED",
      status: "SENT",
      subtotal: 100,
      taxAmount: 5,
      total: 105,
      terms: "Net 30",
      validityDate: new Date(Date.now() + 86_400_000),
      customerName: "Buyer",
      items: [
        {
          id: "line-1",
          description: "Gate valve",
          specs: "SS316",
          quantity: 2,
          unit: "pcs",
          unitPrice: 50,
          lineTotal: 100,
          stockQuantity: 0,
          procureQuantity: 2,
          supplierOfferId: null,
          enquiryItemId: null,
        },
      ],
    };
    const exact = compareAcceptanceToQuotation(snapshot, {
      quotationId: "q",
      currency: "AED",
      lines: [{ quotationItemId: "line-1", quantity: 2, unitPrice: 50, specs: "SS316" }],
    });
    expect(exact.blocking).toHaveLength(0);
    expect(exact.discrepancies).toHaveLength(0);
  });
});
