import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { sha256 } from "../crypto";
import { nextNumber } from "../workflow/sequences";
import { dec, money, qty, sum, toMoneyString } from "./money";
import { refreshSalesOrderStatus } from "./state";

/**
 * Customer receipts, supplier bills and supplier payments.
 *
 * Money is recorded only from owner-entered, evidence-backed entries. A payment
 * allocation can never exceed the invoice's outstanding balance, currencies are
 * never silently converted, and a reversal keeps its history instead of
 * deleting the original payment.
 */

/** Recomputes an invoice's paid amount and status from its allocations. */
export async function reconcileInvoiceStatus(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const invoice = await tx.customerInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, total: true, status: true, salesOrderId: true },
  });
  if (!invoice || invoice.status === "VOID") return;
  const allocations = await tx.paymentAllocation.findMany({
    where: { invoiceId, payment: { status: "CONFIRMED" } },
    select: { amount: true },
  });
  const paid = money(sum(allocations.map((allocation) => allocation.amount)));
  const status = paid.gte(money(invoice.total)) ? "PAID" : paid.gt(0) ? "PARTIALLY_PAID" : "ISSUED";
  if (status === invoice.status && paid.equals(dec(0)) && status !== "ISSUED") return;
  await tx.customerInvoice.updateMany({
    where: { id: invoice.id },
    data: { amountPaid: paid, status },
  });
  await refreshSalesOrderStatus(tx, invoice.salesOrderId, {});
}

export type PaymentAllocationInput = { invoiceId: string; amount: number | string };

export type RecordCustomerPaymentInput = {
  amount: number | string;
  currency?: string | null;
  allocations?: PaymentAllocationInput[];
  invoiceId?: string | null;
  customerId?: string | null;
  receivedAt?: Date | string | null;
  method?: string | null;
  reference?: string | null;
  proofPath?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
};

export type RecordCustomerPaymentResult =
  | { ok: true; paymentId: string; paymentNumber: string; unallocated: string; duplicate: boolean }
  | { ok: false; error: string; code?: "CURRENCY_MISMATCH" | "DUPLICATE_REFERENCE" | "OVER_ALLOCATION" };

export async function recordCustomerPayment(input: RecordCustomerPaymentInput): Promise<RecordCustomerPaymentResult> {
  const amount = money(input.amount);
  if (amount.lte(0)) return { ok: false, error: "Payment amount must be positive." };

  const allocationsRequested: PaymentAllocationInput[] = input.allocations?.length
    ? input.allocations
    : input.invoiceId
      ? [{ invoiceId: input.invoiceId, amount: input.amount }]
      : [];
  const allocationTotal = money(sum(allocationsRequested.map((allocation) => dec(allocation.amount))));
  if (allocationTotal.gt(amount)) {
    return { ok: false, code: "OVER_ALLOCATION", error: "Allocations cannot exceed the payment amount." };
  }
  if (allocationsRequested.some((allocation) => money(allocation.amount).lte(0))) {
    return { ok: false, error: "Every allocation must be a positive amount." };
  }

  const reference = input.reference?.trim() || null;
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `payment:${sha256(
      JSON.stringify({
        customerId: input.customerId ?? null,
        reference,
        amount: amount.toFixed(4),
        receivedAt: input.receivedAt ? String(input.receivedAt) : null,
        allocations: [...allocationsRequested].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)),
      }),
    ).slice(0, 32)}`;

  const existing = await db.customerPayment.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: await tenantId(), idempotencyKey } },
  });
  if (existing) {
    return {
      ok: true,
      paymentId: existing.id,
      paymentNumber: existing.paymentNumber,
      unallocated: "0.00",
      duplicate: true,
    };
  }

  const invoiceIds = [...new Set(allocationsRequested.map((allocation) => allocation.invoiceId))];
  if (invoiceIds.length > 0) {
    if (reference) {
      const duplicateReference = await db.customerPayment.findFirst({
        where: { reference, status: "CONFIRMED" },
        select: { id: true, paymentNumber: true },
      });
      if (duplicateReference) {
        return {
          ok: false,
          code: "DUPLICATE_REFERENCE",
          error: `Transaction reference "${reference}" was already recorded on ${duplicateReference.paymentNumber}. Check the bank statement before recording it again.`,
        };
      }
    }
  }

  const paymentNumber = await nextNumber("RCT");

  try {
    const created = await db.$transaction(async (tx) => {
      let currency: string | null = input.currency?.trim().toUpperCase() || null;
      let customerId = input.customerId?.trim() || null;

      // Serialize concurrent receipts that touch the same invoices. Without the
      // row lock, two transactions could each see the same pre-payment balance
      // and both allocate the full amount.
      for (const invoiceId of [...new Set(allocationsRequested.map((allocation) => allocation.invoiceId))].sort()) {
        await tx.$queryRaw`SELECT id FROM "CustomerInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
      }

      for (const allocation of allocationsRequested) {
        const invoice = await tx.customerInvoice.findUnique({
          where: { id: allocation.invoiceId },
          select: { id: true, currency: true, total: true, amountPaid: true, customerId: true, status: true, salesOrderId: true },
        });
        if (!invoice) throw new Error("An allocated invoice was not found.");
        if (invoice.status === "VOID") throw new Error("A void invoice cannot receive a payment.");
        if (!currency) currency = invoice.currency;
        if (currency !== invoice.currency.toUpperCase()) {
          throw new CurrencyMismatchError(
            `The payment is in ${currency} but invoice ${allocation.invoiceId} is in ${invoice.currency}. Record the amount in the invoice currency with conversion evidence.`,
          );
        }
        if (customerId && invoice.customerId && customerId !== invoice.customerId) {
          throw new Error("The payment customer does not match the invoice customer.");
        }
        customerId = customerId ?? invoice.customerId;
        const paid = money(invoice.amountPaid);
        const balance = money(dec(invoice.total).minus(paid));
        if (money(allocation.amount).gt(balance)) {
          throw new Error(
            `The allocation for invoice ${allocation.invoiceId} exceeds the outstanding balance of ${invoice.currency} ${balance.toFixed(2)}.`,
          );
        }
      }

      const resolvedCurrency = currency ?? (await tx.organization.findUnique({ where: { id: await tenantId() } }))?.defaultCurrency ?? "AED";
      const receivedAtRaw = input.receivedAt ? new Date(input.receivedAt) : new Date();
      const receivedAt = Number.isNaN(receivedAtRaw.getTime()) ? new Date() : receivedAtRaw;

      const payment = await tx.customerPayment.create({
        data: {
          paymentNumber,
          idempotencyKey,
          customerId,
          amount,
          currency: resolvedCurrency,
          receivedAt,
          method: input.method?.trim().toUpperCase() || "BANK_TRANSFER",
          reference,
          proofPath: input.proofPath?.trim() || null,
          notes: input.notes?.trim() || null,
          status: "CONFIRMED",
          recordedById: input.userId,
        },
      });

      for (const allocation of allocationsRequested) {
        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: allocation.invoiceId,
            amount: money(allocation.amount),
          },
        });
        await reconcileInvoiceStatus(tx, allocation.invoiceId);
      }

      return payment;
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "customer_payment.recorded",
      entityType: "CustomerPayment",
      entityId: created.id,
      meta: {
        paymentNumber: created.paymentNumber,
        amount: created.amount.toFixed(4),
        currency: created.currency,
        reference,
        allocations: allocationsRequested,
        unallocated: money(amount.minus(allocationTotal)).toFixed(4),
      },
    });
    return {
      ok: true,
      paymentId: created.id,
      paymentNumber: created.paymentNumber,
      unallocated: toMoneyString(money(amount.minus(allocationTotal))),
      duplicate: false,
    };
  } catch (error) {
    if (error instanceof CurrencyMismatchError) return { ok: false, code: "CURRENCY_MISMATCH", error: error.message };
    if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
      const raced = await db.customerPayment.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: await tenantId(), idempotencyKey } },
      });
      if (raced) {
        return { ok: true, paymentId: raced.id, paymentNumber: raced.paymentNumber, unallocated: "0.00", duplicate: true };
      }
    }
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
}

class CurrencyMismatchError extends Error {}

export async function reverseCustomerPayment(input: {
  paymentId: string;
  reason: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.reason.trim()) return { ok: false, error: "Record why the payment is being reversed." };
  const payment = await db.customerPayment.findUnique({
    where: { id: input.paymentId },
    include: { allocations: true },
  });
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status === "REVERSED") return { ok: false, error: "This payment was already reversed." };

  const applied = await db.$transaction(async (tx) => {
    const claimed = await tx.customerPayment.updateMany({
      where: { id: payment.id, status: "CONFIRMED" },
      data: {
        status: "REVERSED",
        reversedById: input.userId,
        reversedAt: new Date(),
        reversalReason: input.reason.trim(),
      },
    });
    if (claimed.count === 0) return false;
    // Allocations are retained as history. Reconciliation counts only
    // allocations of CONFIRMED payments, so a reversed receipt no longer
    // reduces the invoice balance.
    for (const allocation of payment.allocations) {
      await reconcileInvoiceStatus(tx, allocation.invoiceId);
    }
    return true;
  });
  if (!applied) return { ok: false, error: "This payment was already reversed." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "customer_payment.reversed",
    entityType: "CustomerPayment",
    entityId: payment.id,
    meta: {
      paymentNumber: payment.paymentNumber,
      amount: payment.amount.toFixed(4),
      currency: payment.currency,
      reason: input.reason,
      allocations: payment.allocations.map((allocation) => ({ invoiceId: allocation.invoiceId, amount: allocation.amount.toFixed(4) })),
    },
  });
  await notifyOwner({
    type: "PAYMENT_REVERSED",
    title: "A customer payment was reversed",
    body: `${payment.paymentNumber} (${payment.currency} ${payment.amount.toFixed(2)}) was reversed: ${input.reason}`,
    link: "/orders",
  });
  return { ok: true };
}

/** Records a supplier invoice/bill as an obligation. Not a payment. */
export async function recordSupplierBill(input: {
  supplierId: string;
  amount: number | string;
  taxAmount?: number | string | null;
  currency?: string | null;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
  supplierInvoiceRef?: string | null;
  dueDate?: Date | string | null;
  paymentTerms?: string | null;
  receivedAt?: Date | string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true; billId: string; billNumber: string; duplicate: boolean } | { ok: false; error: string }> {
  const amount = money(input.amount);
  if (amount.lte(0)) return { ok: false, error: "Bill amount must be positive." };
  const supplier = await db.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) return { ok: false, error: "Supplier not found." };

  const po = input.purchaseOrderId
    ? await db.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId }, select: { id: true, supplierId: true, currency: true, salesOrderId: true } })
    : null;
  if (input.purchaseOrderId && !po) return { ok: false, error: "Purchase order not found." };
  if (po && po.supplierId !== supplier.id) return { ok: false, error: "The purchase order belongs to a different supplier." };

  const currency = (input.currency?.trim() || po?.currency || "AED").toUpperCase();
  if (po && po.currency !== currency) return { ok: false, error: `The purchase order is in ${po.currency}; the bill is in ${currency}.` };
  const taxAmount = money(input.taxAmount ?? 0);
  const total = money(amount.plus(taxAmount));
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `bill:${supplier.id}:${sha256(JSON.stringify({ ref: input.supplierInvoiceRef ?? null, amount: amount.toFixed(4), total: total.toFixed(4), po: po?.id ?? null })).slice(0, 32)}`;

  const existing = await db.supplierBill.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: await tenantId(), idempotencyKey } },
  });
  if (existing) return { ok: true, billId: existing.id, billNumber: existing.billNumber, duplicate: true };

  const billNumber = await nextNumber("SB");
  const receivedAtRaw = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const dueDateRaw = input.dueDate ? new Date(input.dueDate) : null;

  const created = await db.supplierBill.create({
    data: {
      billNumber,
      idempotencyKey,
      supplierId: supplier.id,
      purchaseOrderId: po?.id ?? null,
      goodsReceiptId: input.goodsReceiptId ?? null,
      supplierInvoiceRef: input.supplierInvoiceRef?.trim() || null,
      status: "OPEN",
      currency,
      amount,
      taxAmount,
      total,
      paidAmount: dec(0),
      dueDate: dueDateRaw && !Number.isNaN(dueDateRaw.getTime()) ? dueDateRaw : null,
      paymentTerms: input.paymentTerms?.trim() || null,
      receivedAt: Number.isNaN(receivedAtRaw.getTime()) ? new Date() : receivedAtRaw,
      notes: input.notes?.trim() || null,
      recordedById: input.userId,
    },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_bill.recorded",
    entityType: "SupplierBill",
    entityId: created.id,
    meta: { billNumber, supplierId: supplier.id, currency, total: total.toFixed(4), purchaseOrderId: po?.id ?? null },
  });
  return { ok: true, billId: created.id, billNumber, duplicate: false };
}

export async function recordSupplierPayment(input: {
  supplierBillId: string;
  amount: number | string;
  paidAt?: Date | string | null;
  method?: string | null;
  reference?: string | null;
  proofPath?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true; paymentNumber: string; duplicate: boolean } | { ok: false; error: string }> {
  const bill = await db.supplierBill.findUnique({ where: { id: input.supplierBillId } });
  if (!bill) return { ok: false, error: "Supplier bill not found." };
  if (bill.status === "PAID") return { ok: false, error: "This supplier bill is already paid." };
  const amount = money(input.amount);
  if (amount.lte(0)) return { ok: false, error: "Payment amount must be positive." };
  const balance = money(dec(bill.total).minus(dec(bill.paidAmount)));
  if (amount.gt(balance)) {
    return { ok: false, error: `The payment exceeds the outstanding supplier balance of ${bill.currency} ${balance.toFixed(2)}.` };
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `supplier-payment:${bill.id}:${sha256(JSON.stringify({ amount: amount.toFixed(4), reference: input.reference ?? null })).slice(0, 32)}`;
  const existing = await db.supplierPayment.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: await tenantId(), idempotencyKey } },
  });
  if (existing) return { ok: true, paymentNumber: existing.paymentNumber, duplicate: true };

  const paymentNumber = await nextNumber("SPY");
  const paidAtRaw = input.paidAt ? new Date(input.paidAt) : new Date();
  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SupplierBill" WHERE id = ${bill.id} FOR UPDATE`;
    const lockedBill = await tx.supplierBill.findUnique({ where: { id: bill.id } });
    if (!lockedBill) throw new Error("Supplier bill not found.");
    if (lockedBill.status === "PAID") throw new Error("This supplier bill is already paid.");
    const lockedBalance = money(dec(lockedBill.total).minus(dec(lockedBill.paidAmount)));
    if (amount.gt(lockedBalance)) {
      throw new Error(
        `The payment exceeds the outstanding supplier balance of ${lockedBill.currency} ${lockedBalance.toFixed(2)}.`,
      );
    }
    const payment = await tx.supplierPayment.create({
      data: {
        paymentNumber,
        idempotencyKey,
        supplierBillId: bill.id,
        amount,
        currency: bill.currency,
        paidAt: Number.isNaN(paidAtRaw.getTime()) ? new Date() : paidAtRaw,
        method: input.method?.trim().toUpperCase() || "BANK_TRANSFER",
        reference: input.reference?.trim() || null,
        proofPath: input.proofPath?.trim() || null,
        notes: input.notes?.trim() || null,
        status: "CONFIRMED",
        recordedById: input.userId,
      },
    });
    const newPaid = money(dec(lockedBill.paidAmount).plus(amount));
    await tx.supplierBill.update({
      where: { id: bill.id },
      data: {
        paidAmount: newPaid,
        status: newPaid.gte(money(lockedBill.total)) ? "PAID" : "PARTIALLY_PAID",
      },
    });
    return payment;
  }).catch((error: unknown) => {
    if (error instanceof Error) return { error: error.message } as const;
    throw error;
  });
  if ("error" in created) return { ok: false, error: created.error };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_payment.recorded",
    entityType: "SupplierPayment",
    entityId: created.id,
    meta: { paymentNumber, supplierBillId: bill.id, currency: bill.currency, amount: amount.toFixed(4) },
  });
  return { ok: true, paymentNumber, duplicate: false };
}

export async function reverseSupplierPayment(input: {
  paymentId: string;
  reason: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.reason.trim()) return { ok: false, error: "Record why the payment is being reversed." };
  const payment = await db.supplierPayment.findUnique({ where: { id: input.paymentId }, include: { supplierBill: true } });
  if (!payment) return { ok: false, error: "Supplier payment not found." };
  if (payment.status === "REVERSED") return { ok: false, error: "This payment was already reversed." };

  const applied = await db.$transaction(async (tx) => {
    const claimed = await tx.supplierPayment.updateMany({
      where: { id: payment.id, status: "CONFIRMED" },
      data: { status: "REVERSED", reversedById: input.userId, reversedAt: new Date(), reversalReason: input.reason.trim() },
    });
    if (claimed.count === 0) return false;
    const paid = money(dec(payment.supplierBill.paidAmount).minus(dec(payment.amount)));
    await tx.supplierBill.update({
      where: { id: payment.supplierBillId },
      data: {
        paidAmount: paid,
        status: paid.lte(0) ? "OPEN" : paid.gte(money(payment.supplierBill.total)) ? "PAID" : "PARTIALLY_PAID",
      },
    });
    return true;
  });
  if (!applied) return { ok: false, error: "This payment was already reversed." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_payment.reversed",
    entityType: "SupplierPayment",
    entityId: payment.id,
    meta: { paymentNumber: payment.paymentNumber, amount: payment.amount.toFixed(4), reason: input.reason },
  });
  return { ok: true };
}

/** Customer payment history with its allocations, for the order screen. */
export async function customerPaymentsForOrder(salesOrderId: string) {
  const invoices = await db.customerInvoice.findMany({ where: { salesOrderId }, select: { id: true } });
  return db.customerPayment.findMany({
    where: { allocations: { some: { invoiceId: { in: invoices.map((invoice) => invoice.id) } } } },
    orderBy: { receivedAt: "desc" },
    include: { allocations: { include: { invoice: { select: { invoiceNumber: true } } } } },
  });
}

export async function supplierBillsForOrder(salesOrderId: string) {
  return db.supplierBill.findMany({
    where: { purchaseOrder: { salesOrderId } },
    orderBy: { receivedAt: "desc" },
    include: { supplier: { select: { name: true } }, payments: true },
  });
}

/** Parses a stored supplier acknowledgement's quantities for display. */
export function acknowledgementLines(linesJson: string) {
  return parseJson<Array<{ description: string; orderedQuantity: number; acknowledgedQuantity: number; revisedUnitPrice: number | null }>>(linesJson, []);
}

export function allocationSummary(payment: { amount: unknown; allocations: Array<{ amount: unknown }> }) {
  const allocated = money(sum(payment.allocations.map((allocation) => dec(allocation.amount as number))));
  return { allocated: toMoneyString(allocated), unallocated: toMoneyString(money(dec(payment.amount as number).minus(allocated))) };
}

export { qty, stringifyJson };

async function tenantId(): Promise<string> {
  const { requireTenantId } = await import("../tenant");
  return requireTenantId();
}
