import { createHash } from "node:crypto";
import { fetchPublicResource } from "../pages";
import { normalizeDomain } from "../contacts";
import { normalizedSourceUrl } from "../classification";
import { extractDocument } from "../../intake/documents";
import type { EvidenceSourceType, ResearchEvidenceClaim, ResearchSupplierProfile } from "../../validation/research";
import {
  containsPromptInjection,
  extractAiEvidence,
  extractDeterministicEvidence,
  pageIsRelevant,
  pageTypeFor,
  supplierProfileFromEvidence,
} from "./evidence";
import type { ResearchLimits } from "../../validation/research";

export type InvestigatedPage = {
  url: string;
  finalUrl: string | null;
  domain: string | null;
  title: string | null;
  pageType: string;
  status: "FETCHED" | "FAILED" | "SKIPPED" | "ROBOTS_DISALLOWED" | "REJECTED";
  httpStatus: number | null;
  contentType: string | null;
  contentHash: string | null;
  excerpt: string | null;
  text: string | null;
  links: string[];
  documentLocation: string | null;
  pageCount: number | null;
  fetchedAt: Date;
  promptInjectionSuspected: boolean;
  evidence: ResearchEvidenceClaim[];
  supplier: ResearchSupplierProfile | null;
  aiUsage?: { inputTokens: number; outputTokens: number; model: string };
  note?: string;
};

function htmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : null;
}

function titleFromText(text: string, url: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 3 && line.length <= 200 && !/^(home|menu|skip to|search)$/i.test(line));
  if (first) return first;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Supplier page";
  }
}

export function sameSite(a: string, b: string): boolean {
  const da = normalizeDomain(a);
  const db = normalizeDomain(b);
  return Boolean(da && db && da === db);
}

const RELEVANT_LINK = /(?:product|products|solutions|catalog(?:ue)?|datasheet|technical|specification|about|company|contact|enquir|rfq|certificat|quality|location|branch|office|download|pdf)/i;
const REJECTED_LINK = /(?:login|signin|sign-in|register|cart|checkout|privacy|terms|policy|unsubscribe|wp-admin|javascript:|mailto:|tel:)/i;

/** Discovers a small set of genuinely useful internal links, not a crawl. */
export function discoverResearchLinks(pageUrl: string, links: string[], max = 4): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const raw of links) {
    if (picked.length >= max) break;
    if (!raw || REJECTED_LINK.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    if (!sameSite(url.toString(), pageUrl)) continue;
    const normalized = normalizedSourceUrl(url.toString());
    if (!normalized || seen.has(normalized)) continue;
    if (!RELEVANT_LINK.test(`${url.pathname} ${url.search}`)) continue;
    seen.add(normalized);
    picked.push(url.toString());
  }
  return picked;
}

function sourceTypeFor(contentType: string, url: string): EvidenceSourceType {
  if (contentType.includes("pdf") || /\.pdf(?:\?|$)/i.test(url)) return "PDF";
  if (contentType.includes("spreadsheet") || contentType.includes("excel") || contentType.includes("csv")) return "SPREADSHEET";
  if (contentType.startsWith("image/")) return "OCR";
  return "PAGE";
}

function claimsForDocument(
  text: string,
  pageUrl: string,
  title: string,
  sourceType: EvidenceSourceType,
  retrievedAt: Date,
): ResearchEvidenceClaim[] {
  if (sourceType === "PAGE") {
    return extractDeterministicEvidence({
      text,
      sourceUrl: pageUrl,
      pageTitle: title,
      sourceType,
      retrievedAt: retrievedAt.toISOString(),
    });
  }

  // PDF text from the existing extractor uses "[page N]" markers. Spreadsheet
  // text uses "[Sheet row N]" markers. Preserve both as document provenance.
  // A spreadsheet can have many rows in one block, so split per row as well as
  // per blank-line section.
  const sections =
    sourceType === "SPREADSHEET"
      ? text.split(/\r?\n/).filter((line) => /\[([^\]]+?)\s+row\s+\d+\]/i.test(line))
      : sourceType === "PDF"
        ? text.split(/(?=\[page\s+\d+\])/i)
        : text.split(/\n{2,}/);
  const claims: ResearchEvidenceClaim[] = [];
  for (const section of sections) {
    const pageMatch = section.match(/\[page\s+(\d+)\]/i);
    const sheetMatch = section.match(/\[([^\]]+?)\s+row\s+(\d+)\]/i);
    const pageNumber = pageMatch ? Number(pageMatch[1]) : null;
    const sheetName = sheetMatch ? sheetMatch[1] : null;
    const rowNumber = sheetMatch ? Number(sheetMatch[2]) : null;
    const documentLocation = pageNumber
      ? `page ${pageNumber}`
      : sheetName && rowNumber
        ? `${sheetName} row ${rowNumber}`
        : null;
    const sectionText = section.replace(/^\s*\[[^\]]+\]\s*/g, "").trim();
    if (sectionText.length < 4) continue;
    claims.push(
      ...extractDeterministicEvidence({
        text: sectionText,
        sourceUrl: pageUrl,
        pageTitle: title,
        sourceType,
        retrievedAt: retrievedAt.toISOString(),
        pageNumber,
        sheetName,
        rowNumber,
        documentLocation,
      }),
    );
  }
  return claims.length > 0
    ? claims
    : extractDeterministicEvidence({
        text,
        sourceUrl: pageUrl,
        pageTitle: title,
        sourceType,
        retrievedAt: retrievedAt.toISOString(),
      });
}

/**
 * Investigates one URL through the safe public fetch layer. Search snippets are
 * never fetched this way and never become strong evidence.
 */
export async function investigateResearchUrl(input: {
  url: string;
  familyTerms: string[];
  limits: Pick<ResearchLimits, "maxPageBytes" | "requestTimeoutMs">;
  aiAllowed?: boolean;
  fetchAllowed?: boolean;
  enquiryId?: string | null;
}): Promise<InvestigatedPage> {
  const fetchedAt = new Date();
  const domain = normalizeDomain(input.url);
  if (input.fetchAllowed === false) {
    return {
      url: input.url,
      finalUrl: null,
      domain,
      title: null,
      pageType: "OTHER",
      status: "SKIPPED",
      httpStatus: null,
      contentType: null,
      contentHash: null,
      excerpt: null,
      text: null,
      links: [],
      documentLocation: null,
      pageCount: null,
      fetchedAt,
      promptInjectionSuspected: false,
      evidence: [],
      supplier: null,
      note: "Page fetching is disabled for this research run.",
    };
  }

  const resource = await fetchPublicResource(input.url, {
    maxBytes: input.limits.maxPageBytes,
    timeoutMs: input.limits.requestTimeoutMs,
  });
  if (!resource.ok) {
    return {
      url: input.url,
      finalUrl: null,
      domain,
      title: null,
      pageType: "OTHER",
      status: resource.status === "ROBOTS_DISALLOWED" ? "ROBOTS_DISALLOWED" : "FAILED",
      httpStatus: null,
      contentType: null,
      contentHash: null,
      excerpt: null,
      text: null,
      links: [],
      documentLocation: null,
      pageCount: null,
      fetchedAt,
      promptInjectionSuspected: false,
      evidence: [],
      supplier: null,
      note: resource.note,
    };
  }

  const contentType = resource.contentType;
  const sourceType = sourceTypeFor(contentType, resource.finalUrl);
  const contentHash = createHash("sha256").update(resource.body).digest("hex");
  let text = resource.text;
  let pageCount: number | null = null;
  let note: string | undefined;
  const links: string[] = resource.links;

  if (sourceType !== "PAGE") {
    const document = await extractDocument(resource.body, resource.finalUrl.split("/").pop() ?? "document");
    text = document.text;
    pageCount = document.pageCount;
    note = document.note ?? undefined;
    if (!text.trim()) {
      return {
        url: input.url,
        finalUrl: resource.finalUrl,
        domain,
        title: resource.finalUrl.split("/").pop() ?? null,
        pageType: "CATALOGUE",
        status: "FAILED",
        httpStatus: 200,
        contentType,
        contentHash,
        excerpt: null,
        text: null,
        links: [],
        documentLocation: null,
        pageCount,
        fetchedAt,
        promptInjectionSuspected: false,
        evidence: [],
        supplier: null,
        note: note ?? "The document had no readable text; nothing was inferred.",
      };
    }
  }

  const title =
    sourceType === "PAGE"
      ? htmlTitle(resource.body.toString("utf8")) ?? titleFromText(text, resource.finalUrl)
      : resource.finalUrl.split("/").pop()?.replace(/[-_]+/g, " ") ?? "Supplier document";

  if (!pageIsRelevant(resource.finalUrl, title, text, input.familyTerms)) {
    return {
      url: input.url,
      finalUrl: resource.finalUrl,
      domain,
      title,
      pageType: pageTypeFor(resource.finalUrl, title, text),
      status: "REJECTED",
      httpStatus: 200,
      contentType,
      contentHash,
      excerpt: text.slice(0, 600),
      text: null,
      links: discoverResearchLinks(resource.finalUrl, links),
      documentLocation: null,
      pageCount,
      fetchedAt,
      promptInjectionSuspected: containsPromptInjection(text),
      evidence: [],
      supplier: null,
      note: "The page did not contain product-family or technical evidence, so it was not used for qualification.",
    };
  }

  const injection = containsPromptInjection(text);
  const deterministic = claimsForDocument(text, resource.finalUrl, title, sourceType, fetchedAt);
  // Product-family evidence is a deterministic observation: the family term
  // appears in the fetched text. It supports POSSIBLE relevance, but it is not
  // a technical attribute and can never make a candidate EXACT on its own.
  const familyClaim = input.familyTerms.find((term) => text.toLowerCase().includes(term.toLowerCase()));
  if (familyClaim) {
    const index = text.toLowerCase().indexOf(familyClaim.toLowerCase());
    deterministic.push({
      field: "productFamily",
      claim: `Page mentions the product family ${familyClaim}`,
      value: familyClaim,
      sourceUrl: resource.finalUrl,
      pageTitle: title,
      sourceType,
      excerpt: text.slice(Math.max(0, index - 160), Math.min(text.length, index + familyClaim.length + 160)),
      documentLocation: sourceType === "PDF" ? "PDF document" : null,
      pageNumber: null,
      retrievedAt: fetchedAt.toISOString(),
      extractionMethod: "DETERMINISTIC",
      verificationStatus: "SUPPORTED",
    });
  }
  let supplier: ResearchSupplierProfile | null = null;
  const evidence = deterministic;
  let aiUsage: { inputTokens: number; outputTokens: number; model: string } | undefined;

  if (input.aiAllowed) {
    const ai = await extractAiEvidence({
      text,
      sourceUrl: resource.finalUrl,
      pageTitle: title,
      sourceType,
      retrievedAt: fetchedAt.toISOString(),
      enquiryId: input.enquiryId ?? null,
    }).catch(() => ({ claims: [], supplier: null, usage: undefined }));
    // AI claims are already excerpt-verified. Deduplicate by field/value so the
    // same deterministic claim is not counted twice.
    const keys = new Set(deterministic.map((claim) => `${claim.field}|${(claim.value ?? "").toLowerCase()}`));
    for (const claim of ai.claims) {
      const key = `${claim.field}|${(claim.value ?? "").toLowerCase()}`;
      if (keys.has(key)) continue;
      keys.add(key);
      evidence.push(claim);
    }
    aiUsage = ai.usage;
    if (ai.supplier) {
      supplier = supplierProfileFromEvidence({
        name: ai.supplier.name ?? title,
        domain,
        website: resource.finalUrl,
        text,
        claims: evidence,
        ai: ai.supplier,
      });
    }
  }

  if (!supplier) {
    supplier = supplierProfileFromEvidence({
      name: title,
      domain,
      website: resource.finalUrl,
      text,
      claims: evidence,
    });
  }

  return {
    url: input.url,
    finalUrl: resource.finalUrl,
    domain,
    title,
    pageType: pageTypeFor(resource.finalUrl, title, text),
    status: "FETCHED",
    httpStatus: 200,
    contentType,
    contentHash,
    excerpt: text.slice(0, 1_200),
    text: text.slice(0, 80_000),
    links: discoverResearchLinks(resource.finalUrl, links),
    documentLocation: sourceType === "PDF" ? "PDF document" : sourceType === "SPREADSHEET" ? "Spreadsheet" : null,
    pageCount,
    fetchedAt,
    promptInjectionSuspected: injection,
    evidence,
    supplier,
    aiUsage,
    note,
  };
}

/** Snippet evidence is retained for provenance but never used as a fact. */
export function snippetEvidence(input: {
  title: string;
  snippet: string | null;
  url: string;
  provider: string;
  retrievedAt: Date;
}): ResearchEvidenceClaim[] {
  if (!input.snippet?.trim()) return [];
  return extractDeterministicEvidence({
    text: `${input.title}\n${input.snippet}`,
    sourceUrl: input.url,
    pageTitle: input.title,
    sourceType: "SEARCH_SNIPPET",
    retrievedAt: input.retrievedAt.toISOString(),
  }).map((claim) => ({
    ...claim,
    extractionMethod: "DETERMINISTIC" as const,
    verificationStatus: "SNIPPET_ONLY" as const,
    excerpt: input.snippet?.slice(0, 600) ?? null,
  }));
}
