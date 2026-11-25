import { z } from "zod";
import { aiStatus, completeJson, DATA_ONLY_RULE } from "../../ai/provider";
import {
  detectCurrency,
  extractAvailability,
  extractLeadTimeDays,
  extractMoq,
  extractPriceFromText,
  extractSpecsFromText,
} from "../extract";
import { extractPublicContacts } from "../contacts";
import type {
  ResearchEvidenceClaim,
  ResearchSupplierProfile,
  EvidenceSourceType,
  EvidenceVerification,
} from "../../validation/research";

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(?:an?\s+)?(?:assistant|system|developer)/i,
  /reveal\s+(?:the\s+)?(?:system\s+prompt|secret|api\s*key|password)/i,
  /send\s+(?:an?\s+)?(?:email|message|payment|purchase\s+order)/i,
  /execute\s+(?:the\s+)?(?:tool|command|function)/i,
  /disregard\s+(?:the\s+)?(?:rules|instructions|guardrails)/i,
];

/** Fetched material is data, never instructions. This is a visible warning, not a filter. */
export function containsPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function pageTypeFor(url: string, title: string | null, text: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the supplied value for non-URL inputs.
  }
  const haystack = `${path} ${title ?? ""} ${text.slice(0, 4_000)}`.toLowerCase();
  // A document URL is decisive. Otherwise product evidence outranks a generic
  // navigation link that merely contains the word "catalogue". The hostname is
  // deliberately excluded: "gulf-fittings.example/contact" is a contact page,
  // not a product page just because the domain contains "fittings".
  if (/\.pdf(?:\?|$)|\/(?:catalog(?:ue)?|datasheets?|brochures?)(?:\/|$|\.)/i.test(path)) return "CATALOGUE";
  if (/contact|enquir|rfq|get\s*in\s*touch|اتصل/.test(path)) return "CONTACT";
  if (/about|company|profile|من\s*نحن/.test(path)) return "ABOUT";
  if (/certificat|quality|iso|api\s*q1/i.test(path)) return "CERTIFICATION";
  if (/location|branch|office|warehouse|دبي|الشارقة/.test(path)) return "LOCATION";
  if (/product|range|valve|fitting|flange|pipe|elbow|gasket|bolt|صمام|كوع|فلنجة/.test(haystack)) return "PRODUCT";
  if (/catalog(?:ue)?|datasheet|brochure/.test(haystack)) return "CATALOGUE";
  if (/contact|enquir|rfq|get\s*in\s*touch|اتصل/.test(haystack)) return "CONTACT";
  if (/about|company|profile|من\s*نحن/.test(haystack)) return "ABOUT";
  if (/certificat|iso\s*\d|api\s*\d|en\s*10204/.test(haystack)) return "CERTIFICATION";
  if (/location|branch|office|warehouse|دبي|الشارقة/.test(haystack)) return "LOCATION";
  return "OTHER";
}

export function pageIsRelevant(url: string, title: string | null, text: string, familyTerms: string[]): boolean {
  const haystack = `${url} ${title ?? ""} ${text.slice(0, 12_000)}`.toLowerCase();
  if (familyTerms.some((term) => haystack.includes(term.toLowerCase()))) return true;
  return /product|catalog|datasheet|technical|specification|valve|fitting|flange|pipe|gasket|fastener/.test(haystack);
}

function excerptAround(text: string, value: string, fallback = ""): string {
  const index = text.toLowerCase().indexOf(value.toLowerCase());
  if (index < 0) return fallback.slice(0, 500);
  const start = Math.max(0, index - 180);
  const end = Math.min(text.length, index + value.length + 180);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function claim(input: {
  field: string;
  value: string | null | undefined;
  sourceUrl: string;
  pageTitle?: string | null;
  sourceType: EvidenceSourceType;
  text: string;
  excerpt?: string | null;
  documentLocation?: string | null;
  pageNumber?: number | null;
  sheetName?: string | null;
  rowNumber?: number | null;
  retrievedAt: string;
  extractionMethod?: "DETERMINISTIC" | "AI" | "MANUAL";
  verificationStatus: EvidenceVerification;
  claim?: string;
}): ResearchEvidenceClaim | null {
  const value = (input.value ?? "").trim();
  if (!value) return null;
  const excerpt = (input.excerpt ?? excerptAround(input.text, value)).slice(0, 1_200);
  return {
    field: input.field,
    claim: input.claim ?? `${input.field} is ${value}`,
    value: value.slice(0, 400),
    sourceUrl: input.sourceUrl,
    pageTitle: input.pageTitle ?? null,
    sourceType: input.sourceType,
    excerpt,
    documentLocation: input.documentLocation ?? null,
    pageNumber: input.pageNumber ?? null,
    sheetName: input.sheetName ?? null,
    rowNumber: input.rowNumber ?? null,
    retrievedAt: input.retrievedAt,
    extractionMethod: input.extractionMethod ?? "DETERMINISTIC",
    verificationStatus: input.verificationStatus,
  };
}

const FIELD_PATTERNS: Array<{ field: string; pattern: RegExp }> = [
  { field: "material", pattern: /\b(?:ss\s*-?\s*(?:316l?|304l?)|stainless\s*steel(?:\s*(?:316l?|304l?))?|carbon\s*steel|mild\s*steel|cast\s*iron|ductile\s*iron|alloy\s*steel|duplex|monel|incoloy|inconel|brass|copper|pvc|upvc|ppr|hdpe|ptfe)\b/i },
  // A grade is the material grade (WPB, 8.8, A2-70…), not the manufacturing
  // standard. Keeping ASTM/ASME designations out of this field prevents a
  // standard from being mistaken for a grade match.
  { field: "grade", pattern: /\b(?:wp[bsx]\b|uns\s*[a-z]\d{4,5}|gr\.?\s*[0-9a-z.]+|8\.8|10\.9|a2-70|a4-70)\b/i },
  { field: "size", pattern: /\b(?:nps\s*\d+(?:\.\d+)?|dn\s*\d+|\d+(?:\.\d+)?\s*(?:inch|in|mm|"|”)|(?:\d+\/\d+)\s*(?:inch|in|"|”)?)\b/i },
  { field: "pressureRating", pattern: /\b(?:class\s*(?:150|300|400|600|900|1500|2500)|pn\s*\d+|\d+(?:\.\d+)?\s*(?:bar|psi))\b/i },
  { field: "schedule", pattern: /\b(?:sch\s*-?\s*\d+|schedule\s*\d+|std|xs|xxs)\b/i },
  { field: "standard", pattern: /\b(?:asme\s*b?\d+(?:\.\d+)?|ansi\s*b?\d+(?:\.\d+)?|astm\s*[a-z]\d+|api\s*\d+[a-z]?|din\s*\d+|bs\s*\d+|en\s*\d+|iso\s*\d+|nace\s*mr\d+|mss\s*sp\d+)\b/i },
  { field: "connection", pattern: /\b(?:butt\s*weld|socket\s*weld|threaded|flanged|welded|seamless|plain\s*end|bevel(?:led)?|rtj|raised\s*face|flat\s*face)\b/i },
  { field: "finish", pattern: /\b(?:hot\s*dip\s*galvanized|galvanized|zinc\s*plated|epoxy|fbe|painted|polished|pickled|passivated)\b/i },
  { field: "brand", pattern: /\b(?:brand|manufacturer|make)\s*[:=-]\s*([a-z0-9][a-z0-9 &.-]{1,50})/i },
  { field: "certification", pattern: /\b(?:iso\s*9001|iso\s*14001|iso\s*45001|api\s*q1|api\s*6d|en\s*10204\s*3\.1|ce\s*mark|atex)\b/i },
];

function fieldValue(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[0]).trim().slice(0, 240);
}

/**
 * Deterministic evidence extraction. Each claim keeps the exact page/excerpt
 * that produced it. Marketing claims such as "we supply all valves" are not
 * converted into a product match: the qualification stage requires a comparable
 * technical attribute from this evidence.
 */
export function extractDeterministicEvidence(input: {
  text: string;
  sourceUrl: string;
  pageTitle?: string | null;
  sourceType: EvidenceSourceType;
  retrievedAt?: string;
  pageNumber?: number | null;
  sheetName?: string | null;
  rowNumber?: number | null;
  documentLocation?: string | null;
}): ResearchEvidenceClaim[] {
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  const evidence: ResearchEvidenceClaim[] = [];
  const sourceType = input.sourceType;
  const verification: EvidenceVerification = sourceType === "SEARCH_SNIPPET" ? "SNIPPET_ONLY" : "SUPPORTED";
  for (const { field, pattern } of FIELD_PATTERNS) {
    const value = fieldValue(input.text, pattern);
    const built = claim({
      field,
      value,
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      sourceType,
      text: input.text,
      retrievedAt,
      verificationStatus: verification,
      pageNumber: input.pageNumber,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber,
      documentLocation: input.documentLocation,
    });
    if (built) evidence.push(built);
  }

  const specs = extractSpecsFromText(input.text);
  for (const field of ["material", "grade", "size", "pressureRating", "standard", "availability"] as const) {
    const value = specs[field];
    if (!value || evidence.some((entry) => entry.field === field)) continue;
    const built = claim({
      field,
      value,
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      sourceType,
      text: input.text,
      retrievedAt,
      verificationStatus: verification,
      pageNumber: input.pageNumber,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber,
      documentLocation: input.documentLocation,
    });
    if (built) evidence.push(built);
  }

  const price = extractPriceFromText(input.text);
  if (price.unitPrice != null) {
    const built = claim({
      field: "unitPrice",
      value: String(price.unitPrice),
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      sourceType,
      text: input.text,
      excerpt: price.priceText,
      retrievedAt,
      verificationStatus: verification,
      documentLocation: input.documentLocation,
    });
    if (built) evidence.push(built);
    const currency = claimForCurrency(price.currency, input, retrievedAt, verification);
    if (currency) evidence.push(currency);
  }
  const moq = extractMoq(input.text);
  if (moq != null) {
    const claim = claimForSimple("moq", String(moq), input, retrievedAt, verification);
    if (claim) evidence.push(claim);
  }
  const leadTime = extractLeadTimeDays(input.text);
  if (leadTime != null) {
    const claim = claimForSimple("leadTimeDays", String(leadTime), input, retrievedAt, verification);
    if (claim) evidence.push(claim);
  }
  const availability = extractAvailability(input.text);
  if (availability) {
    const claim = claimForSimple("availability", availability, input, retrievedAt, verification);
    if (claim) evidence.push(claim);
  }

  const contacts = extractPublicContacts(input.text, input.sourceUrl);
  for (const email of contacts.emails.slice(0, 3)) {
    const claim = claimForSimple("email", email, input, retrievedAt, verification);
    if (claim) evidence.push(claim);
  }
  for (const phone of contacts.phones.slice(0, 3)) {
    const claim = claimForSimple("phone", phone, input, retrievedAt, verification);
    if (claim) evidence.push(claim);
  }

  return evidence;
}

function claimForSimple(
  field: string,
  value: string,
  input: Parameters<typeof extractDeterministicEvidence>[0],
  retrievedAt: string,
  verification: EvidenceVerification,
): ResearchEvidenceClaim | null {
  return claim({
    field,
    value,
    sourceUrl: input.sourceUrl,
    pageTitle: input.pageTitle,
    sourceType: input.sourceType,
    text: input.text,
    retrievedAt,
    verificationStatus: verification,
    pageNumber: input.pageNumber,
    sheetName: input.sheetName,
    rowNumber: input.rowNumber,
    documentLocation: input.documentLocation,
  });
}

function claimForCurrency(
  currency: string | null,
  input: Parameters<typeof extractDeterministicEvidence>[0],
  retrievedAt: string,
  verification: EvidenceVerification,
): ResearchEvidenceClaim | null {
  const value = currency ?? detectCurrency(input.text);
  if (!value) return null;
  return claim({
    field: "currency",
    value,
    sourceUrl: input.sourceUrl,
    pageTitle: input.pageTitle,
    sourceType: input.sourceType,
    text: input.text,
    retrievedAt,
    verificationStatus: verification,
    documentLocation: input.documentLocation,
  });
}

export const AiEvidenceResponseSchema = z.object({
  supplier: z
    .object({
      name: z.string().max(220).nullable(),
      classification: z.enum(["MANUFACTURER", "DISTRIBUTOR", "STOCKIST", "TRADER", "UNKNOWN"]).default("UNKNOWN"),
      description: z.string().max(800).nullable(),
      countries: z.array(z.string().max(80)).max(8).default([]),
      locations: z.array(z.string().max(120)).max(12).default([]),
      productCategories: z.array(z.string().max(120)).max(20).default([]),
      capabilities: z.array(z.string().max(160)).max(20).default([]),
      certifications: z.array(z.string().max(160)).max(20).default([]),
    })
    .optional(),
  claims: z
    .array(
      z.object({
        field: z.string().min(1).max(60),
        value: z.string().max(400),
        excerpt: z.string().max(1000),
        claim: z.string().max(240).optional(),
      }),
    )
    .max(40)
    .default([]),
});

/**
 * Optional AI reading pass. A claim is accepted only when its excerpt exists in
 * the fetched text and its value is present in that excerpt. This makes it
 * impossible for the model to turn a guess into a verified supplier fact.
 */
export async function extractAiEvidence(input: {
  text: string;
  sourceUrl: string;
  pageTitle?: string | null;
  sourceType: EvidenceSourceType;
  retrievedAt?: string;
  pageNumber?: number | null;
  documentLocation?: string | null;
  enquiryId?: string | null;
}): Promise<{
  claims: ResearchEvidenceClaim[];
  supplier: ResearchAiSupplier | null;
  usage?: { inputTokens: number; outputTokens: number; model: string };
}> {
  if (!aiStatus().configured || input.text.trim().length < 30) return { claims: [], supplier: null };
  const result = await completeJson(
    {
      system:
        "You read one publicly fetched supplier page for procurement research. Extract only facts explicitly stated on the page. " +
        "Never infer stock, price, lead time, certification, a standard equivalence or a technical attribute that is not written. " +
        "Every claim must include a short excerpt copied verbatim from the page. Omit anything uncertain. " +
        "Return JSON only: {\"supplier\":{\"name\":string|null,\"classification\":\"MANUFACTURER\"|\"DISTRIBUTOR\"|\"STOCKIST\"|\"TRADER\"|\"UNKNOWN\",\"description\":string|null,\"countries\":string[],\"locations\":string[],\"productCategories\":string[],\"capabilities\":string[],\"certifications\":string[]},\"claims\":[{\"field\":string,\"value\":string,\"excerpt\":string,\"claim\":string}]}. " +
        DATA_ONLY_RULE,
      user: `<document url="${input.sourceUrl}">${input.text.slice(0, 18_000)}</document>`,
      maxTokens: 1_600,
      jobType: "sourcing.deep_research.evidence",
      enquiryId: input.enquiryId ?? null,
    },
    AiEvidenceResponseSchema,
  );
  if (!result.ok) return { claims: [], supplier: null };
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  const lowerText = input.text.toLowerCase();
  const claims: ResearchEvidenceClaim[] = [];
  for (const entry of result.data.claims) {
    const excerpt = entry.excerpt.trim();
    const value = entry.value.trim();
    if (!excerpt || !value) continue;
    if (!lowerText.includes(excerpt.toLowerCase())) continue;
    if (!excerpt.toLowerCase().includes(value.toLowerCase())) continue;
    const built = claim({
      field: entry.field,
      value,
      claim: entry.claim,
      excerpt,
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      sourceType: input.sourceType,
      text: input.text,
      retrievedAt,
      pageNumber: input.pageNumber,
      documentLocation: input.documentLocation,
      extractionMethod: "AI",
      verificationStatus: "SUPPORTED",
    });
    if (built) claims.push(built);
  }
  return {
    claims,
    supplier: result.data.supplier
      ? {
          name: result.data.supplier.name,
          classification: result.data.supplier.classification,
          description: result.data.supplier.description,
          countries: result.data.supplier.countries,
          locations: result.data.supplier.locations,
          productCategories: result.data.supplier.productCategories,
          capabilities: result.data.supplier.capabilities,
          certifications: result.data.supplier.certifications,
        }
      : null,
    usage: result.usage,
  };
}

export type ResearchAiSupplier = {
  name: string | null;
  classification: ResearchSupplierProfile["classification"];
  description: string | null;
  countries: string[];
  locations: string[];
  productCategories: string[];
  capabilities: string[];
  certifications: string[];
};

function inferClassification(text: string): ResearchSupplierProfile["classification"] {
  const lower = text.toLowerCase();
  if (/\b(?:manufacturer|manufacturing|factory|producer|production plant|mill)\b/.test(lower)) return "MANUFACTURER";
  if (/\b(?:stockist|stockholding|warehouse|in stock)\b/.test(lower)) return "STOCKIST";
  if (/\b(?:distributor|authori[sz]ed dealer|dealer|wholesaler|trading company|trader)\b/.test(lower)) return "DISTRIBUTOR";
  return "UNKNOWN";
}

export function supplierProfileFromEvidence(input: {
  name: string;
  domain: string | null;
  website: string | null;
  text: string;
  claims: ResearchEvidenceClaim[];
  ai?: ResearchAiSupplier | null;
}): ResearchSupplierProfile {
  const emails = input.claims.filter((entry) => entry.field === "email");
  const phones = input.claims.filter((entry) => entry.field === "phone");
  const certifications = unique([
    ...(input.ai?.certifications ?? []),
    ...input.claims.filter((entry) => entry.field === "certification").map((entry) => entry.value ?? ""),
  ]);
  const productCategories = unique([
    ...(input.ai?.productCategories ?? []),
    ...input.claims
      .filter((entry) => ["productName", "productCategory"].includes(entry.field))
      .map((entry) => entry.value ?? ""),
  ]);
  const countries = unique([
    ...(input.ai?.countries ?? []),
    ...(input.text.match(/\b(?:UAE|United Arab Emirates|Saudi Arabia|Qatar|Oman|Kuwait|Bahrain|India|China|Germany|USA|United Kingdom)\b/gi) ?? []),
  ]);
  return {
    canonicalName: (input.ai?.name ?? input.name).trim().slice(0, 220) || input.domain || "Unknown supplier",
    domain: input.domain,
    website: input.website,
    description: input.ai?.description?.slice(0, 1200) ?? null,
    classification: input.ai?.classification ?? inferClassification(input.text),
    countries,
    locations: unique(input.ai?.locations ?? []),
    contacts: [
      ...emails.map((entry) => ({
        type: "EMAIL" as const,
        value: entry.value ?? "",
        sourceUrl: entry.sourceUrl,
        verificationStatus: entry.verificationStatus,
      })),
      ...phones.map((entry) => ({
        type: "PHONE" as const,
        value: entry.value ?? "",
        sourceUrl: entry.sourceUrl,
        verificationStatus: entry.verificationStatus,
      })),
    ].slice(0, 20),
    productCategories,
    capabilities: unique(input.ai?.capabilities ?? []),
    certifications,
    aliases: [],
    branches: unique(input.ai?.locations ?? []),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 40);
}
