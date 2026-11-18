import { db } from "../db";
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
import { sendEmail } from "../email/send";
import { sendWhatsAppDocument, sendWhatsAppText } from "../intake/whatsapp";
import { env } from "../env";

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
}): Promise<{ ok: true; quotationId: string; unpriced: string[] } | { ok: false; error: string }> {
  const enquiry = await db.enquiry.findUnique({
    where: { id: input.enquiryId },
    include: {
      items: { include: { offers: true } },
      quotations: { orderBy: { version: "desc" } },
    },
  });
  if (!enquiry) return { ok: false, error: "Enquiry not found." };
  if (enquiry.items.length === 0) return { ok: false, error: "There are no products to quote." };

  const existing = enquiry.quotations.find((q) => q.status === "DRAFT" || q.status === "AWAITING_APPROVAL");
  if (existing) return { ok: true, quotationId: existing.id, unpriced: [] };

  const org = await db.organization.findFirst();
  const rules = await db.pricingRule.findMany();
  const currency = (enquiry.currency || org?.defaultCurrency || "AED").toUpperCase();

  const unpriced: string[] = [];
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

    const rule = resolvePricingRule(rules, item.category);
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
  const quotation = await db.customerQuotation.create({
    data: {
      enquiryId: enquiry.id,
      quoteNumber: await nextQuoteNumber(),
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
      // Only text the owner explicitly enters as customer-facing notes is printed.
      // Internal pricing warnings stay in the approval payload and audit trail.
      notes: input.notes?.trim() || null,
      validityDate: new Date(Date.now() + (org?.quotationValidityDays ?? 14) * 24 * 60 * 60 * 1000),
      status: "AWAITING_APPROVAL",
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
      }),
    },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.draft_created",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { total, currency, unpriced, internalCostComplete },
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

  return { ok: true, quotationId: quotation.id, unpriced };
}

async function recalculateTotals(quotationId: string) {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });
  if (!quotation) return null;
  const org = await db.organization.findFirst();
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

  const org = await db.organization.findFirst();
  const buffer = await generateQuotationPdf({
    org: {
      name: org?.name ?? "Multi Fasteners Building Materials Trading LLC",
      legalName: org?.legalName,
      trn: org?.trn,
      email: org?.email,
      phone: org?.phone,
      address: org?.address,
      taxLabel: org?.taxLabel ?? "VAT",
      taxEnabled: org?.taxEnabled ?? false,
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
      notes: quotation.notes,
      items: quotation.items.map((item) => ({
        description: item.description,
        specs: item.specs,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice as number,
        lineTotal: item.lineTotal as number,
      })),
    },
  });

  const stored = await saveBuffer(
    buffer,
    `quotations/${quotation.quoteNumber}.pdf`,
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

  if (input.channel === "EMAIL") {
    const to = (input.to ?? quotation.customerEmail ?? "").trim();
    if (!to) return { ok: false, error: "This quotation has no customer email address." };
    const pdf = await readBuffer(pdfPath);
    const sent = await sendEmail({
      to,
      subject: `Quotation ${quotation.quoteNumber}`,
      text: [
        `Dear ${quotation.customerName},`,
        "",
        `Please find our quotation ${quotation.quoteNumber} attached.`,
        `Total: ${money(quotation.total, quotation.currency)}`,
        "",
        "Thank you,",
      ].join("\n"),
      attachments: [{ filename: `${quotation.quoteNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
    if (!sent.ok) return fail(sent.error);
    const simulated = Boolean("simulated" in sent && sent.simulated);
    await db.customerQuotation.update({
      where: { id: quotation.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentChannel: simulated ? "DEMO" : "EMAIL",
        sentTo: to,
        sendError: simulated ? "Demo simulation — no email was transmitted." : null,
      },
    });
    await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: simulated ? "quotation.simulated_sent" : "quotation.sent",
      entityType: "CustomerQuotation",
      entityId: quotation.id,
      meta: { channel: simulated ? "DEMO" : "EMAIL", to },
    });
    return {
      ok: true,
      detail: simulated
        ? `Demo simulation: recorded as sent to ${to}. No email was transmitted.`
        : `Emailed to ${to}.`,
    };
  }

  const to = (input.to ?? quotation.customerPhone ?? "").trim();
  if (!to) return { ok: false, error: "This quotation has no customer WhatsApp number." };
  const pdf = await readBuffer(pdfPath);
  const sent = await sendWhatsAppDocument({
    to,
    filename: `${quotation.quoteNumber}.pdf`,
    buffer: pdf,
    caption: `Quotation ${quotation.quoteNumber} — ${money(quotation.total, quotation.currency)}`,
  });
  if (!sent.ok) {
    // Fall back to a single text message only when the document upload failed
    // for a reason that a text message would not hit; the result is still
    // reported honestly.
    const text = await sendWhatsAppText(
      to,
      `Quotation ${quotation.quoteNumber} — total ${money(quotation.total, quotation.currency)}. We could not attach the PDF automatically; please ask us to re-send it.`,
    );
    if (!text.ok) return fail(sent.detail);
    await db.customerQuotation.update({
      where: { id: quotation.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentChannel: "WHATSAPP",
        sentTo: to,
        sendError: sent.detail,
      },
    });
    await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
    return {
      ok: true,
      detail: `A text message was delivered to ${to}, but the PDF could not be attached: ${sent.detail}`,
    };
  }

  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sentChannel: sent.simulated ? "DEMO" : "WHATSAPP",
      sentTo: to,
      sendError: sent.simulated ? "Demo simulation — no WhatsApp message was transmitted." : null,
    },
  });
  await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: sent.simulated ? "quotation.simulated_sent" : "quotation.sent",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { channel: sent.simulated ? "DEMO" : "WHATSAPP", to },
  });
  return {
    ok: true,
    detail: sent.simulated
      ? `Demo simulation: recorded as sent to ${to}. No WhatsApp message was transmitted.`
      : `Sent on WhatsApp to ${to} (message ${sent.messageId ?? "accepted"}).`,
  };
}

export function quotationShareLink(quotationId: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/api/quotations/${quotationId}/pdf`;
}
