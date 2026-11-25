import { db } from "../db";
import { writeAudit } from "../audit";
import { stringifyJson } from "../json";
import { nextNumber } from "../workflow/sequences";
import { dec, lineTotals, money, qty, sum } from "./money";
import { recordOrderEvent } from "./events";
import { initialSalesOrderStatus } from "./state";

/**
 * Customer acceptance → sales order.
 *
 * A sales order is created only from an owner-decided acceptance of one exact
 * customer quotation version. The PO is compared against that version first;
 * any changed commercial term is reported and must be explicitly resolved.
 * Nothing in this module ever mutates a sent quotation.
 */

export type AcceptanceSource = "CUSTOMER_PO" | "EMAIL_ACCEPTANCE" | "OWNER_RECORDED";

export type AcceptanceLineInput = {
  quotationItemId?: string | null;
  description?: string | null;
  specs?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  unitPrice?: number | string | null;
  discountPct?: number | string | null;
  taxRatePct?: number | string | null;
};

export type CustomerAcceptanceInput = {
  quotationId: string;
  customerPoNumber?: string | null;
  customerPoReference?: string | null;
  currency?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  deliveryAddress?: string | null;
  deliveryDate?: Date | string | null;
  conditions?: string | null;
  taxAmount?: number | string | null;
  taxRatePct?: number | string | null;
  lines?: AcceptanceLineInput[];
  source?: AcceptanceSource;
  evidence?: Record<string, unknown>;
  notes?: string | null;
};

export type AcceptanceResolution = {
  decision: "ACCEPT_ORIGINAL" | "APPROVE_REVISED" | "REJECT";
  reason?: string | null;
};

export type DiscrepancyCode =
  | "PRICE"
  | "QUANTITY"
  | "UNIT"
  | "SPEC"
  | "CURRENCY"
  | "TAX"
  | "PAYMENT_TERMS"
  | "DELIVERY_TERMS"
  | "DELIVERY_DATE"
  | "VALIDITY"
  | "CONDITIONS"
  | "MISSING_LINE"
  | "UNKNOWN_LINE";

export type AcceptanceDiscrepancy = {
  code: DiscrepancyCode;
  severity: "BLOCKING" | "WARNING";
  quotationItemId: string | null;
  description: string;
  field: string;
  quoted: string | number | null;
  requested: string | number | null;
  message: string;
};

type QuotationLine = {
  id: string;
  description: string;
  specs: string | null;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  stockQuantity: number;
  procureQuantity: number;
  supplierOfferId: string | null;
  enquiryItemId: string | null;
};

export type QuotationSnapshot = {
  id: string;
  quoteNumber: string;
  version: number;
  currency: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  terms: string | null;
  validityDate: Date | null;
  customerName: string;
  items: QuotationLine[];
};

const normalize = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const text = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

export function quotationTaxRatePct(quotation: Pick<QuotationSnapshot, "subtotal" | "taxAmount">): number {
  if (!quotation.subtotal || quotation.subtotal <= 0) return 0;
  return Math.round((quotation.taxAmount / quotation.subtotal) * 10_000) / 100;
}

/**
 * Deterministic PO-versus-quotation comparison. Product identity is matched by
 * the quoted line id first and by normalized description second; an unmatched
 * PO line is never paired with a different product silently.
 */
export function compareAcceptanceToQuotation(
  quotation: QuotationSnapshot,
  input: CustomerAcceptanceInput,
): { discrepancies: AcceptanceDiscrepancy[]; blocking: AcceptanceDiscrepancy[]; warnings: AcceptanceDiscrepancy[] } {
  const found: AcceptanceDiscrepancy[] = [];
  const effectiveTaxRate = quotationTaxRatePct(quotation);

  const requestedCurrency = text(input.currency)?.toUpperCase() ?? null;
  if (requestedCurrency && requestedCurrency !== quotation.currency.toUpperCase()) {
    found.push({
      code: "CURRENCY",
      severity: "BLOCKING",
      quotationItemId: null,
      description: "Order currency",
      field: "currency",
      quoted: quotation.currency,
      requested: requestedCurrency,
      message: `The customer's document is in ${requestedCurrency} but quotation ${quotation.quoteNumber} is in ${quotation.currency}. No exchange rate is assumed.`,
    });
  }

  if (quotation.validityDate && quotation.validityDate.getTime() < Date.now()) {
    found.push({
      code: "VALIDITY",
      severity: "BLOCKING",
      quotationItemId: null,
      description: "Quotation validity",
      field: "validityDate",
      quoted: quotation.validityDate.toISOString().slice(0, 10),
      requested: null,
      message: "The quotation has expired. Confirm the price is still valid or issue a revised quotation before creating the order.",
    });
  }

  const requestedTax = input.taxAmount != null && String(input.taxAmount).trim() !== "" ? Number(input.taxAmount) : null;
  if (requestedTax != null && Number.isFinite(requestedTax)) {
    const quotedTax = money(quotation.taxAmount);
    if (quotedTax.minus(dec(requestedTax)).abs().gt("0.01")) {
      found.push({
        code: "TAX",
        severity: "BLOCKING",
        quotationItemId: null,
        description: "Tax amount",
        field: "taxAmount",
        quoted: Number(quotedTax.toFixed(2)),
        requested: requestedTax,
        message: `The customer's tax amount (${requestedTax.toFixed(2)}) differs from the quoted tax (${quotedTax.toFixed(2)}). Tax rules are never overwritten automatically.`,
      });
    }
  }

  const requestedTaxRate = input.taxRatePct != null && String(input.taxRatePct).trim() !== "" ? Number(input.taxRatePct) : null;
  if (requestedTaxRate != null && Number.isFinite(requestedTaxRate) && Math.abs(requestedTaxRate - effectiveTaxRate) > 0.0001) {
    found.push({
      code: "TAX",
      severity: "BLOCKING",
      quotationItemId: null,
      description: "Tax rate",
      field: "taxRatePct",
      quoted: effectiveTaxRate,
      requested: requestedTaxRate,
      message: `The customer's tax rate (${requestedTaxRate}%) differs from the quotation's effective rate (${effectiveTaxRate}%).`,
    });
  }

  const requestedPaymentTerms = text(input.paymentTerms);
  if (requestedPaymentTerms && quotation.terms && normalize(requestedPaymentTerms) !== normalize(quotation.terms)) {
    found.push({
      code: "PAYMENT_TERMS",
      severity: "WARNING",
      quotationItemId: null,
      description: "Payment terms",
      field: "paymentTerms",
      quoted: quotation.terms,
      requested: requestedPaymentTerms,
      message: "The customer's payment terms differ from the quotation terms.",
    });
  }

  const requestedDeliveryTerms = text(input.deliveryTerms);
  if (requestedDeliveryTerms && normalize(requestedDeliveryTerms) !== normalize(quotation.terms)) {
    found.push({
      code: "DELIVERY_TERMS",
      severity: "WARNING",
      quotationItemId: null,
      description: "Delivery terms",
      field: "deliveryTerms",
      quoted: quotation.terms,
      requested: requestedDeliveryTerms,
      message: "The customer's delivery terms differ from the quotation. Confirm freight and delivery responsibility.",
    });
  }

  if (text(input.conditions)) {
    found.push({
      code: "CONDITIONS",
      severity: "WARNING",
      quotationItemId: null,
      description: "Additional conditions",
      field: "conditions",
      quoted: null,
      requested: text(input.conditions),
      message: "The customer added conditions that were not part of the quotation; review them before confirming the order.",
    });
  }

  const requestedLines = (input.lines ?? []).filter(
    (line) =>
      text(line.quotationItemId) ||
      text(line.description) ||
      (line.quantity != null && String(line.quantity).trim() !== "") ||
      (line.unitPrice != null && String(line.unitPrice).trim() !== ""),
  );
  if (requestedLines.length === 0) {
    return { discrepancies: found, blocking: found.filter((item) => item.severity === "BLOCKING"), warnings: found.filter((item) => item.severity === "WARNING") };
  }

  const matchedQuotationIds = new Set<string>();
  for (const line of requestedLines) {
    const byId = line.quotationItemId ? quotation.items.find((item) => item.id === line.quotationItemId) : undefined;
    const byDescription = !byId && text(line.description)
      ? quotation.items.find((item) => normalize(item.description) === normalize(text(line.description)))
      : undefined;
    const quotedLine = byId ?? byDescription;
    if (!quotedLine) {
      found.push({
        code: "UNKNOWN_LINE",
        severity: "BLOCKING",
        quotationItemId: null,
        description: text(line.description) ?? "Unnamed line",
        field: "description",
        quoted: null,
        requested: text(line.description),
        message: `"${text(line.description) ?? "Unnamed line"}" is not a line of quotation ${quotation.quoteNumber}. It cannot be added to the order automatically.`,
      });
      continue;
    }
    matchedQuotationIds.add(quotedLine.id);

    const requestedQty = line.quantity != null && String(line.quantity).trim() !== "" ? Number(line.quantity) : quotedLine.quantity;
    if (Number.isFinite(requestedQty) && Math.abs(requestedQty - quotedLine.quantity) > 0.0001) {
      found.push({
        code: "QUANTITY",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "quantity",
        quoted: quotedLine.quantity,
        requested: requestedQty,
        message: `Quantity changed from ${quotedLine.quantity} to ${requestedQty} ${quotedLine.unit}.`,
      });
    }

    const requestedUnit = text(line.unit);
    if (requestedUnit && normalize(requestedUnit) !== normalize(quotedLine.unit)) {
      found.push({
        code: "UNIT",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "unit",
        quoted: quotedLine.unit,
        requested: requestedUnit,
        message: `Unit changed from ${quotedLine.unit} to ${requestedUnit}; quantities are not converted without an explicit packaging factor.`,
      });
    }

    const requestedPrice = line.unitPrice != null && String(line.unitPrice).trim() !== "" ? Number(line.unitPrice) : quotedLine.unitPrice;
    if (requestedPrice != null && (quotedLine.unitPrice == null || Math.abs(requestedPrice - quotedLine.unitPrice) > 0.005)) {
      found.push({
        code: "PRICE",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "unitPrice",
        quoted: quotedLine.unitPrice,
        requested: requestedPrice,
        message: `Unit price changed from ${quotedLine.unitPrice ?? "unpriced"} to ${requestedPrice}.`,
      });
    }

    const requestedDiscount = line.discountPct != null && String(line.discountPct).trim() !== "" ? Number(line.discountPct) : 0;
    if (Number.isFinite(requestedDiscount) && Math.abs(requestedDiscount) > 0.0001) {
      found.push({
        code: "PRICE",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "discountPct",
        quoted: 0,
        requested: requestedDiscount,
        message: `The customer's document asks for a ${requestedDiscount}% discount that was not in the quotation.`,
      });
    }

    const requestedLineTax = line.taxRatePct != null && String(line.taxRatePct).trim() !== "" ? Number(line.taxRatePct) : null;
    if (requestedLineTax != null && Number.isFinite(requestedLineTax) && Math.abs(requestedLineTax - effectiveTaxRate) > 0.0001) {
      found.push({
        code: "TAX",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "taxRatePct",
        quoted: effectiveTaxRate,
        requested: requestedLineTax,
        message: `The line tax rate (${requestedLineTax}%) differs from the quoted rate (${effectiveTaxRate}%).`,
      });
    }

    const requestedSpecs = text(line.specs);
    if (requestedSpecs && quotedLine.specs && normalize(requestedSpecs) !== normalize(quotedLine.specs)) {
      found.push({
        code: "SPEC",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "specs",
        quoted: quotedLine.specs,
        requested: requestedSpecs,
        message: "The technical specification differs from the quoted specification.",
      });
    }

    if (text(line.description) && normalize(text(line.description)) !== normalize(quotedLine.description)) {
      found.push({
        code: "SPEC",
        severity: "BLOCKING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "description",
        quoted: quotedLine.description,
        requested: text(line.description),
        message: "The customer's product description does not match the quoted product.",
      });
    }
  }

  for (const quotedLine of quotation.items) {
    if (!matchedQuotationIds.has(quotedLine.id)) {
      found.push({
        code: "MISSING_LINE",
        severity: "WARNING",
        quotationItemId: quotedLine.id,
        description: quotedLine.description,
        field: "quantity",
        quoted: quotedLine.quantity,
        requested: 0,
        message: `Quotation line "${quotedLine.description}" is missing from the customer's document (partial acceptance).`,
      });
    }
  }

  return {
    discrepancies: found,
    blocking: found.filter((item) => item.severity === "BLOCKING"),
    warnings: found.filter((item) => item.severity === "WARNING"),
  };
}

export type SalesOrderCreationResult =
  | { ok: true; salesOrderId: string; orderNumber: string; duplicate: boolean }
  | { ok: false; error: string; code?: "DISCREPANCY"; discrepancies?: AcceptanceDiscrepancy[] };

type AcceptedLine = {
  quotationItem: QuotationLine | null;
  description: string;
  specs: string | null;
  quantity: ReturnType<typeof qty>;
  unit: string;
  unitPrice: ReturnType<typeof money>;
  discountPct: ReturnType<typeof dec>;
  taxRatePct: ReturnType<typeof dec>;
  stockQuantity: ReturnType<typeof qty>;
  procureQuantity: ReturnType<typeof qty>;
  offerId: string | null;
  enquiryItemId: string | null;
};

function resolveAcceptedLines(input: {
  quotation: QuotationSnapshot;
  acceptance: CustomerAcceptanceInput;
  decision: "ACCEPT_ORIGINAL" | "APPROVE_REVISED" | null;
  effectiveTaxRate: number;
}): { lines: AcceptedLine[] } | { error: string } {
  const { quotation, acceptance, decision } = input;
  const taxRate = acceptance.taxRatePct != null && String(acceptance.taxRatePct).trim() !== ""
    ? dec(acceptance.taxRatePct)
    : dec(input.effectiveTaxRate);
  const requested = (acceptance.lines ?? []).filter(
    (line) => text(line.quotationItemId) || text(line.description) || (line.quantity != null && String(line.quantity).trim() !== ""),
  );

  if (decision !== "APPROVE_REVISED" || requested.length === 0) {
    const lines: AcceptedLine[] = [];
    for (const item of quotation.items) {
      if (item.unitPrice == null) {
        return { error: `Quotation line "${item.description}" has no price and cannot be ordered.` };
      }
      const quantity = qty(item.quantity);
      const stockCandidate = Math.min(Number(item.stockQuantity ?? 0), Number(quantity.toString()));
      const stockQuantity = qty(Math.max(0, stockCandidate));
      lines.push({
        quotationItem: item,
        description: item.description,
        specs: item.specs,
        quantity,
        unit: item.unit,
        unitPrice: money(item.unitPrice),
        discountPct: dec(0),
        taxRatePct: taxRate,
        stockQuantity,
        procureQuantity: qty(quantity.minus(stockQuantity)),
        offerId: item.supplierOfferId,
        enquiryItemId: item.enquiryItemId,
      });
    }
    if (lines.length === 0) return { error: "This quotation has no lines to order." };
    return { lines };
  }

  const lines: AcceptedLine[] = [];
  for (const line of requested) {
    const quotedLine =
      (line.quotationItemId ? quotation.items.find((item) => item.id === line.quotationItemId) : undefined) ??
      (text(line.description)
        ? quotation.items.find((item) => normalize(item.description) === normalize(text(line.description)))
        : undefined) ??
      null;
    const quantity = qty(line.quantity != null && String(line.quantity).trim() !== "" ? Number(line.quantity) : quotedLine?.quantity ?? 0);
    if (quantity.lte(0)) return { error: `A revised line must have a positive quantity (${text(line.description) ?? "unnamed line"}).` };
    const unitPrice = money(
      line.unitPrice != null && String(line.unitPrice).trim() !== "" ? Number(line.unitPrice) : quotedLine?.unitPrice ?? 0,
    );
    if (unitPrice.lte(0)) return { error: `A revised line must have a positive unit price (${text(line.description) ?? "unnamed line"}).` };
    const quotedStock = quotedLine ? Number(quotedLine.stockQuantity ?? 0) : 0;
    const stockQuantity = qty(Math.max(0, Math.min(quotedStock, Number(quantity.toString()))));
    lines.push({
      quotationItem: quotedLine,
      description: text(line.description) ?? quotedLine?.description ?? "Revised line",
      specs: text(line.specs) ?? quotedLine?.specs ?? null,
      quantity,
      unit: text(line.unit) ?? quotedLine?.unit ?? "pcs",
      unitPrice,
      discountPct: dec(line.discountPct ?? 0),
      taxRatePct: line.taxRatePct != null && String(line.taxRatePct).trim() !== "" ? dec(line.taxRatePct) : taxRate,
      stockQuantity,
      procureQuantity: qty(quantity.minus(stockQuantity)),
      offerId: quotedLine?.supplierOfferId ?? null,
      enquiryItemId: quotedLine?.enquiryItemId ?? null,
    });
  }
  if (lines.length === 0) return { error: "A revised acceptance must contain at least one line." };
  return { lines };
}

async function loadQuotationSnapshot(quotationId: string): Promise<QuotationSnapshot | null> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });
  if (!quotation) return null;
  return {
    id: quotation.id,
    quoteNumber: quotation.quoteNumber,
    version: quotation.version,
    currency: quotation.currency,
    status: quotation.status,
    subtotal: quotation.subtotal,
    taxAmount: quotation.taxAmount,
    total: quotation.total,
    terms: quotation.terms,
    validityDate: quotation.validityDate,
    customerName: quotation.customerName,
    items: quotation.items.map((item) => ({
      id: item.id,
      description: item.description,
      specs: item.specs,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      stockQuantity: item.stockQuantity,
      procureQuantity: item.procureQuantity,
      supplierOfferId: item.supplierOfferId,
      enquiryItemId: item.enquiryItemId,
    })),
  };
}

/** Read-only comparison used by the owner review screen before any record is written. */
export async function previewCustomerAcceptance(input: CustomerAcceptanceInput) {
  const quotation = await loadQuotationSnapshot(input.quotationId);
  if (!quotation) return { ok: false as const, error: "Quotation not found." };
  const comparison = compareAcceptanceToQuotation(quotation, input);
  return { ok: true as const, quotation, ...comparison };
}

/**
 * Creates one sales order for an exact quotation version.
 *
 * Idempotent by (organizationId, quotation version): replaying the same customer
 * acceptance returns the existing order. Approved terms are an immutable
 * snapshot, and a revision produces a separate record rather than an edit.
 */
export async function createSalesOrderFromAcceptance(
  input: CustomerAcceptanceInput & {
    userId: string;
    actorLabel: string;
    resolution?: AcceptanceResolution | null;
    idempotencyKey?: string | null;
  },
): Promise<SalesOrderCreationResult> {
  const quotation = await loadQuotationSnapshot(input.quotationId);
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (!["APPROVED", "SENT"].includes(quotation.status)) {
    return { ok: false, error: "The quotation must be approved before a sales order can be created." };
  }

  const organizationId = await db.customerQuotation
    .findUnique({ where: { id: quotation.id }, select: { organizationId: true } })
    .then((row) => row?.organizationId ?? null);
  if (!organizationId) return { ok: false, error: "Quotation not found." };

  const idempotencyKey = input.idempotencyKey?.trim() || `quotation:${quotation.id}:v${quotation.version}`;
  const existing = await db.salesOrder.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    select: { id: true, orderNumber: true },
  });
  if (existing) return { ok: true, salesOrderId: existing.id, orderNumber: existing.orderNumber, duplicate: true };

  const decision = input.resolution?.decision ?? null;
  if (decision === "REJECT") return { ok: false, error: "The customer's document was rejected; no sales order was created." };

  const comparison = compareAcceptanceToQuotation(quotation, input);
  const revised = decision === "APPROVE_REVISED";
  const blocking = revised ? [] : comparison.blocking;
  const hasPartialAcceptance = comparison.warnings.some((item) => item.code === "MISSING_LINE");

  if (blocking.length > 0) {
    return {
      ok: false,
      code: "DISCREPANCY",
      error: `The customer's document differs from quotation ${quotation.quoteNumber} in ${blocking.length} place(s). Review each difference and record an explicit decision.`,
      discrepancies: blocking,
    };
  }
  if (!decision && hasPartialAcceptance) {
    return {
      ok: false,
      code: "DISCREPANCY",
      error: "The customer's document covers only part of the quotation. Confirm a revised agreement with a recorded reason, or reject it.",
      discrepancies: comparison.warnings,
    };
  }
  if (revised && !input.resolution?.reason?.trim()) {
    return { ok: false, error: "Record why you are accepting the customer's revised terms; the reason is kept in the audit trail." };
  }

  const resolved = resolveAcceptedLines({
    quotation,
    acceptance: input,
    decision,
    effectiveTaxRate: quotationTaxRatePct(quotation),
  });
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const acceptedLines = resolved.lines;

  // Link each ordered line to the product master the inventory check matched.
  // Without this link a goods receipt could not post stock against the order.
  const matchedProducts = new Map<string, string>();
  const matchedIds = [...new Set(acceptedLines.map((line) => line.enquiryItemId).filter((id): id is string => Boolean(id)))];
  if (matchedIds.length > 0) {
    const rows = await db.enquiryItem.findMany({
      where: { id: { in: matchedIds } },
      select: { id: true, matchedProductId: true },
    });
    for (const row of rows) {
      if (row.matchedProductId) matchedProducts.set(row.id, row.matchedProductId);
    }
  }

  const currency = (text(input.currency) ?? quotation.currency).toUpperCase();
  const computed = acceptedLines.map((line) => ({ line, totals: lineTotals(line) }));
  const subtotal = money(sum(computed.map(({ totals }) => totals.net)));
  const taxAmount = money(sum(computed.map(({ totals }) => totals.taxAmount)));
  const total = money(subtotal.plus(taxAmount));
  const allFromStock = acceptedLines.every((line) => line.procureQuantity.lte(0));

  const source = input.source ?? "CUSTOMER_PO";
  const evidence = {
    ...(input.evidence ?? {}),
    quotationNumber: quotation.quoteNumber,
    quotationVersion: quotation.version,
    quotationTotal: quotation.total,
    quotationCurrency: quotation.currency,
    requestedCurrency: text(input.currency),
    conditions: text(input.conditions),
    linesProvided: (input.lines ?? []).length,
  };
  const resolutionJson = stringifyJson({
    decision,
    reason: input.resolution?.reason?.trim() ?? null,
    discrepancies: comparison.discrepancies,
  });

  const acceptedAt = new Date();
  const deliveryDate =
    input.deliveryDate == null || String(input.deliveryDate).trim() === ""
      ? null
      : new Date(input.deliveryDate);

  let orderNumber = "";
  try {
    orderNumber = await nextNumber("SO");
    const created = await db.$transaction(async (tx) => {
      const order = await tx.salesOrder.create({
        data: {
          orderNumber,
          idempotencyKey,
          status: initialSalesOrderStatus({ allFromStock }),
          enquiryId: (
            await tx.customerQuotation.findUnique({ where: { id: quotation.id }, select: { enquiryId: true } })
          )?.enquiryId ?? null,
          quotationId: quotation.id,
          quotationVersion: quotation.version,
          customerName: quotation.customerName,
          customerEmail: (
            await tx.customerQuotation.findUnique({ where: { id: quotation.id }, select: { customerEmail: true } })
          )?.customerEmail ?? null,
          customerPhone: (
            await tx.customerQuotation.findUnique({ where: { id: quotation.id }, select: { customerPhone: true } })
          )?.customerPhone ?? null,
          customerId: (
            await tx.customerQuotation.findUnique({ where: { id: quotation.id }, select: { customerId: true } })
          )?.customerId ?? null,
          customerPoNumber: text(input.customerPoNumber),
          customerPoReference: text(input.customerPoReference),
          acceptanceSource: source,
          acceptanceEvidenceJson: stringifyJson(evidence),
          resolutionJson,
          acceptedAt,
          acceptedById: input.userId,
          currency,
          subtotal,
          taxAmount,
          total,
          paymentTerms: text(input.paymentTerms) ?? quotation.terms,
          deliveryTerms: text(input.deliveryTerms),
          deliveryAddress: text(input.deliveryAddress),
          agreedDeliveryDate: deliveryDate && !Number.isNaN(deliveryDate.getTime()) ? deliveryDate : null,
          notes: text(input.notes),
          lines: {
            create: computed.map(({ line, totals }, index) => ({
              lineNo: index + 1,
              enquiryItemId: line.enquiryItemId ?? null,
              productId: line.enquiryItemId ? (matchedProducts.get(line.enquiryItemId) ?? null) : null,
              customerQuotationItemId: line.quotationItem?.id ?? null,
              supplierOfferId: line.offerId ?? null,
              description: line.description,
              specs: line.specs,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              discountPct: line.discountPct,
              discountAmount: totals.discountAmount,
              taxRatePct: line.taxRatePct,
              taxAmount: totals.taxAmount,
              lineTotal: totals.net,
              stockQuantity: line.stockQuantity,
              procureQuantity: line.procureQuantity,
            })),
          },
        },
      });

      await tx.customerQuotation.update({
        where: { id: quotation.id },
        data: { outcome: "WON", outcomeAt: acceptedAt, outcomeReason: input.resolution?.reason?.trim() || "Customer accepted; sales order created." },
      });
      if (order.enquiryId) {
        await tx.enquiry.update({ where: { id: order.enquiryId }, data: { status: "QUOTED" } });
      }
      // Quotation-level holds become commitments for this order; the reserved
      // quantity itself does not change, so stock is never double-counted.
      await tx.stockReservation.updateMany({
        where: { quotationId: quotation.id, status: "ACTIVE" },
        data: { status: "COMMITTED" },
      });

      for (const discrepancy of comparison.discrepancies) {
        await tx.orderDiscrepancy.create({
          data: {
            entityType: "SalesOrder",
            entityId: order.id,
            salesOrderId: order.id,
            code: discrepancy.code,
            severity: discrepancy.severity,
            status: "RESOLVED",
            detailJson: stringifyJson(discrepancy),
            note: discrepancy.message,
            resolvedById: input.userId,
            resolvedAt: acceptedAt,
            resolutionNote:
              decision === "APPROVE_REVISED"
                ? `Customer revision approved: ${input.resolution?.reason?.trim()}`
                : "Customer change not accepted; the original quotation terms were used.",
          },
        });
      }

      await recordOrderEvent(tx, {
        entityType: "SalesOrder",
        entityId: order.id,
        fromStatus: null,
        toStatus: order.status,
        actorId: input.userId,
        actorLabel: input.actorLabel,
        reason: decision === "APPROVE_REVISED" ? "Customer revised terms approved" : "Customer accepted the quotation",
        meta: { quotationId: quotation.id, quotationVersion: quotation.version, source, currency },
      });
      return order;
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "sales_order.created",
      entityType: "SalesOrder",
      entityId: created.id,
      meta: {
        orderNumber: created.orderNumber,
        quotationId: quotation.id,
        quotationVersion: quotation.version,
        currency,
        subtotal: subtotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: total.toFixed(2),
        decision,
        source,
        discrepancies: comparison.discrepancies.length,
      },
    });
    return { ok: true, salesOrderId: created.id, orderNumber: created.orderNumber, duplicate: false };
  } catch (error) {
    if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") {
      const raced = await db.salesOrder.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
        select: { id: true, orderNumber: true },
      });
      if (raced) return { ok: true, salesOrderId: raced.id, orderNumber: raced.orderNumber, duplicate: true };
    }
    throw error;
  }
}

/** Approved/sent quotations that do not yet have a sales order. */
export async function quotationsAwaitingAcceptance() {
  return db.customerQuotation.findMany({
    where: { status: { in: ["APPROVED", "SENT"] }, salesOrders: { none: {} } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { items: { select: { id: true, description: true, quantity: true } }, customer: true },
  });
}
