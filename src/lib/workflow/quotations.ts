import { db } from "../db";
import { getCurrentOrganization } from "../organization";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { resolvePricingRule, sellingPriceFromCost } from "../pricing/rules";
import { buildSpecSummary } from "../catalog/normalize";
import { generateQuotationPdf } from "../pdf/quote";
import { buildQuoteTerms } from "../pdf/terms";
import { money } from "../costing/landed";
import { marginPct } from "../pricing/rules";
import { nextQuoteNumber } from "./sequences";
import { saveBuffer, readBuffer } from "../storage";
import { requireTenantId } from "../tenant";
import { sendEmail } from "../email/send";
import { sendWhatsAppDocument, sendWhatsAppText } from "../intake/whatsapp";
import { env, isDemoMode } from "../env";
import { outboundOperationKey, sendOutboundOnce } from "../outbound/messages";
import { correlationReference, correlationTokenFor } from "../orders/tokens";

const round2 = (value: number) => Math.round(value * 100) / 100;

type LineDraft = {
  enquiryItemId: string;
  description: string;
  specs: string;
  quantity: number;
  unit: string;
  costPrice: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  priceStatus: "PRICED" | "UNPRICED";
  costStatus: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  pricingSource: string | null;
  stockQuantity: number;
  procureQuantity: number;
  stockUnitCost: number | null;
  procureUnitCost: number | null;
  costIncomplete: boolean;
  supplierOfferId: string | null;
  leadTimeDays: number | null;
  deliveryTerms: string | null;
  deliveryLocation: string | null;
  validityDate: Date | null;
};

type LandedSnapshot = {
  landed?: {
    total?: number | null;
    effectiveQuantity?: number;
    requestedQuantity?: number;
    complete?: boolean;
    missing?: string[];
    excessQuantity?: number;
  };
  evaluation?: { rank?: number | null; eligible?: boolean; rankable?: boolean };
};

/**
 * Builds a customer quotation draft from owner-approved sourcing decisions.
 *
 * Rules that prevent a misleading quote:
 *  - a line is only priced from a *complete* landed cost plus a configured
 *    pricing rule; an incomplete cost never falls back to the raw unit price;
 *  - an unknown cost produces no price at all (never a silent zero);
 *  - stock and procured quantities are recorded separately, and an unknown
 *    stock acquisition cost keeps the internal cost total marked incomplete.
 *
 * The draft is explicitly not sendable: acceptance requires a separate approval.
 */
export async function createQuotationDraft(input: {
  enquiryId: string;
  userId: string;
  actorLabel: string;
  notes?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  deliveryAddress?: string | null;
}): Promise<{ ok: true; quotationId: string; unpriced: string[]; complianceWarnings: string[] } | { ok: false; error: string }> {
  const enquiry = await db.enquiry.findUnique({
    where: { id: input.enquiryId },
    include: {
      items: { include: { offers: true } },
      quotations: { orderBy: { version: "desc" }, include: { items: true } },
      customer: true,
    },
  });
  if (!enquiry) return { ok: false, error: "Enquiry not found." };
  if (enquiry.items.length === 0) return { ok: false, error: "There are no products to quote." };

  const existing = enquiry.quotations.find((q) => q.status === "DRAFT" || q.status === "AWAITING_APPROVAL");
  if (existing) return { ok: true, quotationId: existing.id, unpriced: [], complianceWarnings: [] };

  const org = await getCurrentOrganization();
  const rules = await db.pricingRule.findMany();
  let customer = enquiry.customer;
  if (!customer && enquiry.customerName?.trim()) {
    customer = await db.customer.findFirst({
      where: enquiry.customerEmail
        ? { OR: [{ email: { equals: enquiry.customerEmail, mode: "insensitive" } }, { name: enquiry.customerName }] }
        : { name: enquiry.customerName },
    });
    if (!customer) {
      customer = await db.customer.create({
        data: { name: enquiry.customerName, email: enquiry.customerEmail, phone: enquiry.customerPhone },
      });
    }
    await db.enquiry.update({ where: { id: enquiry.id }, data: { customerId: customer.id } });
  }
  const currency = (enquiry.currency || org?.defaultCurrency || "AED").toUpperCase();

  const unpriced: string[] = [];
  const complianceWarnings: string[] = [];
  const lineDrafts: LineDraft[] = [];

  for (const item of enquiry.items) {
    const offer = item.offers.find((candidate) => candidate.id === item.approvedOfferId) ?? null;
    const stockQuantity = Math.max(0, item.quantityFromStock);
    const procureQuantity = Math.max(0, item.quantityToSource);
    const quantity = item.quantity > 0 ? item.quantity : stockQuantity + procureQuantity;

    let procureUnitCost: number | null = null;
    let costStatus: LineDraft["costStatus"] = "UNKNOWN";

    if (offer) {
      const snapshot = parseJson<LandedSnapshot>(offer.landedCostJson, {});
      const landed = snapshot.landed;
      const complete = Boolean(landed?.complete) && landed?.total != null;
      const perUnit =
        complete && landed?.total != null && (landed.requestedQuantity ?? 0) > 0
          ? round2(landed.total / (landed.requestedQuantity as number))
          : null;
      procureUnitCost = perUnit;
      costStatus = complete ? "COMPLETE" : "PARTIAL";
    }

    if (procureQuantity === 0 && stockQuantity > 0) {
      costStatus = "UNKNOWN"; // stock acquisition cost is not recorded
    }

    // Stock has no recorded acquisition cost, so any line that ships from stock
    // cannot be treated as a fully costed line.
    const stockCostKnown = stockQuantity === 0;
    if (!stockCostKnown) costStatus = costStatus === "COMPLETE" ? "PARTIAL" : costStatus;

    const unitCost =
      procureUnitCost != null && quantity > 0
        ? round2((procureUnitCost * procureQuantity) / quantity)
        : null;

    // Chemical lines need an SDS/MSDS on file. This is a checklist warning for the
    // owner, not a compliance claim and never a reason to hide the line.
    if (item.category === "Chemicals") {
      const spec = parseJson<Record<string, unknown>>(item.industrialSpecJson, {});
      const hasSds = Boolean(String(spec.sds ?? "").trim());
      if (!hasSds) {
        complianceWarnings.push(`${item.description}: SDS/MSDS not stated by the customer. Confirm safety data before supply.`);
      }
    }

    const rule = resolvePricingRule(rules, item.category, customer?.tier ?? "STANDARD");
    const price = sellingPriceFromCost(unitCost, rule, null);
    if (price == null) unpriced.push(item.description);

    lineDrafts.push({
      enquiryItemId: item.id,
      description: item.description,
      specs: buildSpecSummary({
        description: item.description,
        size: item.size,
        material: item.material,
        grade: item.grade,
        pressureRating: item.pressureRating,
        schedule: item.schedule,
        standard: item.standard,
        brand: item.brand,
      }),
      quantity,
      unit: item.unit,
      costPrice: unitCost,
      unitPrice: price,
      lineTotal: price != null ? round2(price * quantity) : null,
      priceStatus: price != null ? "PRICED" : "UNPRICED",
      costStatus,
      pricingSource: price != null ? "RULE" : null,
      stockQuantity,
      procureQuantity,
      stockUnitCost: null,
      procureUnitCost,
      costIncomplete: costStatus !== "COMPLETE" || offer == null,
      supplierOfferId: offer?.id ?? null,
      leadTimeDays: offer?.leadTimeDays ?? null,
      // A supplier's named delivery place is not an Incoterm. Keep it separate.
      deliveryTerms: null,
      deliveryLocation: offer?.deliveryLocation ?? null,
      validityDate: offer?.validityDate ?? null,
    });
  }

  const pricedLines = lineDrafts.filter((line) => line.priceStatus === "PRICED");
  const subtotal = round2(pricedLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0));
  const taxAmount = org?.taxEnabled ? round2(subtotal * ((org.taxRatePct ?? 0) / 100)) : 0;
  const total = round2(subtotal + taxAmount);
  const internalCostComplete = lineDrafts.every((line) => !line.costIncomplete) && lineDrafts.length > 0;
  const internalCost = internalCostComplete
    ? round2(lineDrafts.reduce((sum, line) => sum + (line.costPrice ?? 0) * line.quantity, 0))
    : null;

  const version = (enquiry.quotations[0]?.version ?? 0) + 1;
  const previous = enquiry.quotations[0] ?? null;
  const changeSummary = previous
    ? [
        `Revision from v${previous.version} to v${version}.`,
        `Total ${previous.currency} ${previous.total.toFixed(2)} → ${currency} ${total.toFixed(2)}.`,
        ...lineDrafts
          .filter((line) => {
            const old = previous.items?.find((item) => item.enquiryItemId === line.enquiryItemId);
            return old && (old.unitPrice !== line.unitPrice || old.quantity !== line.quantity || old.description !== line.description);
          })
          .map((line) => {
            const old = previous.items?.find((item) => item.enquiryItemId === line.enquiryItemId);
            return `${line.description}: ${old?.unitPrice ?? "unpriced"} → ${line.unitPrice ?? "unpriced"}.`;
          }),
        ...lineDrafts
          .filter((line) => !previous.items?.some((item) => item.enquiryItemId === line.enquiryItemId))
          .map((line) => `Added ${line.description}.`),
      ].join(" ")
    : "Initial quotation version.";
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      customerId: customer?.id ?? null,
      quoteNumber: await nextQuoteNumber(org?.quotationPrefix || "QT"),
      version,
      customerName: enquiry.customerName ?? "Customer",
      customerPhone: enquiry.customerPhone,
      customerEmail: enquiry.customerEmail,
      currency,
      subtotal,
      taxAmount,
      total,
      internalCostTotal: internalCost,
      internalCostComplete,
      terms: buildQuoteTerms(org),
      paymentTerms: input.paymentTerms?.trim() || null,
      deliveryTerms: input.deliveryTerms?.trim() || null,
      deliveryAddress: input.deliveryAddress?.trim() || null,
      // Only text the owner explicitly enters as customer-facing notes is printed.
      // Internal pricing warnings stay in the approval payload and audit trail.
      notes: input.notes?.trim() || null,
      validityDate: new Date(Date.now() + (org?.quotationValidityDays ?? 14) * 24 * 60 * 60 * 1000),
      status: "AWAITING_APPROVAL",
      changeSummary,
      isDemo: enquiry.isDemo,
      items: { create: lineDrafts },
    },
  });

  await db.approval.create({
    data: {
      type: "CUSTOMER_QUOTATION",
      entityType: "CustomerQuotation",
      entityId: quotation.id,
      enquiryId: enquiry.id,
      status: "PENDING",
      requestedBy: "SYSTEM",
      payloadJson: stringifyJson({
        quoteNumber: quotation.quoteNumber,
        total,
        currency,
        unpriced,
        allPriced: unpriced.length === 0,
        complianceWarnings,
      }),
    },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.draft_created",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { total, currency, unpriced, internalCostComplete, complianceWarnings },
  });

  await notifyOwner({
    type: "QUOTATION_APPROVAL",
    title: unpriced.length > 0 ? "A quotation draft still needs prices" : "A customer quotation is ready for approval",
    body:
      unpriced.length > 0
        ? `${quotation.quoteNumber} — ${unpriced.length} line(s) unpriced.`
        : `${quotation.quoteNumber} — ${money(total, currency)}`,
    link: `/quotations/${quotation.id}`,
  });

  return { ok: true, quotationId: quotation.id, unpriced, complianceWarnings };
}

export function marginFloorProblem(input: {
  quotation: { internalCostComplete: boolean; internalCostTotal: number | null; subtotal: number };
  minMarginPct: number;
  exceptionReason: string | null;
}): string | null {
  if (input.minMarginPct <= 0 || !input.quotation.internalCostComplete || input.quotation.internalCostTotal == null) return null;
  const actual = marginPct(input.quotation.internalCostTotal, input.quotation.subtotal);
  if (actual == null || actual >= input.minMarginPct) return null;
  if (input.exceptionReason?.trim()) return null;
  return `This quotation's margin (${actual.toFixed(1)}%) is below the ${input.minMarginPct}% floor. Record an owner margin exception before creating or sending the PDF.`;
}

export async function updateQuotationLineTechnical(input: {
  quotationId: string;
  itemId: string;
  countryOfOrigin?: string | null;
  certification?: string | null;
  leadTimeDays?: number | null;
  deliveryTerms?: string | null;
  validityDate?: Date | null;
  technicalNotes?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({ where: { id: input.quotationId } });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "DRAFT" && quotation.status !== "AWAITING_APPROVAL") {
    return { ok: false, error: "Technical terms can only be edited before approval. Create a new revision instead." };
  }
  if (input.leadTimeDays != null && (!Number.isFinite(input.leadTimeDays) || input.leadTimeDays < 0)) {
    return { ok: false, error: "Lead time must be zero days or more." };
  }
  await db.customerQuotationItem.update({
    where: { id: input.itemId },
    data: {
      countryOfOrigin: input.countryOfOrigin?.trim() || null,
      certification: input.certification?.trim() || null,
      leadTimeDays: input.leadTimeDays != null ? Math.round(input.leadTimeDays) : null,
      deliveryTerms: input.deliveryTerms?.trim() || null,
      validityDate: input.validityDate ?? null,
      technicalNotes: input.technicalNotes?.trim() || null,
    },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.technical_updated",
    entityType: "CustomerQuotationItem",
    entityId: input.itemId,
    meta: { quotationId: input.quotationId },
  });
  return { ok: true };
}

export async function updateQuotationCommercialTerms(input: {
  quotationId: string;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  deliveryAddress?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({ where: { id: input.quotationId } });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "DRAFT" && quotation.status !== "AWAITING_APPROVAL") {
    return { ok: false, error: "Commercial terms can only be changed before approval. Create a new revision instead." };
  }
  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: {
      paymentTerms: input.paymentTerms?.trim() || null,
      deliveryTerms: input.deliveryTerms?.trim() || null,
      deliveryAddress: input.deliveryAddress?.trim() || null,
    },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.commercial_terms_updated",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: {
      paymentTerms: input.paymentTerms?.trim() || null,
      deliveryTerms: input.deliveryTerms?.trim() || null,
      deliveryAddress: input.deliveryAddress?.trim() || null,
    },
  });
  return { ok: true };
}

export async function setQuotationOutcome(input: {
  quotationId: string;
  outcome: string;
  reason?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const allowed = new Set(["WON", "LOST", "NO_RESPONSE"]);
  if (!allowed.has(input.outcome)) return { ok: false, error: "Choose won, lost or no response." };
  const quotation = await db.customerQuotation.findUnique({ where: { id: input.quotationId } });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (!["SENT", "APPROVED"].includes(quotation.status)) {
    return { ok: false, error: "Outcome can be recorded after the quotation is approved and sent." };
  }
  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: { outcome: input.outcome, outcomeReason: input.reason?.trim() || null, outcomeAt: new Date() },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.outcome_recorded",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { outcome: input.outcome, reason: input.reason ?? null },
  });
  return { ok: true };
}

async function recalculateTotals(quotationId: string) {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });
  if (!quotation) return null;
  const org = await getCurrentOrganization();
  const subtotal = round2(
    quotation.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0),
  );
  const taxAmount = org?.taxEnabled ? round2(subtotal * ((org.taxRatePct ?? 0) / 100)) : 0;
  const internalCostComplete = quotation.items.every((item) => !item.costIncomplete);
  const internalCost = internalCostComplete
    ? round2(quotation.items.reduce((sum, item) => sum + (item.costPrice ?? 0) * item.quantity, 0))
    : null;
  return db.customerQuotation.update({
    where: { id: quotationId },
    data: {
      subtotal,
      taxAmount,
      total: round2(subtotal + taxAmount),
      internalCostTotal: internalCost,
      internalCostComplete,
    },
  });
}

/** Owner prices (or overrides) a single line. The reason is mandatory and audited. */
export async function updateQuotationLinePrice(input: {
  quotationId: string;
  itemId: string;
  unitPrice: number | null;
  reason?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: input.quotationId },
    include: { items: true },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "DRAFT" && quotation.status !== "AWAITING_APPROVAL") {
    return { ok: false, error: "This quotation can no longer be edited. Create a new version instead." };
  }

  const line = quotation.items.find((item) => item.id === input.itemId);
  if (!line) return { ok: false, error: "Quotation line not found." };

  const price = input.unitPrice;
  if (price != null && (!Number.isFinite(price) || price < 0)) {
    return { ok: false, error: "Enter a valid price." };
  }

  const isOverride = line.unitPrice != null || price == null;
  if (isOverride && !input.reason?.trim()) {
    return { ok: false, error: "Record why you are changing this price — the reason is kept in the audit trail." };
  }

  const lineTotal = price != null ? round2(price * line.quantity) : null;
  await db.customerQuotationItem.update({
    where: { id: line.id },
    data: {
      unitPrice: price,
      lineTotal,
      priceStatus: price != null ? "PRICED" : "UNPRICED",
      pricingSource: price != null ? "OWNER_OVERRIDE" : null,
      overrideReason: input.reason?.trim() ?? null,
      overrideById: input.userId,
      overrideAt: new Date(),
    },
  });

  await recalculateTotals(quotation.id);

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: price == null ? "quotation.line_unpriced" : "quotation.price_set",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: {
      lineId: line.id,
      previousPrice: line.unitPrice,
      unitPrice: price,
      reason: input.reason ?? null,
      source: "OWNER_OVERRIDE",
    },
  });

  return { ok: true };
}

/** Line-level figures the owner sees, including a margin only when cost is known. */
export function lineEconomics(line: {
  quantity: number;
  costPrice: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  costStatus: string;
}) {
  return {
    costKnown: line.costPrice != null,
    marginPct: marginPct(line.costPrice, line.unitPrice),
    lineTotal: line.lineTotal,
    priced: line.unitPrice != null,
  };
}

export async function quotationPricingState(quotationId: string) {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });
  if (!quotation) return null;
  const unpriced = quotation.items.filter((item) => item.unitPrice == null);
  return {
    quotation,
    unpriced,
    allPriced: unpriced.length === 0,
    hasPricingException: Boolean(quotation.pricingExceptionById && quotation.pricingExceptionReason),
    costComplete: quotation.items.every((item) => !item.costIncomplete),
  };
}

export async function generateAndStoreQuotationPdf(
  quotationId: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true, enquiry: true },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.items.some((item) => item.unitPrice == null)) {
    return {
      ok: false,
      error: "This quotation still has unpriced lines. Price every line before creating the customer PDF.",
    };
  }
  if (quotation.status === "DRAFT" || quotation.status === "AWAITING_APPROVAL") {
    return { ok: false, error: "Approve the quotation before generating the customer PDF." };
  }

  const org = await db.organization.findUnique({ where: { id: quotation.organizationId } });
  if (!org) return { ok: false, error: "The company profile could not be loaded for this quotation." };
  const floorProblem = marginFloorProblem({ quotation, minMarginPct: org.minMarginPct, exceptionReason: quotation.marginExceptionReason });
  if (floorProblem) return { ok: false, error: floorProblem };
  const buffer = await generateQuotationPdf({
    org: {
      name: org.name,
      legalName: org.legalName,
      taxRegistrationNumber: org.taxRegistrationNumber,
      brandLabel: org.name,
      email: org.email,
      phone: org.phone,
      address: org.address,
      taxLabel: org.taxLabel,
      taxEnabled: org.taxEnabled,
    },
    quotation: {
      quoteNumber: quotation.quoteNumber,
      date: quotation.createdAt,
      validityDate: quotation.validityDate,
      customerName: quotation.customerName,
      customerPhone: quotation.customerPhone,
      customerEmail: quotation.customerEmail,
      currency: quotation.currency,
      subtotal: quotation.subtotal,
      taxAmount: quotation.taxAmount,
      total: quotation.total,
      terms: quotation.terms,
      paymentTerms: quotation.paymentTerms,
      deliveryTerms: quotation.deliveryTerms,
      deliveryAddress: quotation.deliveryAddress,
      notes: quotation.notes,
      items: quotation.items.map((item) => ({
        description: item.description,
        specs: item.specs,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice as number,
        lineTotal: item.lineTotal as number,
        countryOfOrigin: item.countryOfOrigin,
        certification: item.certification,
        leadTimeDays: item.leadTimeDays,
        deliveryTerms: item.deliveryTerms,
        deliveryLocation: item.deliveryLocation,
        validityDate: item.validityDate,
        technicalNotes: item.technicalNotes,
      })),
    },
  });

  // Quotation PDFs are files too: keep them under the owning organization's
  // prefix so one tenant's document can never be fetched through another.
  const organizationId = await requireTenantId();
  const safeNumber = quotation.quoteNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  const stored = await saveBuffer(
    buffer,
    `organizations/${organizationId}/quotations/${safeNumber}-v${quotation.version}.pdf`,
    "application/pdf",
  );

  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: { pdfPath: stored.storagePath, pdfGeneratedAt: new Date() },
  });
  return { ok: true, path: stored.storagePath };
}

export type SendChannel = "EMAIL" | "WHATSAPP" | "MANUAL";

/**
 * Releases an approved quotation.
 *
 * EMAIL/WHATSAPP perform a real provider request and only record SENT when the
 * provider accepted it. MANUAL records that the owner downloaded the PDF and
 * sent it themselves — it never claims a message was sent by the system.
 */
export async function sendApprovedQuotation(input: {
  quotationId: string;
  channel: SendChannel;
  to?: string | null;
  userId: string;
  actorLabel: string;
  manualNote?: string | null;
}): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: input.quotationId },
    include: { items: true },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "APPROVED") {
    return { ok: false, error: "The quotation must be approved before it can be released." };
  }
  if (quotation.items.some((item) => item.unitPrice == null)) {
    return { ok: false, error: "This quotation has unpriced lines and cannot be released." };
  }
  const org = await db.organization.findUnique({ where: { id: quotation.organizationId } });
  const floorProblem = marginFloorProblem({ quotation, minMarginPct: org?.minMarginPct ?? 0, exceptionReason: quotation.marginExceptionReason });
  if (floorProblem) return { ok: false, error: floorProblem };

  if (!quotation.pdfPath) {
    const generated = await generateAndStoreQuotationPdf(quotation.id);
    if (!generated.ok) return { ok: false, error: generated.error ?? "The PDF could not be created." };
  }
  const refreshed = await db.customerQuotation.findUnique({ where: { id: quotation.id } });
  const pdfPath = refreshed?.pdfPath ?? null;

  const fail = async (message: string) => {
    await db.customerQuotation.update({
      where: { id: quotation.id },
      data: { sendError: message.slice(0, 600) },
    });
    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "quotation.send_failed",
      entityType: "CustomerQuotation",
      entityId: quotation.id,
      meta: { channel: input.channel, error: message },
    });
    return { ok: false as const, error: message };
  };

  if (input.channel === "MANUAL") {
    await db.customerQuotation.update({
      where: { id: quotation.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentChannel: "MANUAL",
        sentTo: input.to?.trim() || null,
        sendError: null,
        notes: input.manualNote
          ? [quotation.notes, `Sent manually: ${input.manualNote}`].filter(Boolean).join("\n")
          : quotation.notes,
      },
    });
    await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "quotation.confirmed_sent_manually",
      entityType: "CustomerQuotation",
      entityId: quotation.id,
      meta: { note: input.manualNote ?? null, to: input.to ?? null },
    });
    return { ok: true, detail: "Recorded as sent manually by you. No message was sent by the system." };
  }

  if (!pdfPath) return fail("The quotation PDF is missing.");

  // A stable opaque reference travels in the subject so a customer's reply or
  // purchase order can be attached to this exact quotation version. It is not
  // a secret and it is never used to authorise a commercial change.
  const correlationToken = quotation.correlationToken ?? correlationTokenFor("QTN", quotation.id);
  if (!quotation.correlationToken) {
    await db.customerQuotation.update({
      where: { id: quotation.id },
      data: { correlationToken },
    });
  }
  const reference = correlationReference("QTN", correlationToken);
  const subject = `Quotation ${quotation.quoteNumber} [${reference}]`;

  const to = (
    input.channel === "EMAIL"
      ? input.to ?? quotation.customerEmail ?? ""
      : input.to ?? quotation.customerPhone ?? ""
  ).trim();
  if (!to) {
    return {
      ok: false,
      error:
        input.channel === "EMAIL"
          ? "This quotation has no customer email address."
          : "This quotation has no customer WhatsApp number.",
    };
  }

  const pdf = await readBuffer(pdfPath);
  const body = [
    `Dear ${quotation.customerName},`,
    "",
    `Please find our quotation ${quotation.quoteNumber} attached.`,
    `Total: ${money(quotation.total, quotation.currency)}`,
    `Reference: ${reference}`,
    "",
    "Thank you,",
  ].join("\n");
  let sentDetail = "";

  const result = await sendOutboundOnce(
    {
      operationKey: outboundOperationKey([
        "customer-quotation",
        quotation.id,
        `v${quotation.version}`,
        input.channel,
      ]),
      kind: "CUSTOMER_QUOTATION",
      channel: input.channel,
      recipient: to,
      subject,
      body,
      relatedType: "CustomerQuotation",
      relatedId: quotation.id,
      metadata: { version: quotation.version, userId: input.userId },
    },
    async () => {
      if (isDemoMode) {
        sentDetail = `Demo simulation: recorded as sent to ${to}. No message was transmitted.`;
        return {
          outcome: "SENT",
          simulated: true,
          providerMessageId: "demo-simulated",
          detail: sentDetail,
        };
      }
      if (input.channel === "EMAIL") {
        const sent = await sendEmail({
          to,
          subject,
          text: body,
          attachments: [{ filename: `${quotation.quoteNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
        });
        if (sent.ok) {
          sentDetail = sent.simulated
            ? `Demo simulation: recorded as sent to ${to}. No email was transmitted.`
            : `Emailed to ${to}.`;
          return {
            outcome: "SENT",
            simulated: sent.simulated,
            providerMessageId: sent.providerIds?.messageId ?? null,
            providerThreadId: sent.providerIds?.threadId ?? null,
            detail: sentDetail,
          };
        }
        return sent.uncertain
          ? { outcome: "UNKNOWN", error: sent.error }
          : { outcome: "FAILED_SAFE", error: sent.error };
      }

      const sent = await sendWhatsAppDocument({
        to,
        filename: `${quotation.quoteNumber}.pdf`,
        buffer: pdf,
        caption: `Quotation ${quotation.quoteNumber} — ${money(quotation.total, quotation.currency)}`,
      });
      if (sent.ok) {
        sentDetail = sent.simulated
          ? `Demo simulation: recorded as sent to ${to}. No WhatsApp message was transmitted.`
          : `Sent on WhatsApp to ${to} (message ${sent.messageId ?? "accepted"}).`;
        return {
          outcome: "SENT",
          simulated: sent.simulated,
          providerMessageId: sent.messageId ?? null,
          detail: sentDetail,
        };
      }
      if (sent.uncertain) return { outcome: "UNKNOWN", error: sent.detail };

      // The document was definitely not accepted, so a text fallback is safe.
      // If it is also uncertain, the whole send becomes UNKNOWN and is not retried.
      const text = await sendWhatsAppText(
        to,
        `Quotation ${quotation.quoteNumber} — total ${money(quotation.total, quotation.currency)}. We could not attach the PDF automatically; please ask us to re-send it.`,
      );
      if (text.ok) {
        sentDetail = `A text message was delivered to ${to}, but the PDF could not be attached: ${sent.detail}`;
        return {
          outcome: "SENT",
          simulated: text.simulated,
          providerMessageId: text.messageId ?? null,
          detail: sentDetail,
        };
      }
      if (text.uncertain) return { outcome: "UNKNOWN", error: text.detail };
      return { outcome: "FAILED_SAFE", error: `${sent.detail} ${text.detail}`.trim() };
    },
  );

  if (result.status === "UNCERTAIN" || result.status === "IN_PROGRESS") return fail(result.detail);
  if (result.status === "FAILED_SAFE" || result.status === "EXHAUSTED" || result.status === "CANCELLED") {
    return fail(result.detail);
  }

  const wasSimulated = Boolean(result.simulated);
  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: {
      status: "SENT",
      sentAt: quotation.sentAt ?? new Date(),
      sentChannel: wasSimulated ? "DEMO" : input.channel,
      sentTo: to,
      correlationToken,
      providerMessageId: result.providerMessageId ?? null,
      providerThreadId: result.providerThreadId ?? null,
      sendError: wasSimulated ? "Demo simulation — no message was transmitted." : null,
    },
  });
  await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: wasSimulated ? "quotation.simulated_sent" : "quotation.sent",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { channel: wasSimulated ? "DEMO" : input.channel, to, outboundId: result.messageId ?? null },
  });
  return {
    ok: true,
    detail:
      result.status === "ALREADY_SENT"
        ? "This quotation was already released; no duplicate message was transmitted."
        : result.detail || sentDetail || `Sent to ${to}.`,
  };
}

export function quotationShareLink(quotationId: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/api/quotations/${quotationId}/pdf`;
}
