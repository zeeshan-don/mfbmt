import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { resolvePricingRule, sellingPriceFromCost } from "../pricing/rules";
import { buildSpecSummary } from "../catalog/normalize";
import { generateQuotationPdf } from "../pdf/quote";
import { env } from "../env";
import { buildQuoteTerms } from "../pdf/terms";
import { money } from "../costing/landed";

const round2 = (value: number) => Math.round(value * 100) / 100;

async function nextQuoteNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await db.customerQuotation.count({ where: { quoteNumber: { startsWith: `QT-${year}-` } } });
  return `QT-${year}-${String(count + 1).padStart(4, "0")}`;
}

/**
 * Builds a customer quotation draft from owner-approved sourcing decisions.
 * It is explicitly a draft: sending requires a separate approval.
 */
export async function createQuotationDraft(input: {
  enquiryId: string;
  userId: string;
  actorLabel: string;
  notes?: string | null;
}): Promise<{ ok: true; quotationId: string } | { ok: false; error: string }> {
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
  if (existing) return { ok: true, quotationId: existing.id };

  const org = await db.organization.findFirst();
  const rules = await db.pricingRule.findMany();
  const currency = (enquiry.currency || org?.defaultCurrency || "AED").toUpperCase();

  const unpriced: string[] = [];
  const lineDrafts: Array<{
    enquiryItemId: string;
    description: string;
    specs: string;
    quantity: number;
    unit: string;
    costPrice: number | null;
    unitPrice: number;
    lineTotal: number;
    supplierOfferId: string | null;
  }> = [];

  for (const item of enquiry.items) {
    const offer = item.offers.find((o) => o.id === item.approvedOfferId) ?? null;
    let unitCost: number | null = null;
    if (offer) {
      const snapshot = parseJson<{ landed?: { total?: number | null; effectiveQuantity?: number } }>(
        offer.landedCostJson,
        {},
      );
      const total = snapshot.landed?.total ?? null;
      const effective = snapshot.landed?.effectiveQuantity ?? item.quantityToSource;
      if (total != null && effective > 0) unitCost = round2(total / effective);
      else if (offer.unitPrice != null) unitCost = round2(offer.unitPrice);
    }

    const rule = resolvePricingRule(
      rules.map((r) => ({ ...r, scope: r.scope, category: r.category })),
      item.category,
    );
    const price = sellingPriceFromCost(unitCost, rule, null);
    if (price == null) unpriced.push(item.description);

    const quantity = item.quantity > 0 ? item.quantity : item.quantityFromStock + item.quantityToSource;
    const unitPrice = price ?? 0;

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
      unitPrice,
      lineTotal: round2(unitPrice * quantity),
      supplierOfferId: offer?.id ?? null,
    });
  }

  const subtotal = round2(lineDrafts.reduce((sum, line) => sum + line.lineTotal, 0));
  const taxAmount = org?.taxEnabled ? round2(subtotal * ((org.taxRatePct ?? 0) / 100)) : 0;
  const total = round2(subtotal + taxAmount);
  const internalCost = round2(
    lineDrafts.reduce((sum, line) => sum + (line.costPrice ?? 0) * line.quantity, 0),
  );

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
      terms: buildQuoteTerms(org),
      notes:
        input.notes?.trim() ||
        (unpriced.length > 0
          ? `Prices still to be confirmed for: ${unpriced.join(", ")}.`
          : null),
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
      }),
    },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.draft_created",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { total, currency, unpriced },
  });

  await notifyOwner({
    type: "QUOTATION_APPROVAL",
    title: "A customer quotation is ready for approval",
    body: `${quotation.quoteNumber} — ${money(total, currency)}`,
    link: `/quotations/${quotation.id}`,
  });

  return { ok: true, quotationId: quotation.id };
}

export async function updateQuotationLinePrice(input: {
  quotationId: string;
  itemId: string;
  unitPrice: number;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: input.quotationId },
    include: { items: true },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "DRAFT") return { ok: false, error: "This quotation can no longer be edited." };
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) return { ok: false, error: "Enter a valid price." };

  const line = quotation.items.find((item) => item.id === input.itemId);
  if (!line) return { ok: false, error: "Quotation line not found." };

  const lineTotal = Math.round(input.unitPrice * line.quantity * 100) / 100;
  await db.customerQuotationItem.update({
    where: { id: line.id },
    data: { unitPrice: input.unitPrice, lineTotal },
  });

  const items = await db.customerQuotationItem.findMany({ where: { quotationId: quotation.id } });
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  const org = await db.organization.findFirst();
  const taxAmount = org?.taxEnabled ? Math.round(subtotal * ((org.taxRatePct ?? 0) / 100) * 100) / 100 : 0;

  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: { subtotal, taxAmount, total: Math.round((subtotal + taxAmount) * 100) / 100 },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.price_overridden",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { lineId: line.id, unitPrice: input.unitPrice },
  });

  return { ok: true };
}

export async function generateAndStoreQuotationPdf(quotationId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: quotationId },
    include: { items: true, enquiry: true },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
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
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
    },
  });

  const dir = path.resolve(process.cwd(), env.STORAGE_ROOT, "quotations");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${quotation.quoteNumber}.pdf`);
  await fs.writeFile(filePath, buffer);
  const relative = path.relative(path.resolve(process.cwd(), env.STORAGE_ROOT), filePath).split(path.sep).join("/");

  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: { pdfPath: relative, pdfGeneratedAt: new Date() },
  });
  return { ok: true, path: relative };
}

export async function markQuotationSent(input: {
  quotationId: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const quotation = await db.customerQuotation.findUnique({ where: { id: input.quotationId } });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (quotation.status !== "APPROVED") {
    return { ok: false, error: "The quotation must be approved before it can be recorded as sent." };
  }
  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: { status: "SENT", sentAt: new Date() },
  });
  await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "quotation.marked_sent",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
  });
  return { ok: true };
}
