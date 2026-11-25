import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { matchProduct } from "../inventory/matching";
import { parseFastenerSpec, parseFastenerSpecJson } from "../fasteners/spec";
import { industrialSpecFromFields, parseIndustrialSpecJson } from "../catalog/industrialSpec";
import {
  assertAllowedUpload,
  readAttachment,
  saveAttachmentForOrganization,
  storageReadiness,
} from "../storage";
import { extractDocument, type DocumentText } from "../intake/documents";
import { processDocumentPackage, type DocumentPackageSummary } from "../intake/documentPackage";
import { requireTenantId } from "../tenant";
import { recomputeOffersForItem } from "../costing/evaluate";
import { ensureSourcingApproval } from "./approvals";
import { env } from "../env";
import { enqueueJob } from "./jobs";
import { JOB_TYPES } from "../constants";
import {
  detectSupplierIntent,
  detectSupplierIntentByRules,
  extractSupplierQuotation,
  type SupplierExtractionOutcome,
  type SupplierIntentDetection,
  type SupplierQuotationExtraction,
  type SupplierQuotedItem,
} from "../ai/supplierExtraction";

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
 * Names the commercial inputs a quotation is still missing. A value that was
 * never stated is listed here; it is never silently treated as zero.
 */
function missingCommercialFor(terms: {
  unitPrice: number | null;
  currency: string | null;
  leadTimeDays: number | null;
  shippingCost: number | null;
  taxes: number | null;
  validityDays: number | null;
  validityText: string | null;
  paymentTerms: string | null;
}): string[] {
  const missing: string[] = [];
  if (terms.unitPrice == null) missing.push("Unit price");
  if (!terms.currency) missing.push("Currency");
  if (terms.leadTimeDays == null) missing.push("Lead time");
  if (terms.shippingCost == null) missing.push("Shipping cost");
  if (terms.taxes == null) missing.push("Taxes");
  if (terms.validityDays == null && !terms.validityText) missing.push("Quote validity");
  if (!terms.paymentTerms) missing.push("Payment terms");
  return missing;
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
        .find(
          (line) =>
            line.length > 8 &&
            !/^(dear|hello|hi|regards|thanks|please|kindly|quotation|quote|subject)/i.test(line) &&
            // A price, quantity or term line is evidence, not a product name.
            !/^(?:unit\s*price|price|rate|total|subtotal|moq|minimum|quantity|qty|lead\s*time|delivery|validity|payment|vat|tax|shipping|freight)\b/i.test(
              line,
            ) &&
            !/(?:aed|usd|eur|gbp|sar|qar|omr|kwd|bhd|inr|cny|jpy|krw|درهم|دولار|ريال)\s*\d|\d[\d,.]*\s*(?:aed|usd|eur|gbp|sar|qar|omr|kwd|bhd|inr|cny|jpy|krw|درهم|دولار|ريال)/i.test(
              line,
            ) &&
            !/\b(?:سعر|السعر|الكمية|صلاحية|التوريد|شروط\s*الدفع)\b/.test(line),
        ),
      160,
    );

  const missingCommercial = missingCommercialFor({
    unitPrice,
    currency: currencyFromText,
    leadTimeDays,
    shippingCost,
    taxes,
    validityDays,
    validityText,
    paymentTerms,
  });
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

// ── AI + deterministic commercial merging ───────────────────────────────────

export type SupplierAiConflict = {
  field: string;
  deterministic: string | number | null;
  ai: string | number | null;
  source: string;
  /** The deterministic (document/body) value is kept; the AI value is retained for review. */
  resolution: "deterministic_kept";
};

export type SupplierAiMerge = {
  terms: SupplierQuoteTerms;
  primaryItem: SupplierQuotedItem | null;
  provenance: Record<string, string>;
  fieldsFromAi: string[];
  conflicts: SupplierAiConflict[];
  clarifications: string[];
};

function displayValue(value: unknown): string | number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

function sameCommercialValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.0001;
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Reads "14 days", "2 weeks", "30 days from order" or Arabic day/week wording. */
export function daysFromSupplierText(text: string | null | undefined): number | null {
  if (!text) return null;
  const value = text.trim();
  const weeks = value.match(/(\d{1,3})\s*(?:weeks?|wks?|أسابيع|اسبوع)/i);
  if (weeks) return Number(weeks[1]) * 7;
  const days = value.match(/(\d{1,4})\s*(?:working\s*)?(?:days?|dys?|يوم|أيام|ايام)/i);
  if (days) return Number(days[1]);
  return null;
}

function wordsForMatching(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9\u0600-\u06ff]{3,}/g) ?? []).filter(Boolean))].slice(0, 30);
}

/**
 * Chooses the quoted line that answers the deterministically matched RFQ line.
 * This is line association inside an already-matched reply, never RFQ choice:
 * an AI-supplied ref is accepted only when it was one of the refs we supplied.
 */
export function selectPrimaryQuotedItem(
  items: SupplierQuotedItem[],
  options: { rfqRef?: string | null; rfqDescription?: string | null } = {},
): SupplierQuotedItem | null {
  if (items.length === 0) return null;
  const nonAlternatives = items.filter((item) => !item.alternative_to);
  const candidates = nonAlternatives.length > 0 ? nonAlternatives : items;
  if (options.rfqRef) {
    const exact = candidates.find((item) => item.matched_rfq_item_ref === options.rfqRef);
    if (exact) return exact;
  }
  if (options.rfqDescription) {
    const wanted = wordsForMatching(options.rfqDescription);
    let best: { item: SupplierQuotedItem; score: number } | null = null;
    for (const item of candidates) {
      const offered = new Set(wordsForMatching(item.description));
      const score = wanted.reduce((total, word) => (offered.has(word) ? total + 1 : total), 0);
      if (!best || score > best.score) best = { item, score };
    }
    if (best && best.score > 0) return best.item;
  }
  return candidates[0];
}

/**
 * Fills only fields the deterministic body/attachment pass left null. A
 * conflicting AI value never overwrites document evidence; both values are
 * retained in `conflicts` for owner review. Missing values stay null.
 */
export function mergeAiSupplierExtraction(
  deterministic: SupplierQuoteTerms,
  ai: SupplierQuotationExtraction,
  options: { rfqRef?: string | null; rfqDescription?: string | null } = {},
): SupplierAiMerge {
  const terms: SupplierQuoteTerms = {
    ...deterministic,
    confidence: { ...deterministic.confidence },
    certifications: [...deterministic.certifications],
  };
  const provenance: Record<string, string> = {};
  const fieldsFromAi: string[] = [];
  const conflicts: SupplierAiConflict[] = [];
  const clarifications = [...ai.clarifications_required];

  const primaryItem = selectPrimaryQuotedItem(ai.quoted_items, options);
  const source = primaryItem?.evidence[0]
    ? `${primaryItem.evidence[0].source}${primaryItem.evidence[0].locator ? ` (${primaryItem.evidence[0].locator})` : ""}`
    : "AI extraction";

  const specs = primaryItem?.stated_specifications ?? null;
  const general = ai.general_terms;
  const availability = primaryItem?.availability ?? "";
  const quantityAvailable =
    primaryItem?.quantity != null && /\b(?:in\s*stock|available|stock|ex-stock|متوفر|المخزون)\b/i.test(availability)
      ? primaryItem.quantity
      : null;

  const values: Array<[keyof SupplierQuoteTerms, unknown]> = [
    ["quoteRef", ai.supplier_reference],
    ["description", primaryItem?.description ?? null],
    ["unitPrice", primaryItem ? primaryItem.price_basis === "TOTAL" ? null : (primaryItem.unit_price ?? null) : null],
    ["currency", ai.currency ?? general.currency],
    ["quantityAvailable", quantityAvailable],
    ["moq", primaryItem?.minimum_order_quantity ?? null],
    ["leadTimeDays", primaryItem?.lead_time_days ?? daysFromSupplierText(primaryItem?.lead_time)],
    ["shippingCost", primaryItem?.shipping_cost ?? null],
    ["taxes", primaryItem?.taxes ?? null],
    ["deliveryTerms", general.delivery_terms],
    ["paymentTerms", primaryItem?.payment_terms ?? general.payment_terms],
    ["validityText", primaryItem?.validity ?? general.validity],
    [
      "validityDays",
      daysFromSupplierText(primaryItem?.validity) ?? daysFromSupplierText(general.validity),
    ],
    ["material", specs?.material ?? null],
    ["grade", specs?.grade ?? null],
    ["size", specs?.diameter ?? specs?.length ?? null],
    ["pressureRating", specs?.pressure_class ?? null],
    ["standard", specs?.standard ?? null],
  ];

  for (const [field, rawValue] of values) {
    if (rawValue == null) continue;
    const current = terms[field];
    if (current == null) {
      (terms as unknown as Record<string, unknown>)[field] = rawValue;
      terms.confidence[field] = 0.75;
      provenance[field] = source;
      fieldsFromAi.push(field);
    } else if (!sameCommercialValue(current, rawValue)) {
      conflicts.push({
        field,
        deterministic: displayValue(current),
        ai: displayValue(rawValue),
        source,
        resolution: "deterministic_kept",
      });
    }
  }

  if (primaryItem?.total_price != null && primaryItem.price_basis !== "UNIT" && primaryItem.unit_price == null) {
    clarifications.push(
      `Only a total price was stated (${primaryItem.total_price}${
        ai.currency ?? general.currency ? ` ${ai.currency ?? general.currency}` : ""
      }); the unit price remains unknown.`,
    );
  }
  if (primaryItem?.minimum_order_quantity != null && primaryItem.quantity != null) {
    if (primaryItem.minimum_order_quantity > primaryItem.quantity) {
      clarifications.push("The stated MOQ is higher than the quoted quantity.");
    }
  }

  terms.missingCommercial = missingCommercialFor(terms);
  return {
    terms,
    primaryItem,
    provenance,
    fieldsFromAi,
    conflicts,
    clarifications: [...new Set(clarifications)].slice(0, 20),
  };
}

// ── Supplier attachment reading ─────────────────────────────────────────────

export type SupplierAttachmentDocument = {
  attachmentId: string;
  filename: string;
  text: string;
  status: DocumentText["status"];
  note: string | null;
  pageCount: number | null;
  /** Actual rendered pages/photos; transient and never persisted as data URLs. */
  images?: string[];
};

export type SupplierAttachmentEvidence = {
  attachmentId: string;
  filename: string;
  pageCount: number | null;
  status: DocumentText["status"];
  note: string | null;
  /** Page, sheet or row markers found in the extracted text. */
  sourceRefs: string[];
  /** Fields this file supplied that the email body did not. */
  fieldsFound: string[];
};

/** Commercial/technical fields an attachment may fill when the body omits them. */
const MERGEABLE_TERM_FIELDS = [
  "quoteRef",
  "description",
  "unitPrice",
  "currency",
  "quantityAvailable",
  "moq",
  "leadTimeDays",
  "shippingCost",
  "otherCharges",
  "taxes",
  "deliveryTerms",
  "paymentTerms",
  "validityDays",
  "validityText",
  "countryOfOrigin",
  "brand",
  "manufacturer",
  "material",
  "grade",
  "size",
  "pressureRating",
  "standard",
] as const;

/** Page/sheet/row markers the document parsers already embed in their text. */
function sourceRefsFromText(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/\[page (\d+)\]/gi)) refs.add(`page ${match[1]}`);
  for (const match of text.matchAll(/\[([A-Za-z0-9 _.-]{1,60}?) row (\d+)\]/g)) {
    refs.add(`${match[1].trim()} row ${match[2]}`);
  }
  return [...refs].slice(0, 12);
}

/**
 * Reads the supplier's attached PDF/XLSX/CSV/image through the same safe
 * document pipeline used for customer enquiries, persists the extraction record
 * on the Attachment row, and never lets one unreadable file hide the rest.
 */
async function readSupplierAttachments(
  replyId: string,
  saved: Array<{ id: string; filename: string; mimeType: string; storagePath: string; sha256: string }>,
): Promise<{ documents: SupplierAttachmentDocument[]; failures: string[]; packageSummary: DocumentPackageSummary | null }> {
  if (saved.length === 0) return { documents: [], failures: [], packageSummary: null };
  try {
    const result = await processDocumentPackage({
      key: `supplier-reply:${replyId}`,
      supplierReplyId: replyId,
      attachments: saved.map((file) => ({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        storagePath: file.storagePath,
        sha256: file.sha256,
      })),
    });
    const documents: SupplierAttachmentDocument[] = result.documents.map((entry) => ({
      attachmentId: entry.attachmentId,
      filename: entry.filename,
      text: entry.analysis.text,
      status: entry.analysis.status,
      note: entry.analysis.note,
      pageCount: entry.analysis.pageCount,
      images: entry.analysis.images,
    }));
    const failures = [
      ...result.summary.failures.map((failure) => `${failure.filename}: ${failure.reason}`),
      ...result.summary.unsupported.map((failure) => `${failure.filename}: ${failure.reason}`),
      ...result.summary.partial.map((failure) => `${failure.filename}: ${failure.reason}`),
    ];
    return { documents, failures, packageSummary: result.summary };
  } catch (error) {
    // Keep the stored email and files even when package bookkeeping fails. The
    // attachment rows still exist and can be retried.
    console.error("[supplier-reply] document package processing failed", {
      replyId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return {
      documents: saved.map((file) => ({
        attachmentId: file.id,
        filename: file.filename,
        text: "",
        status: "FAILED" as const,
        note: "The attached file needs a manual check because automatic reading was unavailable.",
        pageCount: null,
      })),
      failures: ["Some attachments need a manual check because automatic reading was unavailable."],
      packageSummary: null,
    };
  }
}

/**
 * Fills terms the email body did not state from the supplier's own attachments.
 * Body wording always wins; every attachment-sourced value keeps the file and
 * page/sheet reference that produced it, and unknown values stay null.
 */
export function mergeSupplierAttachmentTerms(
  bodyTerms: SupplierQuoteTerms,
  documents: SupplierAttachmentDocument[],
): {
  terms: SupplierQuoteTerms;
  provenance: Record<string, string>;
  fromAttachments: string[];
  evidence: SupplierAttachmentEvidence[];
} {
  const terms: SupplierQuoteTerms = {
    ...bodyTerms,
    confidence: { ...bodyTerms.confidence },
    certifications: [...bodyTerms.certifications],
  };
  const provenance: Record<string, string> = {};
  const fromAttachments: string[] = [];
  const evidence: SupplierAttachmentEvidence[] = [];

  for (const document of documents) {
    const extracted = extractSupplierQuoteTerms(document.text, document.filename);
    const sourceRefs = sourceRefsFromText(document.text);
    const where = sourceRefs.length > 0 ? `${document.filename} (${sourceRefs[0]})` : document.filename;
    const fieldsFound: string[] = [];

    for (const field of MERGEABLE_TERM_FIELDS) {
      if (terms[field] != null) continue;
      const value = extracted[field];
      if (value == null) continue;
      (terms as unknown as Record<string, unknown>)[field] = value;
      terms.confidence[field] = extracted.confidence[field] ?? 0.6;
      provenance[field] = where;
      fromAttachments.push(field);
      fieldsFound.push(field);
    }

    if (terms.certifications.length === 0 && extracted.certifications.length > 0) {
      terms.certifications = extracted.certifications;
      provenance.certifications = where;
      fromAttachments.push("certifications");
      fieldsFound.push("certifications");
    }

    evidence.push({
      attachmentId: document.attachmentId,
      filename: document.filename,
      pageCount: document.pageCount,
      status: document.status,
      note: document.note,
      sourceRefs,
      fieldsFound,
    });
  }

  terms.missingCommercial = missingCommercialFor(terms);
  return { terms, provenance, fromAttachments, evidence };
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
  attachmentEvidence: SupplierAttachmentEvidence[];
  attachmentProvenance: Record<string, string>;
  fieldsFromAttachments: string[];
  receivedAt: Date;
  /** AI pass result, retained as review evidence. Never an approval. */
  ai?: SupplierQuotationExtraction | null;
  aiMerge?: SupplierAiMerge | null;
  aiStatus?: string | null;
  senderIntent?: SupplierIntentDetection | null;
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
      quoteRef: terms.quoteRef ?? input.ai?.supplier_reference ?? `email:${input.replyId}`,
      // Every email/AI draft stays unverified until the owner approves the offer
      // on the sourcing screen. This function has no approval path.
      verificationStatus: "UNVERIFIED",
      offeredSpecJson: stringifyJson(offeredFastener),
      quoteItemId,
      evidenceJson: stringifyJson({
        source: "supplier_email_reply",
        supplierReplyId: input.replyId,
        originalWording: input.bodySummary.slice(0, 2000),
        attachmentNames: input.attachmentNames,
        attachmentEvidence: input.attachmentEvidence,
        attachmentProvenance: input.attachmentProvenance,
        fieldsFromAttachments: input.fieldsFromAttachments,
        statedTerms: terms,
        extractionConfidence: terms.confidence,
        missingCommercial: terms.missingCommercial,
        deliveryTerms: terms.deliveryTerms,
        certifications: terms.certifications,
        countryOfOrigin: terms.countryOfOrigin,
        match: { status: match.status, reasons: match.reasons, mismatches: match.mismatches, missing: match.missing },
        aiExtraction: {
          status: input.aiStatus ?? (input.ai ? "OK" : "NOT_RUN"),
          intent: input.senderIntent?.intent ?? input.ai?.supplier_intent ?? null,
          intentSource: input.senderIntent?.source ?? null,
          intentConfidence: input.senderIntent?.confidence ?? null,
          intentReason: input.senderIntent?.reason ?? null,
          supplierName: input.ai?.supplier_name ?? null,
          supplierReference: input.ai?.supplier_reference ?? null,
          confidence: input.ai?.extraction_confidence ?? null,
          clarificationsRequired: input.aiMerge?.clarifications ?? input.ai?.clarifications_required ?? [],
          quotedItems: input.ai?.quoted_items ?? [],
          generalTerms: input.ai?.general_terms ?? null,
          primaryItem: input.aiMerge?.primaryItem ?? null,
          provenance: input.aiMerge?.provenance ?? {},
          fieldsFromAi: input.aiMerge?.fieldsFromAi ?? [],
          conflicts: input.aiMerge?.conflicts ?? [],
        },
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

  // Duplicate protection covers review candidates from unknown senders too,
  // not only messages from the supplier directory.
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

  // An unknown sender is evaluated for supplier intent before customer intake.
  // Reading a priced attachment is necessary: a supplier often writes only
  // "please find attached" and puts every price in the PDF/XLSX.
  let senderIntent: SupplierIntentDetection | null = null;
  if (!supplier) {
    const probeDocuments: Array<{ filename: string; text: string }> = [];
    const quick = detectSupplierIntentByRules({
      subject: input.subject,
      body: input.body,
      documents: (input.attachments ?? []).map((file) => ({ filename: file.filename, text: "" })),
    });
    if (quick.supplierPlausible === false && (input.attachments?.length ?? 0) > 0) {
      for (const file of (input.attachments ?? []).slice(0, 2)) {
        try {
          const probe = await extractDocument(file.buffer, file.filename);
          if (probe.text.trim().length > 0) {
            probeDocuments.push({ filename: file.filename, text: probe.text.slice(0, 12_000) });
          }
        } catch {
          // An unreadable probe must not block intent detection or customer intake.
        }
      }
    }
    senderIntent = await detectSupplierIntent({
      subject: input.subject,
      body: input.body,
      fromName: input.fromName ?? null,
      documents: probeDocuments,
      // Unknown-sender privacy stays opt-in. A clearly priced business document
      // may be assessed because it is not personal correspondence.
      allowAi:
        env.AI_FOR_UNKNOWN_SENDERS === "true" ||
        quick.supplierPlausible ||
        probeDocuments.some((document) => /(?:aed|usd|eur|price|quotation|unit\s*price|سعر|عرض)/i.test(document.text.slice(0, 12_000))),
    });
    if (!senderIntent.supplierPlausible) {
      return { handled: false, reason: senderIntent.reason };
    }
  }

  const validationFailures: string[] = [];
  const organizationId = await requireTenantId();
  const readiness = storageReadiness();
  const savedAttachments: Array<{ id: string; filename: string; mimeType: string; sha256: string; sizeBytes: number; storagePath: string }> = [];
  const reply = await db.supplierEmailReply.create({
    data: {
      supplierId: supplier?.id ?? null,
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
        const check = assertAllowedUpload(file.buffer, file.filename, { allowUnsupported: true });
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
            mimeType: attachment.mimeType,
            sha256: attachment.sha256,
            sizeBytes: attachment.sizeBytes,
            storagePath: stored.storagePath,
          });
        } catch (error) {
          validationFailures.push(
            `${file.filename}: ${error instanceof Error ? error.message.slice(0, 160) : "could not be stored"}`,
          );
        }
      }
    }
  }

  // Read the supplier's attachments now. Storing a price-list PDF without
  // reading it is the gap this pass closes.
  const attachmentReading = await readSupplierAttachments(reply.id, savedAttachments);

  const unknownToken = extractCorrelationToken(`${input.subject ?? ""}\n${input.body}`);
  const unknownStrongSignals = [
    ...(input.providerThreadId ? [{ providerThreadId: input.providerThreadId }] : []),
    ...(unknownToken ? [{ correlationToken: unknownToken }] : []),
  ];
  const quoteInclude = {
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
  } as const;
  const quotes = supplier
    ? await db.supplierQuote.findMany({
        where: {
          supplierId: supplier.id,
          status: { in: ["SENT", "RESPONDED", "REQUESTED", "AWAITING_APPROVAL"] },
        },
        include: quoteInclude,
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    : unknownStrongSignals.length > 0
      ? await db.supplierQuote.findMany({
          where: {
            status: { in: ["SENT", "RESPONDED", "REQUESTED", "AWAITING_APPROVAL"] },
            OR: unknownStrongSignals,
          },
          include: quoteInclude,
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [];

  const candidates: ReplyCorrelationCandidate[] = quotes.map((quote) => ({
    quoteId: quote.id,
    supplierId: quote.supplierId,
    supplierEmail: supplier?.email ?? null,
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

  const bodyTerms = extractSupplierQuoteTerms(input.body, input.subject);
  const merged = mergeSupplierAttachmentTerms(bodyTerms, attachmentReading.documents);
  const terms = merged.terms;
  const matchedQuote = correlation.quoteId ? quotes.find((quote) => quote.id === correlation.quoteId) : null;

  // AI reads the whole response (body + every readable attachment). It is an
  // enhancement, never a prerequisite: a provider failure leaves the
  // deterministic terms intact and the reply reviewable.
  const aiDocuments = attachmentReading.documents
    .filter((document) => document.text.trim().length > 0 || (document.images?.length ?? 0) > 0)
    .map((document) => ({
      filename: document.filename,
      text: document.text,
      pageCount: document.pageCount,
      status: document.status,
      images: document.images,
    }));
  let aiOutcome: SupplierExtractionOutcome = {
    status: "FAILED",
    error: "The AI reading pass did not run.",
  };
  try {
    aiOutcome = await extractSupplierQuotation({
      subject: input.subject,
      body: input.body,
      fromName: input.fromName ?? null,
      fromAddress: from,
      documents: aiDocuments,
      rfqItems: matchedQuote?.enquiryItem
        ? [{ ref: "RFQ-ITEM-1", description: matchedQuote.enquiryItem.description }]
        : [],
    });
  } catch (error) {
    aiOutcome = {
      status: "FAILED",
      error: error instanceof Error ? error.message.slice(0, 300) : "AI extraction failed.",
    };
  }
  const aiData = aiOutcome.status === "OK" ? aiOutcome.data : null;
  const aiMerge = aiData
    ? mergeAiSupplierExtraction(terms, aiData, {
        rfqRef: matchedQuote?.enquiryItem ? "RFQ-ITEM-1" : null,
        rfqDescription: matchedQuote?.enquiryItem?.description ?? null,
      })
    : null;
  const finalTerms = aiMerge?.terms ?? terms;

  let offerId: string | null = null;
  if (correlation.status === "MATCHED" && matchedQuote) {
    offerId = await materializeOffer({
      replyId: reply.id,
      quote: matchedQuote,
      terms: finalTerms,
      bodySummary: input.body,
      attachmentNames: savedAttachments.map((attachment) => attachment.filename),
      attachmentEvidence: merged.evidence,
      attachmentProvenance: merged.provenance,
      fieldsFromAttachments: merged.fromAttachments,
      receivedAt: input.receivedAt ?? new Date(),
      ai: aiData,
      aiMerge,
      aiStatus: aiOutcome.status,
      senderIntent,
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

  const attachmentFailures = [...validationFailures, ...attachmentReading.failures];
  const hasTerms =
    finalTerms.unitPrice != null ||
    finalTerms.description != null ||
    (aiData?.quoted_items.length ?? 0) > 0;
  const extractionStatus = hasTerms
    ? "EXTRACTED"
    : savedAttachments.length > 0 && attachmentFailures.length > 0
      ? "FAILED"
      : "NO_TERMS";
  const offerIds = offerId ? [offerId] : [];
  const aiError = aiOutcome.status === "OK" ? null : aiOutcome.error;
  const aiIntent = aiData?.supplier_intent ?? senderIntent?.intent ?? null;
  const aiConfidence = aiData?.extraction_confidence ?? senderIntent?.confidence ?? null;
  const quotedItems = aiData?.quoted_items ?? [];
  const primaryQuotedItemIndex = aiMerge?.primaryItem ? quotedItems.indexOf(aiMerge.primaryItem) : null;
  const aiProvenance = { ...merged.provenance, ...(aiMerge?.provenance ?? {}) };
  const conflicts = aiMerge?.conflicts ?? [];
  const clarificationsRequired = aiMerge?.clarifications ?? aiData?.clarifications_required ?? [];

  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      supplierQuoteId: correlation.quoteId,
      matchingStatus: correlation.status,
      correlationJson: stringifyJson({
        ...correlation,
        senderIntent,
        aiExtraction: {
          status: aiOutcome.status,
          error: aiError,
          intent: aiIntent,
          supplierName: aiData?.supplier_name ?? null,
          supplierReference: aiData?.supplier_reference ?? null,
          currency: aiData?.currency ?? null,
          confidence: aiConfidence,
          generalTerms: aiData?.general_terms ?? null,
          clarificationsRequired,
          quotedItems,
          primaryQuotedItemIndex,
          conflicts,
          fieldsFromAi: aiMerge?.fieldsFromAi ?? [],
          provenance: aiMerge?.provenance ?? {},
          usage: aiOutcome.status === "OK" ? (aiOutcome.usage ?? null) : null,
        },
        offerIds,
        attachmentFailures,
        documentExtraction: merged.evidence,
        documentPackage: attachmentReading.packageSummary,
        fieldsFromAttachments: merged.fromAttachments,
      }),
      extractedJson: stringifyJson({
        ...finalTerms,
        ai: aiData,
        aiStatus: aiOutcome.status,
        aiError,
        aiIntent,
        aiConfidence,
        quotedItems,
        primaryQuotedItemIndex,
        generalTerms: aiData?.general_terms ?? null,
        clarificationsRequired,
        conflicts,
        aiFields: aiMerge?.fieldsFromAi ?? [],
        provenance: aiProvenance,
        offerIds,
        review: null,
      }),
      extractionStatus,
      attachmentsJson: stringifyJson(savedAttachments),
      processedAt: new Date(),
    },
  });

  // A transient provider failure is retried by the durable worker, bounded by
  // maxAttempts and one idempotency key. Invalid output, configuration and
  // budget failures are not retried: repeating the same request cannot fix them.
  const transientAiFailure =
    aiOutcome.status === "FAILED" &&
    /timed out|timeout|rate.?limit|returned (?:429|5\d\d)|fetch failed|network|ECONN|socket/i.test(aiOutcome.error);
  if (transientAiFailure) {
    await enqueueJob({
      type: JOB_TYPES.EXTRACT_SUPPLIER_REPLY,
      payload: { replyId: reply.id },
      idempotencyKey: `supplier-reply-ai:${reply.id}`,
      maxAttempts: 3,
    }).catch(() => undefined);
  }

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
      supplierId: supplier?.id ?? null,
      matchingStatus: correlation.status,
      method: correlation.method,
      attachmentFailures: attachmentFailures.length,
      attachmentsRead: attachmentReading.documents.filter((document) => document.status !== "FAILED").length,
      fieldsFromAttachments: merged.fromAttachments,
      offerId,
    },
  });

  if (!supplier) {
    await notifyOwner({
      type: "SUPPLIER_REPLY_UNKNOWN",
      title: "A possible supplier quotation needs review",
      body: `${input.fromName ?? from}: ${(input.subject ?? "no subject").slice(0, 120)} — ${String(
        aiIntent ?? "supplier message",
      )
        .replaceAll("_", " ")
        .toLowerCase()}`,
      link: `/suppliers/replies`,
    });
  } else if (correlation.status !== "MATCHED") {
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
    reason: attachmentFailures.length > 0 ? attachmentFailures.join(" ") : undefined,
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
  // An unknown sender has no supplierId until the owner links one. Once linked,
  // the RFQ must belong to that supplier.
  if (reply.supplierId && quote.supplierId !== reply.supplierId) {
    return { ok: false, error: "That RFQ was sent to a different supplier." };
  }

  const stored = parseJson<
    (SupplierQuoteTerms & { ai?: SupplierQuotationExtraction | null; aiStatus?: string | null }) | null
  >(reply.extractedJson, null);
  const terms = stored ?? extractSupplierQuoteTerms(reply.bodySummary ?? "", reply.subject);

  const offerId = await materializeOffer({
    replyId: reply.id,
    quote,
    terms,
    bodySummary: reply.bodySummary ?? "",
    attachmentNames: parseJson<Array<{ filename: string }>>(reply.attachmentsJson, []).map(
      (attachment) => attachment.filename,
    ),
    attachmentEvidence: [],
    attachmentProvenance: {},
    fieldsFromAttachments: [],
    receivedAt: reply.receivedAt,
    ai: stored?.ai ?? null,
    aiStatus: stored?.aiStatus ?? "STORED",
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

// ── Owner review, correction and reprocessing ──────────────────────────────

type StoredQuotedItem = SupplierQuotedItem & { irrelevant?: boolean; irrelevantNote?: string | null };

export type SupplierReplyStored = SupplierQuoteTerms & {
  ai?: SupplierQuotationExtraction | null;
  aiStatus?: string | null;
  quotedItems?: StoredQuotedItem[];
  primaryQuotedItemIndex?: number | null;
  offerIds?: string[];
  provenance?: Record<string, string>;
  review?: { confirmedAt?: string; confirmedBy?: string; userId?: string } | null;
  ownerCorrections?: Record<string, { value: string | number | null; at: string; by: string }>;
};

function parseStoredTerms(json: string | null, body: string | null, subject: string | null): SupplierReplyStored {
  return (
    parseJson<SupplierReplyStored | null>(json, null) ?? {
      ...extractSupplierQuoteTerms(body ?? "", subject),
      quotedItems: [],
      offerIds: [],
    }
  );
}

/**
 * Re-runs the AI pass for a retained reply using the attachments already stored
 * on disk. It only fills gaps and refreshes evidence; existing offer values are
 * never overwritten and the offer remains UNVERIFIED. Throws on a transient
 * provider failure so the durable job can apply its bounded retry/backoff.
 */
export async function enrichSupplierReplyAi(replyId: string): Promise<{
  status: "OK" | "NOT_CONFIGURED" | "BUDGET_BLOCKED";
  error?: string;
}> {
  const reply = await db.supplierEmailReply.findUnique({
    where: { id: replyId },
    include: {
      attachments: true,
      supplierQuote: { include: { enquiryItem: { select: { id: true, description: true } } } },
    },
  });
  if (!reply) throw new Error("Supplier reply not found.");

  const documents: Array<{ filename: string; text: string; pageCount: number | null; status: string; images?: string[] }> = [];
  for (const attachment of reply.attachments) {
    let text = attachment.textExtract ?? "";
    let pageCount = attachment.pageCount;
    let status = attachment.extractionStatus;
    let images: string[] | undefined;
    if (attachment.storagePath) {
      try {
        // Re-read on an explicit owner retry to regenerate transient vision
        // payloads. Image data URLs are intentionally not stored in the DB.
        const buffer = await readAttachment(attachment.storagePath);
        const doc = await extractDocument(buffer, attachment.filename);
        text = doc.text.trim() ? doc.text : text;
        pageCount = doc.pageCount ?? pageCount;
        status = doc.status;
        images = doc.images;
        await db.attachment.update({
          where: { id: attachment.id },
          data: {
            ...(doc.text.trim() ? { textExtract: doc.text.slice(0, 80_000) } : {}),
            pageCount,
            extractionStatus: status,
            extractionNote: doc.note,
          },
        });
      } catch {
        // Keep the original attachment record; a failed re-read is reviewable.
      }
    }
    if (text.trim() || (images?.length ?? 0) > 0) {
      documents.push({ filename: attachment.filename, text, pageCount, status, images });
    }
  }

  const stored = parseStoredTerms(reply.extractedJson, reply.bodySummary, reply.subject);
  const description = reply.supplierQuote?.enquiryItem?.description ?? null;
  const correlation = parseJson<Record<string, unknown>>(reply.correlationJson, {});
  const outcome = await extractSupplierQuotation({
    subject: reply.subject,
    body: reply.bodySummary ?? "",
    fromName: reply.fromName,
    fromAddress: reply.fromAddress,
    documents,
    rfqItems: description ? [{ ref: "RFQ-ITEM-1", description }] : [],
  });

  if (outcome.status !== "OK") {
    await db.supplierEmailReply.update({
      where: { id: reply.id },
      data: {
        correlationJson: stringifyJson({
          ...correlation,
          aiExtraction: {
            ...(typeof correlation.aiExtraction === "object" && correlation.aiExtraction !== null
              ? (correlation.aiExtraction as Record<string, unknown>)
              : {}),
            status: outcome.status,
            error: outcome.error,
            lastAttemptAt: new Date().toISOString(),
          },
        }),
      },
    });
    if (outcome.status === "FAILED") throw new Error(outcome.error);
    return { status: outcome.status, error: outcome.error };
  }

  const aiMerge = mergeAiSupplierExtraction(stored, outcome.data, {
    rfqRef: description ? "RFQ-ITEM-1" : null,
    rfqDescription: description,
  });
  const quotedItems = outcome.data.quoted_items;
  const offerIds = Array.isArray(stored.offerIds) ? stored.offerIds : [];
  const primaryQuotedItemIndex = aiMerge.primaryItem ? quotedItems.indexOf(aiMerge.primaryItem) : null;

  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      extractedJson: stringifyJson({
        ...aiMerge.terms,
        ai: outcome.data,
        aiStatus: "OK",
        aiError: null,
        aiIntent: outcome.data.supplier_intent,
        aiConfidence: outcome.data.extraction_confidence ?? null,
        quotedItems,
        primaryQuotedItemIndex,
        generalTerms: outcome.data.general_terms,
        clarificationsRequired: aiMerge.clarifications,
        conflicts: aiMerge.conflicts,
        aiFields: aiMerge.fieldsFromAi,
        provenance: { ...(stored.provenance ?? {}), ...aiMerge.provenance },
        offerIds,
        review: stored.review ?? null,
        ownerCorrections: stored.ownerCorrections ?? {},
      }),
      extractionStatus: "EXTRACTED",
      correlationJson: stringifyJson({
        ...correlation,
        aiExtraction: {
          status: "OK",
          error: null,
          intent: outcome.data.supplier_intent,
          supplierName: outcome.data.supplier_name,
          supplierReference: outcome.data.supplier_reference,
          currency: outcome.data.currency,
          confidence: outcome.data.extraction_confidence ?? null,
          generalTerms: outcome.data.general_terms,
          clarificationsRequired: aiMerge.clarifications,
          quotedItems,
          primaryQuotedItemIndex,
          conflicts: aiMerge.conflicts,
          fieldsFromAi: aiMerge.fieldsFromAi,
          provenance: aiMerge.provenance,
          usage: outcome.usage ?? null,
          lastAttemptAt: new Date().toISOString(),
        },
      }),
      processedAt: new Date(),
    },
  });

  for (const offerId of offerIds) {
    const offer = await db.supplierOffer.findUnique({ where: { id: offerId } });
    if (!offer) continue;
    const evidence = parseJson<Record<string, unknown>>(offer.evidenceJson, {});
    await db.supplierOffer.update({
      where: { id: offerId },
      data: {
        unitPrice: offer.unitPrice ?? aiMerge.terms.unitPrice,
        currency: offer.currency ?? aiMerge.terms.currency,
        quantityAvailable: offer.quantityAvailable ?? aiMerge.terms.quantityAvailable,
        moq: offer.moq ?? aiMerge.terms.moq,
        leadTimeDays: offer.leadTimeDays ?? aiMerge.terms.leadTimeDays,
        shippingCost: offer.shippingCost ?? aiMerge.terms.shippingCost,
        otherCharges: offer.otherCharges ?? aiMerge.terms.otherCharges,
        taxes: offer.taxes ?? aiMerge.terms.taxes,
        paymentTerms: offer.paymentTerms ?? aiMerge.terms.paymentTerms,
        evidenceJson: stringifyJson({
          ...evidence,
          aiExtraction: {
            ...(typeof evidence.aiExtraction === "object" && evidence.aiExtraction !== null
              ? (evidence.aiExtraction as Record<string, unknown>)
              : {}),
            status: "OK",
            intent: outcome.data.supplier_intent,
            confidence: outcome.data.extraction_confidence ?? null,
            quotedItems,
            primaryItem: aiMerge.primaryItem,
            provenance: aiMerge.provenance,
            fieldsFromAi: aiMerge.fieldsFromAi,
            conflicts: aiMerge.conflicts,
            clarificationsRequired: aiMerge.clarifications,
          },
        }),
      },
    });
    await recomputeOffersForItem(offer.enquiryItemId).catch(() => undefined);
  }

  await writeAudit({
    action: "supplier_reply.ai_reprocessed",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    actorLabel: "system",
    meta: {
      intent: outcome.data.supplier_intent,
      quotedItems: quotedItems.length,
      fieldsFilled: aiMerge.fieldsFromAi,
      conflicts: aiMerge.conflicts.length,
    },
  });
  return { status: "OK" };
}

export type SupplierReplyFieldCorrection = {
  unitPrice?: number | null;
  currency?: string | null;
  moq?: number | null;
  leadTimeDays?: number | null;
  shippingCost?: number | null;
  taxes?: number | null;
  paymentTerms?: string | null;
  validityDays?: number | null;
  description?: string | null;
};

/**
 * Owner correction of individual extracted fields. This updates the draft offer
 * too, but deliberately leaves its verification status untouched: correcting a
 * value is not approving the offer.
 */
export async function updateSupplierReplyExtractionFields(input: {
  replyId: string;
  fields: SupplierReplyFieldCorrection;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const reply = await db.supplierEmailReply.findUnique({ where: { id: input.replyId } });
  if (!reply) return { ok: false, error: "Supplier reply not found." };

  const stored = parseStoredTerms(reply.extractedJson, reply.bodySummary, reply.subject);
  const updates: Record<string, string | number | null> = {};
  const corrections = { ...(stored.ownerCorrections ?? {}) };
  const at = new Date().toISOString();

  const numericFields = ["unitPrice", "moq", "leadTimeDays", "shippingCost", "taxes", "validityDays"] as const;
  for (const field of numericFields) {
    const value = input.fields[field];
    if (value === undefined) continue;
    if (value === null) {
      updates[field] = null;
      corrections[field] = { value: null, at, by: input.actorLabel };
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${field} must be a positive number or left blank.` };
    }
    updates[field] = value;
    corrections[field] = { value, at, by: input.actorLabel };
  }

  if (input.fields.currency !== undefined) {
    const currency = (input.fields.currency ?? "").trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, error: "Currency must be a three-letter code such as AED or USD." };
    }
    updates.currency = currency || null;
    corrections.currency = { value: updates.currency, at, by: input.actorLabel };
  }
  if (input.fields.paymentTerms !== undefined) {
    const value = (input.fields.paymentTerms ?? "").trim().slice(0, 160);
    updates.paymentTerms = value || null;
    corrections.paymentTerms = { value: updates.paymentTerms, at, by: input.actorLabel };
  }
  if (input.fields.description !== undefined) {
    const value = (input.fields.description ?? "").trim().slice(0, 500);
    updates.description = value || null;
    corrections.description = { value: updates.description, at, by: input.actorLabel };
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "Enter at least one corrected value." };
  }

  const merged = { ...stored, ...updates };
  merged.missingCommercial = missingCommercialFor(merged);
  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      extractedJson: stringifyJson({ ...merged, ownerCorrections: corrections }),
      reviewStatus: "REVIEWED",
      processedAt: new Date(),
    },
  });

  const offerIds = Array.isArray(stored.offerIds) ? stored.offerIds : [];
  for (const offerId of offerIds) {
    const offer = await db.supplierOffer.findUnique({ where: { id: offerId } });
    if (!offer) continue;
    const evidence = parseJson<Record<string, unknown>>(offer.evidenceJson, {});
    const validityDays =
      updates.validityDays === undefined ? undefined : (updates.validityDays as number | null);
    await db.supplierOffer.update({
      where: { id: offerId },
      data: {
        ...(updates.unitPrice !== undefined ? { unitPrice: updates.unitPrice as number | null } : {}),
        ...(updates.currency !== undefined ? { currency: updates.currency as string | null } : {}),
        ...(updates.moq !== undefined ? { moq: updates.moq as number | null } : {}),
        ...(updates.leadTimeDays !== undefined
          ? { leadTimeDays: updates.leadTimeDays == null ? null : Math.round(updates.leadTimeDays as number) }
          : {}),
        ...(updates.shippingCost !== undefined ? { shippingCost: updates.shippingCost as number | null } : {}),
        ...(updates.taxes !== undefined ? { taxes: updates.taxes as number | null } : {}),
        ...(updates.paymentTerms !== undefined ? { paymentTerms: updates.paymentTerms as string | null } : {}),
        ...(updates.description !== undefined && updates.description !== null
          ? { productTitle: updates.description as string }
          : {}),
        ...(validityDays !== undefined
          ? {
              validityDate:
                validityDays == null
                  ? null
                  : new Date(reply.receivedAt.getTime() + validityDays * 24 * 60 * 60 * 1000),
            }
          : {}),
        evidenceJson: stringifyJson({
          ...evidence,
          ownerCorrections: corrections,
        }),
      },
    });
    await recomputeOffersForItem(offer.enquiryItemId).catch(() => undefined);
  }

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_reply.fields_corrected",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    meta: { fields: Object.keys(updates) },
  });
  return { ok: true };
}

/** Confirms that the owner checked the extraction. It does not verify an offer. */
export async function confirmSupplierReplyExtraction(input: {
  replyId: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const reply = await db.supplierEmailReply.findUnique({ where: { id: input.replyId } });
  if (!reply) return { ok: false, error: "Supplier reply not found." };
  const stored = parseStoredTerms(reply.extractedJson, reply.bodySummary, reply.subject);
  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: {
      extractedJson: stringifyJson({
        ...stored,
        review: {
          confirmedAt: new Date().toISOString(),
          confirmedBy: input.actorLabel,
          userId: input.userId,
        },
      }),
      reviewStatus: "REVIEWED",
    },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_reply.extraction_confirmed",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    meta: { offerIds: stored.offerIds ?? [], offerVerificationUnchanged: true },
  });
  return { ok: true };
}

/** Marks one quoted product irrelevant without deleting it or approving anything. */
export async function markSupplierReplyQuotedItemIrrelevant(input: {
  replyId: string;
  itemIndex: number;
  note?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const reply = await db.supplierEmailReply.findUnique({ where: { id: input.replyId } });
  if (!reply) return { ok: false, error: "Supplier reply not found." };
  const stored = parseStoredTerms(reply.extractedJson, reply.bodySummary, reply.subject);
  const items = [...(stored.quotedItems ?? [])];
  if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0 || input.itemIndex >= items.length) {
    return { ok: false, error: "Quoted product not found." };
  }
  items[input.itemIndex] = {
    ...items[input.itemIndex],
    irrelevant: true,
    irrelevantNote: input.note?.slice(0, 300) ?? null,
  };
  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: { extractedJson: stringifyJson({ ...stored, quotedItems: items }) },
  });

  if (stored.primaryQuotedItemIndex === input.itemIndex && (stored.offerIds?.length ?? 0) > 0) {
    await db.supplierOffer.updateMany({
      where: { id: { in: stored.offerIds } },
      data: {
        isEligible: false,
        ineligibilityReason: "Owner marked the quoted product as irrelevant.",
      },
    });
  }

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_reply.quoted_item_irrelevant",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    meta: { itemIndex: input.itemIndex, note: input.note ?? null },
  });
  return { ok: true };
}

/** Links an unknown sender to an existing supplier after owner review. */
export async function linkSupplierReplyToSupplier(input: {
  replyId: string;
  supplierId: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supplier = await db.supplier.findFirst({ where: { id: input.supplierId } });
  if (!supplier) return { ok: false, error: "Supplier not found." };
  const reply = await db.supplierEmailReply.findUnique({ where: { id: input.replyId } });
  if (!reply) return { ok: false, error: "Supplier reply not found." };
  if (reply.supplierId && reply.supplierId !== supplier.id) {
    return { ok: false, error: "This reply is already linked to a different supplier." };
  }
  if (reply.supplierQuoteId) {
    const quote = await db.supplierQuote.findUnique({ where: { id: reply.supplierQuoteId } });
    if (quote && quote.supplierId !== supplier.id) {
      return { ok: false, error: "The matched RFQ was sent to a different supplier." };
    }
  }
  await db.supplierEmailReply.update({
    where: { id: reply.id },
    data: { supplierId: supplier.id },
  });
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_reply.sender_linked",
    entityType: "SupplierEmailReply",
    entityId: reply.id,
    meta: { supplierId: supplier.id, fromAddress: reply.fromAddress },
  });
  return { ok: true };
}
