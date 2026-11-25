import { db } from "../db";
import { writeAudit } from "../audit";
import { sha256 } from "../crypto";
import { requireTenantId } from "../tenant";
import { nextNumber } from "../workflow/sequences";
import { dec, lineTotals, money, qty, sum, toMoneyString } from "./money";
import { orderMetrics } from "./metrics";
import { recordOrderEvent } from "./events";
import { refreshSalesOrderStatus } from "./state";

/**
 * Customer invoicing.
 *
 * An invoice is issued only for delivered quantity that has not yet been
 * invoiced. The issued lines are an immutable snapshot of the sales-order prices
 * and the configured tax rate; corrections belong in a separate credit or
 * debit record, never an edit of an issued invoice.
 */

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  ISSUED: "Issued",
  PARTIALLY_PAID: "Partly paid",
  PAID: "Paid",
  VOID: "Void",
};

export async function invoicePaymentTermDays(): Promise<number> {
  const organizationId = await requireTenantId();
  const setting = await db.appSetting.findUnique({
    where: { organizationId_key: { organizationId, key: "invoices.paymentTermDays" } },
  });
  const configured = Number(setting?.value);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 30;
}

export type IssueInvoiceInput = {
  salesOrderId: string;
  lines?: Array<{ salesOrderLineId: string; quantity: number | string }> | null;
  invoiceDate?: Date | string | null;
  dueDate?: Date | string | null;
  notes?: string | null;
  deliveryId?: string | null;
  idempotencyKey?: string | null;
  userId: string;
  actorLabel: string;
};

export type IssueInvoiceResult =
  | { ok: true; invoiceId: string; invoiceNumber: string; total: string; duplicate: boolean }
  | { ok: false; error: string };

export async function issueCustomerInvoice(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
  const order = await db.salesOrder.findUnique({ where: { id: input.salesOrderId } });
  if (!order) return { ok: false, error: "Sales order not found." };
  if (order.status === "CLOSED" || order.status === "CANCELLED") {
    return { ok: false, error: "This sales order is closed; no further invoice can be issued." };
  }

  const invoiceDateRaw = input.invoiceDate ? new Date(input.invoiceDate) : new Date();
  const invoiceDate = Number.isNaN(invoiceDateRaw.getTime()) ? new Date() : invoiceDateRaw;
  const termDays = await invoicePaymentTermDays();
  const dueDateRaw = input.dueDate ? new Date(input.dueDate) : new Date(invoiceDate.getTime() + termDays * 24 * 60 * 60 * 1000);
  const dueDate = Number.isNaN(dueDateRaw.getTime()) ? null : dueDateRaw;

  const requested = input.lines ?? null;
  const signature = sha256(
    JSON.stringify({
      orderId: order.id,
      deliveryId: input.deliveryId ?? null,
      lines: requested
        ? [...requested].sort((a, b) => a.salesOrderLineId.localeCompare(b.salesOrderLineId)).map((line) => ({ id: line.salesOrderLineId, q: String(line.quantity) }))
        : "ALL_REMAINING",
    }),
  );
  const idempotencyKey = input.idempotencyKey?.trim() || `invoice:${order.id}:${signature.slice(0, 32)}`;
  const existing = await db.customerInvoice.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: order.organizationId, idempotencyKey } },
  });
  if (existing) {
    return { ok: true, invoiceId: existing.id, invoiceNumber: existing.invoiceNumber, total: toMoneyString(existing.total), duplicate: true };
  }

  const invoiceNumber = await nextNumber("INV");

  try {
    const created = await db.$transaction(async (tx) => {
      const metrics = await orderMetrics(tx, order.id);
      const targets: Array<{ lineId: string; description: string; unit: string; quantity: ReturnType<typeof qty>; unitPrice: ReturnType<typeof money>; discountPct: ReturnType<typeof dec>; taxRatePct: ReturnType<typeof dec> }> = [];

      if (requested) {
        for (const line of requested) {
          const metric = metrics.lines.find((candidate) => candidate.id === line.salesOrderLineId);
          if (!metric) throw new Error("An invoice line does not belong to this sales order.");
          const quantity = qty(line.quantity);
          if (quantity.lte(0)) throw new Error(`Invoice quantity for "${metric.description}" must be positive.`);
          if (quantity.gt(metric.remainingToInvoice)) {
            throw new Error(
              `Only ${metric.remainingToInvoice.toFixed(4)} ${metric.unit} of "${metric.description}" is delivered and not yet invoiced.`,
            );
          }
          const orderLine = await tx.salesOrderLine.findUnique({ where: { id: metric.id } });
          if (!orderLine) throw new Error("Sales order line not found.");
          targets.push({
            lineId: metric.id,
            description: metric.description,
            unit: metric.unit,
            quantity,
            unitPrice: money(orderLine.unitPrice),
            discountPct: dec(orderLine.discountPct),
            taxRatePct: dec(orderLine.taxRatePct),
          });
        }
      } else {
        for (const metric of metrics.lines) {
          if (metric.remainingToInvoice.lte(0)) continue;
          const orderLine = await tx.salesOrderLine.findUnique({ where: { id: metric.id } });
          if (!orderLine) throw new Error("Sales order line not found.");
          targets.push({
            lineId: metric.id,
            description: metric.description,
            unit: metric.unit,
            quantity: metric.remainingToInvoice,
            unitPrice: money(orderLine.unitPrice),
            discountPct: dec(orderLine.discountPct),
            taxRatePct: dec(orderLine.taxRatePct),
          });
        }
      }

      if (targets.length === 0) {
        throw new Error("Nothing delivered is awaiting an invoice. Dispatch or confirm delivery first.");
      }

      const computed = targets.map((line) => ({ line, totals: lineTotals(line) }));
      const subtotal = money(sum(computed.map(({ totals }) => totals.net)));
      const discountTotal = money(sum(computed.map(({ totals }) => totals.discountAmount)));
      const taxAmount = money(sum(computed.map(({ totals }) => totals.taxAmount)));
      const total = money(subtotal.plus(taxAmount));
      const taxRatePct = subtotal.gt(0) ? dec(money(taxAmount.div(subtotal).times(100))) : dec(0);
      const org = await tx.organization.findUnique({ where: { id: order.organizationId } });

      const invoice = await tx.customerInvoice.create({
        data: {
          invoiceNumber,
          idempotencyKey,
          salesOrderId: order.id,
          customerId: order.customerId,
          status: "ISSUED",
          invoiceDate,
          dueDate,
          currency: order.currency,
          subtotal,
          discountTotal,
          taxAmount,
          taxLabel: org?.taxLabel ?? null,
          taxRatePct,
          total,
          deliveryId: input.deliveryId ?? null,
          notes: input.notes?.trim() || null,
          issuedById: input.userId,
          issuedAt: invoiceDate,
          lines: {
            create: computed.map(({ line, totals }) => ({
              salesOrderLineId: line.lineId,
              description: line.description,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              discountPct: line.discountPct,
              discountAmount: totals.discountAmount,
              taxRatePct: line.taxRatePct,
              taxAmount: totals.taxAmount,
              lineTotal: totals.net,
            })),
          },
        },
      });

      await recordOrderEvent(tx, {
        entityType: "CustomerInvoice",
        entityId: invoice.id,
        fromStatus: null,
        toStatus: "ISSUED",
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: `Invoice ${invoiceNumber} issued`,
        meta: { salesOrderId: order.id, currency: order.currency, total: total.toFixed(4) },
      });
      await refreshSalesOrderStatus(tx, order.id, { id: input.userId, label: input.actorLabel });
      return invoice;
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "customer_invoice.issued",
      entityType: "CustomerInvoice",
      entityId: created.id,
      meta: {
        invoiceNumber: created.invoiceNumber,
        salesOrderId: order.id,
        currency: created.currency,
        subtotal: created.subtotal.toFixed(4),
        taxAmount: created.taxAmount.toFixed(4),
        total: created.total.toFixed(4),
        dueDate: created.dueDate?.toISOString() ?? null,
      },
    });
    return { ok: true, invoiceId: created.id, invoiceNumber: created.invoiceNumber, total: toMoneyString(created.total), duplicate: false };
  } catch (error) {
    if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
      const raced = await db.customerInvoice.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: order.organizationId, idempotencyKey } },
      });
      if (raced) {
        return { ok: true, invoiceId: raced.id, invoiceNumber: raced.invoiceNumber, total: toMoneyString(raced.total), duplicate: true };
      }
    }
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
}

export async function customerInvoicesForOrder(salesOrderId: string) {
  return db.customerInvoice.findMany({
    where: { salesOrderId },
    orderBy: { invoiceDate: "desc" },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      allocations: { include: { payment: true } },
    },
  });
}

