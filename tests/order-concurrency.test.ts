import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createSupplierPurchaseOrders } from "../src/lib/orders/purchaseOrders";
import { recordDelivery } from "../src/lib/orders/delivery";
import { issueCustomerInvoice } from "../src/lib/orders/invoicing";
import { stockOnHand } from "../src/lib/orders/receipts";
import { orderMetrics } from "../src/lib/orders/metrics";

vi.mock("../src/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, simulated: true })),
}));

async function seedOrder(input: { quantity: number; stockQuantity: number; productId?: string | null }) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { email: `conc-${suffix}@example.com`, name: "Concurrency Owner", passwordHash: "not-used", role: "OWNER" },
  });
  const customer = await db.customer.create({ data: { name: `Concurrency Customer ${suffix}` } });
  const enquiry = await db.enquiry.create({
    data: { publicRef: `CONC-${suffix}`, channel: "MANUAL", customerId: customer.id, customerName: customer.name, rawText: "concurrency", currency: "AED" },
  });
  const item = await db.enquiryItem.create({
    data: {
      enquiryId: enquiry.id,
      lineNo: 1,
      description: `Concurrency item ${suffix}`,
      unit: "pcs",
      quantity: input.quantity,
      quantityFromStock: input.stockQuantity,
      quantityToSource: input.quantity - input.stockQuantity,
      reviewStatus: "CONFIRMED",
    },
  });
  const product = input.productId === null
    ? null
    : await db.product.create({ data: { sku: `CONC-${suffix}`, name: `Concurrency product ${suffix}`, category: "Test", unit: "pcs" } });
  if (product) await db.enquiryItem.update({ where: { id: item.id }, data: { matchedProductId: product.id } });
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      quoteNumber: `CONC-QT-${suffix}`,
      customerName: customer.name,
      currency: "AED",
      status: "SENT",
      sentAt: new Date(),
      items: { create: [{ description: item.description, quantity: input.quantity, unit: "pcs", unitPrice: 100, lineTotal: input.quantity * 100 }] },
    },
  });
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `CONC-SO-${suffix}`,
      idempotencyKey: `conc-order-${suffix}`,
      quotationId: quotation.id,
      quotationVersion: 1,
      customerId: customer.id,
      customerName: customer.name,
      currency: "AED",
      subtotal: input.quantity * 100,
      total: input.quantity * 100,
      lines: {
        create: [
          {
            lineNo: 1,
            enquiryItemId: item.id,
            productId: product?.id ?? null,
            description: item.description,
            quantity: input.quantity,
            unit: "pcs",
            unitPrice: 100,
            lineTotal: input.quantity * 100,
            stockQuantity: input.stockQuantity,
            procureQuantity: input.quantity - input.stockQuantity,
          },
        ],
      },
    },
    include: { lines: true },
  });
  return { suffix, owner, customer, enquiry, item, product, order };
}

afterAll(async () => {
  await db.customerInvoiceLine.deleteMany();
  await db.customerInvoice.deleteMany();
  await db.deliveryLine.deleteMany();
  await db.delivery.deleteMany();
  await db.purchaseOrderLine.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.salesOrderLine.deleteMany();
  await db.salesOrder.deleteMany();
  await db.orderStatusEvent.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.inventoryStock.deleteMany();
  await db.inventoryLocation.deleteMany();
  await db.approval.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.supplierOffer.deleteMany();
  await db.supplier.deleteMany();
  await db.customer.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.product.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.user.deleteMany();
});

describe("order mutation concurrency", () => {
  it("never creates more purchase commitment than the remaining quantity", async () => {
    const fixture = await seedOrder({ quantity: 10, stockQuantity: 0 });
    const supplier = await db.supplier.create({
      data: { name: `Concurrency Supplier ${fixture.suffix}`, email: `supplier-${fixture.suffix}@example.com`, status: "ACTIVE", identityStatus: "VERIFIED" },
    });
    const offer = await db.supplierOffer.create({
      data: {
        enquiryItemId: fixture.item.id,
        supplierId: supplier.id,
        supplierName: supplier.name,
        productTitle: fixture.item.description,
        matchStatus: "EXACT",
        unitPrice: 100,
        currency: "AED",
        moq: 1,
        leadTimeDays: 5,
        validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: "QUOTE_RECEIVED",
        verificationStatus: "VERIFIED",
        isEligible: true,
      },
    });

    const [first, second] = await Promise.all([
      createSupplierPurchaseOrders({
        salesOrderId: fixture.order.id,
        selections: [{ salesOrderLineId: fixture.order.lines[0].id, supplierOfferId: offer.id }],
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
        idempotencyKey: `concurrent-po-${fixture.suffix}-a`,
      }),
      createSupplierPurchaseOrders({
        salesOrderId: fixture.order.id,
        selections: [{ salesOrderLineId: fixture.order.lines[0].id, supplierOfferId: offer.id }],
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
        idempotencyKey: `concurrent-po-${fixture.suffix}-b`,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const failed = outcomes.find((outcome) => !outcome.ok);
    expect(failed && !failed.ok ? failed.error : "").toMatch(/still needs procurement|no remaining quantity/i);
    const created = await db.purchaseOrderLine.findMany({ where: { salesOrderLineId: fixture.order.lines[0].id } });
    expect(created.reduce((total, line) => total + Number(line.quantity), 0)).toBe(10);
    expect(await db.purchaseOrder.count()).toBe(1);
  });

  it("never dispatches the same stock twice or takes stock below zero", async () => {
    const fixture = await seedOrder({ quantity: 10, stockQuantity: 10 });
    const location = await db.inventoryLocation.create({ data: { code: `CONC-LOC-${fixture.suffix}`, name: "Main" } });
    await db.inventoryStock.create({
      data: { productId: fixture.product!.id, locationId: location.id, quantityOnHand: 10, quantityReserved: 10 },
    });

    const [first, second] = await Promise.all([
      recordDelivery({
        salesOrderId: fixture.order.id,
        lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 6 }],
        idempotencyKey: `concurrent-delivery-${fixture.suffix}-a`,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
      recordDelivery({
        salesOrderId: fixture.order.id,
        lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 6 }],
        idempotencyKey: `concurrent-delivery-${fixture.suffix}-b`,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
    ]);

    expect([first, second].filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await stockOnHand(fixture.product!.id)).toBe(4);
    const dispatchRows = await db.deliveryLine.findMany({ where: { salesOrderLineId: fixture.order.lines[0].id } });
    expect(dispatchRows.reduce((total, line) => total + Number(line.quantity), 0)).toBe(6);
    const stock = await db.inventoryStock.findFirstOrThrow({ where: { productId: fixture.product!.id } });
    expect(Number(stock.quantityOnHand)).toBeGreaterThanOrEqual(0);
  });

  it("allows only one of two invoice attempts for the same delivered quantity", async () => {
    const fixture = await seedOrder({ quantity: 10, stockQuantity: 10 });
    const delivery = await db.delivery.create({
      data: {
        deliveryNumber: `CONC-DN-${fixture.suffix}`,
        idempotencyKey: `conc-dn-${fixture.suffix}`,
        salesOrderId: fixture.order.id,
        status: "DELIVERED",
        deliveredAt: new Date(),
        lines: { create: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }] },
      },
    });
    expect(delivery.id).toBeTruthy();

    const metrics = await db.$transaction((tx) => orderMetrics(tx, fixture.order.id));
    expect(metrics.lines[0].remainingToInvoice.toFixed(4)).toBe("10.0000");

    const [first, second] = await Promise.all([
      issueCustomerInvoice({
        salesOrderId: fixture.order.id,
        lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }],
        idempotencyKey: `concurrent-invoice-${fixture.suffix}-a`,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
      issueCustomerInvoice({
        salesOrderId: fixture.order.id,
        lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }],
        idempotencyKey: `concurrent-invoice-${fixture.suffix}-b`,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      }),
    ]);

    expect([first, second].filter((outcome) => outcome.ok)).toHaveLength(1);
    const failed = [first, second].find((outcome) => !outcome.ok);
    expect(failed && !failed.ok ? failed.error : "").toMatch(/delivered and not yet invoiced|nothing delivered/i);
    const invoices = await db.customerInvoice.findMany({ where: { salesOrderId: fixture.order.id }, include: { lines: true } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].lines.reduce((total, line) => total + Number(line.quantity), 0)).toBe(10);
  });

  it("allows a new invoice action for a later delivery with the same quantity", async () => {
    const fixture = await seedOrder({ quantity: 20, stockQuantity: 20 });
    const location = await db.inventoryLocation.create({ data: { code: `CONC-ILOC-${fixture.suffix}`, name: "Main" } });
    await db.inventoryStock.create({
      data: { productId: fixture.product!.id, locationId: location.id, quantityOnHand: 20, quantityReserved: 20 },
    });

    const deliver = async (key: string) => {
      const result = await recordDelivery({
        salesOrderId: fixture.order.id,
        lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }],
        idempotencyKey: `later-delivery-${fixture.suffix}-${key}`,
        userId: fixture.owner.id,
        actorLabel: fixture.owner.name,
      });
      if (!result.ok) throw new Error(result.error);
      await db.delivery.update({ where: { id: result.deliveryId }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    };

    await deliver("a");
    const first = await issueCustomerInvoice({
      salesOrderId: fixture.order.id,
      lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }],
      idempotencyKey: `later-invoice-${fixture.suffix}-a`,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(first.ok).toBe(true);

    await deliver("b");
    const second = await issueCustomerInvoice({
      salesOrderId: fixture.order.id,
      lines: [{ salesOrderLineId: fixture.order.lines[0].id, quantity: 10 }],
      idempotencyKey: `later-invoice-${fixture.suffix}-b`,
      userId: fixture.owner.id,
      actorLabel: fixture.owner.name,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.duplicate).toBe(false);
    const invoices = await db.customerInvoice.findMany({ where: { salesOrderId: fixture.order.id } });
    expect(invoices).toHaveLength(2);
  });
});
