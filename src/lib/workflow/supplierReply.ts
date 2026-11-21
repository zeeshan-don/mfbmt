import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { matchProduct } from "../inventory/matching";
import { parseFastenerSpec, parseFastenerSpecJson } from "../fasteners/spec";
import { industrialSpecFromFields, parseIndustrialSpecJson } from "../catalog/industrialSpec";
import {
  assertAllowedUpload,
  saveAttachmentForOrganization,
  storageReadiness,
} from "../storage";
import { requireTenantId } from "../tenant";
import { recomputeOffersForItem } from "../costing/evaluate";
import { ensureSourcingApproval } from "./approvals";

/**
 * Automatic supplier RFQ reply ingestion.
 *
 * Correlation is evidence-based and ordered. A reply is attached automatically
 * only when a strong identifier matches exactly one outstanding RFQ (provider
 * thread/message, In-Reply-To/References, or the opaque token embedded in the
 * RFQ). Sender identity or a similar subject alone never auto-attaches an
 * unrelated email: those become NEEDS_REVIEW with possible matches for the
 * owner. Nothing is ever silently discarded.
 *
 * Offers created here are UNVERIFIED drafts. The supplier's price is evidence,
 * not an approved procurement decision, and unknown shipping/tax/other charges
 * stay null instead of becoming zero.
 */

const TOKEN_PATTERN = /\bRFQ-([A-Z0-9]{8,24})\b/i;
const CURRENCY_PATTERN = /\b(AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW|KRW)\b/i;

export type ReplyCorrelationInput = {
  fromAddress: string;
  subject?: string | null;
  bodyText?: string | null;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
};

export type ReplyCorrelationCandidate = {
  quoteId: string;
  supplierId: string;
  supplierEmail: string | null;
  sentTo: string | null;
  status: string;
  correlationToken: string | null;
  subject: string | null;
  publicRef: string | null;
  sentAt: number | null;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
};

export type ReplyCorrelation = {
  status: "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED";
  quoteId: string | null;
  confidence: number;
  method: string;
  possible: Array<{ quoteId: string; confidence: number; method: string }>;
  reasons: string[];
};

export function extractCorrelationToken(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.match(TOKEN_PATTERN)?.[1]?.toUpperCase() ?? null;
}

function headerIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,<>]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 3);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Ranks each candidate by the strongest available evidence.
 * Auto-match requires a strong identifier (>= 90) that is unique to one RFQ.
 */
export function correlateSupplierReply(
  input: ReplyCorrelationInput,
  candidates: ReplyCorrelationCandidate[],
): ReplyCorrelation {
  const subject = input.subject ?? "";
  const body = input.bodyText ?? "";
  const combined = `${subject}\n${body}`;
  const token = extractCorrelationToken(combined);
  const references = [...headerIds(input.references), ...headerIds(input.inReplyTo)];
  const reasons: string[] = [];

  const scored = candidates.map((candidate) => {
    let score = 0;
    let method = "none";

    if (candidate.providerThreadId && input.providerThreadId && candidate.providerThreadId === input.providerThreadId) {
      score = 100;
      method = "provider_thread";
    } else if (
      candidate.providerMessageId &&
      references.some((reference) => reference.includes(candidate.providerMessageId!) || candidate.providerMessageId!.includes(reference))
    ) {
      score = 100;
      method = "message_id_header";
    } else if (candidate.providerMessageId && input.internetMessageId && input.internetMessageId === candidate.providerMessageId) {
      score = 100;
      method = "provider_message";
    } else if (candidate.correlationToken && token && candidate.correlationToken.toUpperCase() === token) {
      score = 95;
      method = "rfq_token";
    } else if (candidate.publicRef && combined.toUpperCase().includes(candidate.publicRef.toUpperCase())) {
      score = 80;
      method = "enquiry_reference";
    } else if (
      sameAddress(input.fromAddress, candidate.supplierEmail) ||
      sameAddress(input.fromAddress, candidate.sentTo)
    ) {
      score = 55;
      method = "sender";
    }

    return { quoteId: candidate.quoteId, score, method };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score === 0) {
    return { status: "UNMATCHED", quoteId: null, confidence: 0, method: "none", possible: [], reasons: ["No RFQ identifier matched this email."] };
  }

  const tied = scored.filter((entry) => entry.score >= top.score - 5 && entry.score >= 70);

  if (top.score >= 90 && tied.length === 1) {
    reasons.push(`Matched by ${top.method.replaceAll("_", " ")}.`);
    return {
      status: "MATCHED",
      quoteId: top.quoteId,
      confidence: top.score / 100,
      method: top.method,
      possible: [{ quoteId: top.quoteId, confidence: top.score / 100, method: top.method }],
      reasons,
    };
  }

  if (top.score >= 55) {
    reasons.push(
      tied.length > 1
        ? "More than one outstanding RFQ matches this email. Choose the correct one."
        : `Only weak evidence (${top.method.replaceAll("_", " ")}). Confirm the correct RFQ.`,
    );
    return {
      status: "NEEDS_REVIEW",
      quoteId: null,
      confidence: top.score / 100,
      method: top.method,
      possible: tied.map((entry) => ({ quoteId: entry.quoteId, confidence: entry.score / 100, method: entry.method })),
      reasons,
    };
  }

  return {
    status: "UNMATCHED",
    quoteId: null,
    confidence: top.score / 100,
    method: top.method,
    possible: [],
    reasons: ["No confident match to an outstanding supplier RFQ."],
  };
}

// ── Deterministic commercial term extraction ────────────────────────────────

export type SupplierQuoteTerms = {
  supplierName: string | null;
  quoteRef: string | null;
  description: string | null;
  unitPrice: number | null;
  currency: string | null;
  quantityAvailable: number | null;
  moq: number | null;
  leadTimeDays: number | null;
  shippingCost: number | null;
  otherCharges: number | null;
  taxes: number | null;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  validityDays: number | null;
  validityText: string | null;
  certifications: string[];
  countryOfOrigin: string | null;
  brand: string | null;
  manufacturer: string | null;
  material: string | null;
  grade: string | null;
  size: string | null;
  pressureRating: string | null;
  standard: string | null;
  confidence: Record<string, number>;
  missingCommercial: string[];
};

function toNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function matchNumber(text: string, pattern: RegExp): number | null {
  return toNumber(text.match(pattern)?.[1]);
}

function cleanText(raw: string | null | undefined, max = 120): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  return value.length > 0 ? value.slice(0, max) : null;
}

/**
 * Extracts only values the supplier actually stated. Unknown shipping, tax or
 * other charges remain null; they are never treated as zero.
 */
export function extractSupplierQuoteTerms(body: string, subject?: string | null): SupplierQuoteTerms {
  const text = `${subject ?? ""}\n${body}`.replace(/\r/g, "");
  const lower = text.toLowerCase();
  const confidence: Record<string, number> = {};

  const currencyFromText = text.match(CURRENCY_PATTERN)?.[1]?.toUpperCase() ?? null;

  // A unit price needs a unit/price context. A bare total or line total is never
  // promoted to a unit price.
  let unitPrice: number | null = null;
  const pricePatterns: Array<RegExp> = [
    new RegExp(`\\b(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(?:/|per)\\s*(?:pcs?|pc|kg|m|meter|metre|set|unit|litre|liter|ton|bag|drum)\\b`, "i"),
    new RegExp(`\\b(?:unit\\s*price|price\\s*per|unit\\s*rate|rate)\\s*[:=]?\\s*(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`, "i"),
    new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)\\s*(?:/|per)\\s*(?:pcs?|pc|kg|m|meter|metre|set|unit|litre|liter|ton|bag|drum)\\b`, "i"),
  ];
  for (const pattern of pricePatterns) {
    const value = matchNumber(text, pattern);
    if (value != null) {
      unitPrice = value;
      confidence.unitPrice = 0.9;
      break;
    }
  }

  const moq = matchNumber(text, /\b(?:moq|minimum\s*(?:order)?\s*(?:quantity|qty))\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (moq != null) confidence.moq = 0.9;

  const quantityAvailable = matchNumber(
    text,
    /\b(?:available|in\s*stock|stock\s*(?:qty|quantity)?)\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  );
  if (quantityAvailable != null) confidence.quantityAvailable = 0.8;

  const leadTimeDaysValue = text.match(/\b(?:lead\s*time|delivery(?:\s*time)?|shipment)\s*[:=-]?\s*(?:within|in|of)?\s*([0-9]{1,3})\s*(?:working\s*)?days?/i)?.[1];
  const leadTimeDays = leadTimeDaysValue ? Number(leadTimeDaysValue) : null;
  if (leadTimeDays != null) confidence.leadTimeDays = 0.85;

  const shippingCost = matchNumber(
    text,
    /\b(?:freight|shipping|delivery\s*(?:charges?|cost))\s*[:=-]?\s*(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  );
  if (shippingCost != null) confidence.shippingCost = 0.85;

  const otherCharges = matchNumber(
    text,
    /\b(?:other\s*charges?|handling(?:\s*charges?)?|packing\s*charges?)\s*[:=-]?\s*(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  );
  if (otherCharges != null) confidence.otherCharges = 0.8;

  const taxes = matchNumber(
    text,
    /\b(?:vat|tax(?:es)?)\s*[:=-]?\s*(?:AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|INR|CNY|JPY|KRW)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  );
  if (taxes != null) confidence.taxes = 0.8;

  const validityDaysValue = text.match(/\bvalid(?:ity)?\s*(?:for|:)?\s*([0-9]{1,3})\s*days?/i)?.[1];
  const validityDays = validityDaysValue ? Number(validityDaysValue) : null;
  if (validityDays != null) confidence.validityDays = 0.85;
  const validityText = cleanText(text.match(/\bvalid\s*(?:until|till)\s*([^\n,;.]{4,30})/i)?.[1]);

  const paymentTerms = cleanText(
    text.match(/\bpayment\s*(?:terms?)?\s*[:=-]?\s*([^\n.;]{3,60})/i)?.[1],
    80,
  );
  if (paymentTerms) confidence.paymentTerms = 0.8;

  const deliveryTerms = cleanText(
    text.match(/\b(EXW|FOB|CIF|CFR|CPT|CIP|DAP|DDP|FCA)\b/i)?.[1],
    12,
  );
  const countryOfOrigin = cleanText(
    text.match(/\b(?:country\s*of\s*origin|origin)\s*[:=-]?\s*([A-Za-z][A-Za-z .-]{1,40})/i)?.[1],
    40,
  );
  const quoteRef = cleanText(
    text.match(/\b(?:quotation|quote|offer|ref(?:erence)?)\s*(?:no\.?|number|#|:)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{2,30})/i)?.[1],
    40,
  );
  const brand = cleanText(text.match(/\b(?:brand|make)\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9 &._/-]{1,40})/i)?.[1], 60);
  const manufacturer = cleanText(
    text.match(/\b(?:manufacturer|mfg\.?|maker)\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9 &._/-]{1,50})/i)?.[1],
    70,
  );

  const material = text.match(/\b(?:ss\s*-?\s*(?:316l?|304l?)|stainless\s*steel(?:\s*(?:316l?|304l?))?|carbon\s*steel|mild\s*steel|cast\s*iron|ductile\s*iron|copper|brass|pvc|upvc|ppr|hdpe|alloy\s*steel|duplex)\b/i)?.[0] ?? null;
  const grade = text.match(/\b(?:gr\.?\s*[0-9a-z.]+|astm\s*a\d+(?:\s*(?:gr\.?|grade)\s*[a-z0-9]+)?|a\d{3}\s*(?:gr\.?|grade)?\s*[a-z]?)\b/i)?.[0] ?? null;
  const size = text.match(/\b(?:dn\s*\d+|\d+(?:\.\d+)?\s*(?:inch|in|"|mm)|\d+\/\d+(?:\s*(?:inch|in|"))?)\b/i)?.[0] ?? null;
  const pressureRating = text.match(/\b(?:class\s*\d+|pn\s*\d+|\d+(?:\.\d+)?\s*(?:bar|psi))\b/i)?.[0] ?? null;
  const standard = text.match(/\b(?:asme\s*[a-z]?\d+(?:\.\d+)?|ansi\s*[a-z]?\d+(?:\.\d+)?|astm\s*[a-z]\d+|api\s*\d+[a-z]?|din\s*\d+|bs\s*\d+|en\s*\d+|iso\s*\d+)\b/i)?.[0] ?? null;

  const certifications = [
    ...new Set(
      (text.match(/\b(?:EN\s*10204\s*3\.1|ISO\s*\d{4,5}|API\s*\d+[A-Z]?|CE|SASO|mill\s*certificate)\b/gi) ?? []).map(
        (entry) => entry.replace(/\s+/g, " ").toUpperCase(),
      ),
    ),
  ].slice(0, 6);

  // Product description: an explicit description/item label, otherwise a short
  // first substantive line. Never the entire email.
  const description =
    cleanText(text.match(/\b(?:description|item|product)\s*[:=-]\s*([^\n]{3,160})/i)?.[1], 160) ??
    cleanText(
      body
        .split(/\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 8 && !/^(dear|hello|hi|regards|thanks|please|kindly|quotation|quote|subject)/i.test(line)),
      160,
    );

  const missingCommercial: string[] = [];
  if (unitPrice == null) missingCommercial.push("Unit price");
  if (!currencyFromText) missingCommercial.push("Currency");
  if (leadTimeDays == null) missingCommercial.push("Lead time");
  if (shippingCost == null) missingCommercial.push("Shipping cost");
  if (taxes == null) missingCommercial.push("Taxes");
  if (validityDays == null && !validityText) missingCommercial.push("Quote validity");
  if (!paymentTerms) missingCommercial.push("Payment terms");
  if (/\b(?:vat|tax)\s*(?:@\s*)?\d{1,2}\s*%/i.test(lower)) {
    missingCommercial.push("Tax amount (only a percentage was stated)");
  }

  return {
    supplierName: manufacturer ?? brand,
    quoteRef,
    description,
    unitPrice,
    currency: currencyFromText,
    quantityAvailable,
    moq,
    leadTimeDays: leadTimeDays != null ? Math.round(leadTimeDays) : null,
    shippingCost,
    otherCharges,
    taxes,
    deliveryTerms,
    paymentTerms,
    validityDays: validityDays != null ? Math.round(validityDays) : null,
    validityText,
    certifications,
    countryOfOrigin,
    brand,
    manufacturer,
    material,
    grade,
    size,
    pressureRating,
    standard,
    confidence,
    missingCommercial: [...new Set(missingCommercial)],
  };
}

// ── Ingestion ───────────────────────────────────────────────────────────────

export type SupplierReplyInput = {
  provider: "GMAIL" | "MICROSOFT365";
  externalMessageId: string;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  from: string;
  fromName?: string | null;
  subject?: string | null;
  body: string;
  receivedAt?: Date;
  attachments?: Array<{ filename: string; buffer: Buffer }>;
};

export type SupplierReplyResult = {
  handled: boolean;
  duplicate?: boolean;
  replyId?: string;
  status?: "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED";
  quoteId?: string | null;
  offerId?: string | null;
  reason?: string;
};

async function findSupplierByEmail(email: string) {
  return db.supplier.findFirst({
    where: {
      OR: [
        { email: { equals: email, mode: "insensitive" } },
        { contacts: { some: { email: { equals: email, mode: "insensitive" } } } },
      ],
    },
    include: { contacts: true },
  });
}

async function materializeOffer(input: {
  replyId: string;
  quote: {
    id: string;
    supplierId: string;
    enquiryItemId: string | null;
    items: Array<{ id: string }>;
    supplier: { name: string };
    enquiryItem: {
      id: string;
      description: string;
      rawText: string | null;
      category: string | null;
      brand: string | null;
      size: string | null;
      material: string | null;
      grade: string | null;
      pressureRating: string | null;
      schedule: string | null;
      standard: string | null;
      fastenerSpecJson: string | null;
      industrialSpecJson: string | null;
      enquiryId: string;
    } | null;
  };
  terms: SupplierQuoteTerms;
  bodySummary: string;
  attachmentNames: string[];
  receivedAt: Date;
}): Promise<string | null> {
  const { quote, terms } = input;
  if (!quote.enquiryItem) return null;

  const quoteItemId = quote.items[0]?.id ?? null;
  if (quoteItemId) {
    const existing = await db.supplierOffer.findFirst({ where: { quoteItemId } });
    if (existing) return existing.id;
  }

  const requestedIndustrial = parseIndustrialSpecJson(quote.enquiryItem.industrialSpecJson);
  const offeredIndustrial = requestedIndustrial
    ? industrialSpecFromFields(
        requestedIndustrial.category,
        {
          description: terms.description ?? quote.enquiryItem.description,
          size: terms.size,
          material: terms.material,
          grade: terms.grade,
          pressureRating: terms.pressureRating,
          standard: terms.standard,
          brand: terms.brand,
        },
        { source: "SUPPLIER_CONFIRMED" },
      )
    : null;

  const offeredFastener = parseFastenerSpec({
    description: terms.description ?? quote.enquiryItem.description,
    size: terms.size,
    material: terms.material,
    grade: terms.grade,
    standard: terms.standard,
  });

  const match = matchProduct(
    {
      description: quote.enquiryItem.description,
      category: quote.enquiryItem.category,
      brand: quote.enquiryItem.brand,
      size: quote.enquiryItem.size,
      material: quote.enquiryItem.material,
      grade: quote.enquiryItem.grade,
      pressureRating: quote.enquiryItem.pressureRating,
      schedule: quote.enquiryItem.schedule,
      standard: quote.enquiryItem.standard,
      fastenerSpec: parseFastenerSpecJson(quote.enquiryItem.fastenerSpecJson),
      industrialSpec: requestedIndustrial,
    },
    {
      description: terms.description ?? quote.enquiryItem.description,
      size: terms.size,
      material: terms.material,
      grade: terms.grade,
      pressureRating: terms.pressureRating,
      standard: terms.standard,
      brand: terms.brand,
      fastenerSpec: offeredFastener,
      industrialSpec: offeredIndustrial,
    },
    { strictStandard: Boolean(quote.enquiryItem.standard) },
  );

  const validityDate =
    terms.validityDays != null
      ? new Date(input.receivedAt.getTime() + terms.validityDays * 24 * 60 * 60 * 1000)
      : null;

  const offer = await db.supplierOffer.create({
    data: {
      enquiryItemId: quote.enquiryItem.id,
      supplierId: quote.supplierId,
      supplierName: quote.supplier.name,
      productTitle: (terms.description ?? quote.enquiryItem.description).slice(0, 300),
      matchStatus: match.status,
      unitPrice: terms.unitPrice,
      currency: terms.currency,
      quantityAvailable: terms.quantityAvailable,
      moq: terms.moq,
      shippingCost: terms.shippingCost,
      otherCharges: terms.otherCharges,
      taxes: terms.taxes,
      leadTimeDays: terms.leadTimeDays,
      deliveryLocation: null,
      validityDate,
      paymentTerms: terms.paymentTerms,
      status: "QUOTE_RECEIVED",
      sourceType: "SUPPLIER_QUOTE",
      quotedAt: input.receivedAt,
      quoteRef: terms.quoteRef ?? `email:${input.replyId}`,
      verificationStatus: "UNVERIFIED",
      offeredSpecJson: stringifyJson(offeredFastener),
      quoteItemId,
      evidenceJson: stringifyJson({
        source: "supplier_email_reply",
        supplierReplyId: input.replyId,
        originalWording: input.bodySummary.slice(0, 2000),
        attachmentNames: input.attachmentNames,
        statedTerms: terms,
        extractionConfidence: terms.confidence,
        missingCommercial: terms.missingCommercial,
        deliveryTerms: terms.deliveryTerms,
        certifications: terms.certifications,
        countryOfOrigin: terms.countryOfOrigin,
        match: { status: match.status, reasons: match.reasons, mismatches: match.mismatches, missing: match.missing },
      }),
    },
  });

  await db.supplierQuote.update({
    where: { id: quote.id },
    data: { status: "RESPONDED", respondedAt: input.receivedAt },
  });
  await db.supplierOffer.update({
    where: { id: offer.id },
    data: { procurementQuantity: null },
  });

  await recomputeOffersForItem(quote.enquiryItem.id);
  await db.enquiryItem.update({
    where: { id: quote.enquiryItem.id },
    data: { sourcingStatus: "RESULTS_READY" },
  });
  await ensureSourcingApproval(quote.enquiryItem.id);
  await writeAudit({
    action: "supplier_reply.offer_drafted",
    entityType: "SupplierEmailReply",
    entityId: input.replyId,
    actorLabel: "system",
    meta: {
      offerId: offer.id,
      supplierQuoteId: quote.id,
      matchStatus: match.status,
      unitPrice: terms.unitPrice,
      currency: terms.currency,
    },
  });
  return offer.id;
}

/** Records an inbound email as a supplier reply when its sender is a supplier. */
async function recordSupplierBounce(body: string, subject: string | null): Promise<void> {
  const addresses = [...new Set((body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((value) => value.toLowerCase()))];
  if (addresses.length === 0) return;
  const suppliers = await db.supplier.findMany({
    where: { email: { in: addresses, mode: "insensitive" } },
    select: { id: true, name: true, email: true },
  });
  for (const supplier of suppliers) {
    await db.supplier.update({
      where: { id: supplier.id },
      data: {
        status: "BLOCKED",
        doNotContact: true,
        bouncedAt: new Date(),
        bounceReason: (subject ?? "Delivery failure").slice(0, 300),
      },
    });
    await notifyOwner({
      type: "SUPPLIER_BOUNCE",
      title: `Supplier email bounced: ${supplier.name}`,
      body: `${supplier.email ?? "The supplier address"} is now blocked from sending until the address is corrected.`,
      link: `/suppliers/${supplier.id}`,
    });
    await writeAudit({
      action: "supplier.bounced",
      entityType: "Supplier",
      entityId: supplier.id,
      actorLabel: "email-bounce",
      meta: { email: supplier.email, subject },
    });
  }
}

export async function ingestSupplierReply(input: SupplierReplyInput): Promise<SupplierReplyResult> {
  const from = input.from.trim().toLowerCase();
  if (!from) return { handled: false, reason: "No sender address." };

  const supplier = await findSupplierByEmail(from);
  const looksLikeBounce =
    /mailer-daemon|postmaster|mail delivery subsystem/i.test(from) ||
    /undeliverable|delivery status notification|delivery has failed|returned mail|failure notice/i.test(input.subject ?? "");
  if (!supplier && looksLikeBounce) {
    await recordSupplierBounce(input.body, input.subject ?? null);
    return { handled: true, reason: "Delivery failure recorded." };
  }
  if (!supplier) return { handled: false, reason: "Sender is not a known supplier." };

  const duplicate = await db.supplierEmailReply.findFirst({
    where: { provider: input.provider, externalMessageId: input.externalMessageId },
  });
  if (duplicate) {
    return {
      handled: true,
      duplicate: true,
      replyId: duplicate.id,
      status: duplicate.matchingStatus as SupplierReplyResult["status"],
      quoteId: duplicate.supplierQuoteId,
    };
  }

  const validationFailures: string[] = [];
  const organizationId = await requireTenantId();
  const readiness = storageReadiness();
  const savedAttachments: Array<{ id: string; filename: string; sha256: string; sizeBytes: number }> = [];
  const reply = await db.supplierEmailReply.create({
    data: {
      supplierId: supplier.id,
      externalMessageId: input.externalMessageId,
      provider: input.provider,
      providerThreadId: input.providerThreadId ?? null,
      internetMessageId: input.internetMessageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      referencesHeader: input.references ?? null,
      fromAddress: from,
      fromName: input.fromName ?? null,
      subject: input.subject?.slice(0, 300) ?? null,
      bodySummary: input.body.slice(0, 4000),
      attachmentsJson: "[]",
      extractionStatus: "PENDING",
      matchingStatus: "UNMATCHED",
      correlationJson: "{}",
      receivedAt: input.receivedAt ?? new Date(),
    },
  });

  if ((input.attachments?.length ?? 0) > 0) {
    if (!readiness.ok) {
      validationFailures.push(readiness.detail);
    } else {
      for (const file of input.attachments ?? []) {
        const check = assertAllowedUpload(file.buffer, file.filename);
        if (!check.ok) {
          validationFailures.push(`${file.filename}: ${check.error}`);
          continue;
        }
        try {
          const stored = await saveAttachmentForOrganization(file.buffer, check.filename, organizationId);
          const attachment = await db.attachment.create({
            data: {
              supplierReplyId: reply.id,
              filename: check.filename,
              storedName: stored.storedName,
              mimeType: check.mime,
              detectedMime: check.mime,
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              storagePath: stored.storagePath,
            },
          });
          savedAttachments.push({
            id: attachment.id,
            filename: attachment.filename,
            sha256: attachment.sha256,
            sizeBytes: attachment.sizeBytes,
          });
        } catch (error) {
          validationFailures.push(
            `${file.filename}: ${error instanceof Error ? error.message.slice(0, 160) : "could not be stored"}`,
          );
        }
      }
    }
  }

  const quotes = await db.supplierQuote.findMany({
    where: {
      supplierId: supplier.id,
      status: { in: ["SENT", "RESPONDED", "REQUESTED", "AWAITING_APPROVAL"] },
    },
    include: {
      supplier: { select: { name: true } },
      items: { select: { id: true } },
      enquiryItem: {
        select: {
          id: true,
          description: true,
          rawText: true,
          category: true,
          brand: true,
          size: true,
          material: true,
          grade: true,
          pressureRating: true,
          schedule: true,
          standard: true,
          fastenerSpecJson: true,
          industrialSpecJson: true,
          enquiryId: true,
          enquiry: { select: { publicRef: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const candidates: ReplyCorrelationCandidate[] = quotes.map((quote) => ({
    quoteId: quote.id,
    supplierId: quote.supplierId,
    supplierEmail: supplier.email,
    sentTo: quote.sentTo,
    status: quote.status,
    correlationToken: quote.correlationToken,
    subject: quote.subject,
    publicRef: quote.enquiryItem?.enquiry?.publicRef ?? null,
    sentAt: quote.sentAt?.getTime() ?? null,
    providerThreadId: quote.providerThreadId,
    providerMessageId: quote.providerMessageId,
  }));

  const correlation = correlateSupplierReply(
    {
      fromAddress: from,
      subject: input.subject,
      bodyText: input.body,
      providerThreadId: input.providerThreadId,
      internetMessageId: input.internetMessageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
    },
    candidates,
  );

  const terms = extractSupplierQuoteTerms(input.body, input.subject);
  const matchedQuote = correlation.quoteId ? quotes.find((quote) => quote.id === correlation.quoteId) : null;

  let offerId: string | null = null;
  if (correlation.status === "MATCHED" && matchedQuote) {
    offerId = await materializeOffer({
      replyId: reply.id,
      quote: matchedQuote,
      terms,
      bodySummary: input.body,
      attachmentNames: savedAttachments.map((attachment) => attachment.filename),
      receivedAt: input.receivedAt ?? new Date(),
    });
  }

  // Once matched, link the retained files to the enquiry as well so they are
  // visible in the review screen for that customer case.
  if (matchedQuote?.enquiryItem) {
    await db.attachment.updateMany({
      where: { supplierReplyId: reply.id },
      data: { enquiryId: matchedQuote.enquiryItem.enquiryId },
    });
  }

  const extractionStatus = terms.unitPrice != null || terms.description ? "EXTRACTED" : "NO_TERMS";
  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      supplierQuoteId: correlation.quoteId,
      matchingStatus: correlation.status,
      correlationJson: stringifyJson({ ...correlation, attachmentFailures: validationFailures }),
      extractedJson: stringifyJson(terms),
      extractionStatus,
      attachmentsJson: stringifyJson(savedAttachments),
      processedAt: new Date(),
    },
  });

  await writeAudit({
    action:
      correlation.status === "MATCHED"
        ? "supplier_reply.matched"
        : correlation.status === "NEEDS_REVIEW"
          ? "supplier_reply.needs_review"
          : "supplier_reply.unmatched",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    actorLabel: "system",
    meta: {
      provider: input.provider,
      supplierId: supplier.id,
      matchingStatus: correlation.status,
      method: correlation.method,
      attachmentFailures: validationFailures.length,
      offerId,
    },
  });

  if (correlation.status !== "MATCHED") {
    await notifyOwner({
      type: "SUPPLIER_REPLY_REVIEW",
      title:
        correlation.status === "NEEDS_REVIEW"
          ? "A supplier reply needs matching"
          : "An unmatched supplier email was received",
      body: `${supplier.name}: ${(input.subject ?? "no subject").slice(0, 120)}`,
      link: `/suppliers/replies`,
    });
  }

  return {
    handled: true,
    replyId: reply.id,
    status: correlation.status,
    quoteId: correlation.quoteId,
    offerId,
    reason: validationFailures.length > 0 ? validationFailures.join(" ") : undefined,
  };
}

/** Owner action: attach an ambiguous/unmatched reply to the correct RFQ. */
export async function assignSupplierReplyToQuote(input: {
  replyId: string;
  supplierQuoteId: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true; offerId: string | null } | { ok: false; error: string }> {
  const reply = await db.supplierEmailReply.findUnique({ where: { id: input.replyId } });
  if (!reply) return { ok: false, error: "Supplier reply not found." };

  const quote = await db.supplierQuote.findUnique({
    where: { id: input.supplierQuoteId },
    include: {
      supplier: { select: { name: true } },
      items: { select: { id: true } },
      enquiryItem: {
        select: {
          id: true,
          description: true,
          rawText: true,
          category: true,
          brand: true,
          size: true,
          material: true,
          grade: true,
          pressureRating: true,
          schedule: true,
          standard: true,
          fastenerSpecJson: true,
          industrialSpecJson: true,
          enquiryId: true,
        },
      },
    },
  });
  if (!quote) return { ok: false, error: "Supplier RFQ not found." };
  if (quote.supplierId !== reply.supplierId) {
    return { ok: false, error: "That RFQ was sent to a different supplier." };
  }

  const terms =
    parseJson<SupplierQuoteTerms | null>(reply.extractedJson, null) ??
    extractSupplierQuoteTerms(reply.bodySummary ?? "", reply.subject);

  const offerId = await materializeOffer({
    replyId: reply.id,
    quote,
    terms,
    bodySummary: reply.bodySummary ?? "",
    attachmentNames: parseJson<Array<{ filename: string }>>(reply.attachmentsJson, []).map(
      (attachment) => attachment.filename,
    ),
    receivedAt: reply.receivedAt,
  });

  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      supplierQuoteId: quote.id,
      matchingStatus: "MATCHED",
      reviewStatus: "REVIEWED",
      correlationJson: stringifyJson({ method: "owner_assignment", assignedBy: input.actorLabel }),
    },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_reply.assigned",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    meta: { supplierQuoteId: quote.id, offerId },
  });
  return { ok: true, offerId };
}

export async function setSupplierReplyReviewStatus(input: {
  replyId: string;
  reviewStatus: "REVIEWED" | "DISMISSED";
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const updated = await db.supplierEmailReply.updateMany({
    where: { id: input.replyId },
    data: { reviewStatus: input.reviewStatus },
  });
  if (updated.count === 0) return { ok: false, error: "Supplier reply not found." };
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: `supplier_reply.${input.reviewStatus.toLowerCase()}`,
    entityType: "SupplierEmailReply",
    entityId: input.replyId,
  });
  return { ok: true };
}
