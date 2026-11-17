import { db } from "../db";
import { parseJson, stringifyJson } from "../json";
import { matchProduct } from "../inventory/matching";
import { recomputeOffersForItem } from "../costing/evaluate";
import { buildSearchQueries } from "./queries";
import { getSearchAdapters } from "./registry";
import { fetchPublicPage } from "./pages";
import {
  extractLeadTimeDays,
  extractMoq,
  extractPriceFromText,
  extractSpecsFromText,
} from "./extract";
import type { AdapterContext, CoverageEntry, SourcingCandidate } from "./types";

const PAGE_FETCH_LIMIT = 5;

function candidateSpecs(candidate: SourcingCandidate) {
  const stored = parseJson<Record<string, unknown>>(
    typeof candidate.evidence?.specs === "string" ? (candidate.evidence.specs as string) : "{}",
    {},
  );
  const extracted = (candidate.evidence?.specifications ?? {}) as Record<string, unknown>;
  const pick = (key: string) =>
    (extracted[key] as string | undefined) ?? (stored[key] as string | undefined) ?? null;
  return {
    description: `${candidate.title} ${candidate.snippet ?? ""}`.slice(0, 400),
    material: pick("material"),
    size: pick("size"),
    grade: pick("grade"),
    pressureRating: pick("pressureRating"),
    schedule: pick("schedule"),
    standard: pick("standard"),
    brand: pick("brand"),
  };
}

async function enrichWithPageEvidence(candidates: SourcingCandidate[]): Promise<SourcingCandidate[]> {
  const targets = candidates.filter((c) => c.sourceUrl && c.adapter === "PUBLIC_WEB").slice(0, PAGE_FETCH_LIMIT);
  for (const candidate of targets) {
    if (!candidate.sourceUrl) continue;
    const page = await fetchPublicPage(candidate.sourceUrl);
    if (!page.ok) {
      candidate.evidence = { ...(candidate.evidence ?? {}), pageFetch: page.status, pageNote: page.note };
      continue;
    }
    const price = extractPriceFromText(page.text);
    const specs = extractSpecsFromText(`${candidate.title}\n${page.text.slice(0, 8000)}`);
    candidate.evidence = {
      ...(candidate.evidence ?? {}),
      specifications: specs,
      pageFetch: "OK",
      pageExcerpt: page.text.slice(0, 600),
    };
    if (candidate.unitPrice == null && price.unitPrice != null) {
      candidate.unitPrice = price.unitPrice;
      candidate.currency = price.currency ?? candidate.currency;
      candidate.priceText = price.priceText;
    }
    if (candidate.moq == null) candidate.moq = extractMoq(page.text);
    if (candidate.availability == null) candidate.availability = specs.availability ?? null;
    if (candidate.leadTimeDays == null) candidate.leadTimeDays = extractLeadTimeDays(page.text);
  }
  return candidates;
}

export type SourcingRunResult = {
  sessionId: string | null;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";
  coverage: CoverageEntry[];
  results: number;
  offers: number;
  suppliers: number;
  message: string;
};

/**
 * Multi-source discovery for a single shortage item. Every discovered result
 * keeps its source evidence; anything that cannot be verified is labelled as
 * such rather than promoted to a confirmed offer.
 */
export async function runSourcingForItem(enquiryItemId: string): Promise<SourcingRunResult> {
  const item = await db.enquiryItem.findUnique({ where: { id: enquiryItemId }, include: { enquiry: true } });
  if (!item) throw new Error("Enquiry item not found");

  const missing = parseJson<string[]>(item.missingFields, []);
  if (missing.length > 0) {
    await db.enquiryItem.update({ where: { id: item.id }, data: { sourcingStatus: "NOT_STARTED" } });
    return {
      sessionId: null,
      status: "SKIPPED",
      coverage: [],
      results: 0,
      offers: 0,
      suppliers: 0,
      message: "More product details are needed before suppliers can be searched.",
    };
  }
  if (item.quantityToSource <= 0) {
    await db.enquiryItem.update({ where: { id: item.id }, data: { sourcingStatus: "NOT_REQUIRED" } });
    return {
      sessionId: null,
      status: "SKIPPED",
      coverage: [],
      results: 0,
      offers: 0,
      suppliers: 0,
      message: "Nothing needs to be sourced for this item.",
    };
  }

  const session = await db.searchSession.create({
    data: { enquiryItemId: item.id, status: "RUNNING" },
  });
  await db.enquiryItem.update({ where: { id: item.id }, data: { sourcingStatus: "SEARCHING" } });

  const queries = buildSearchQueries(item);
  const context: AdapterContext = {
    request: {
      description: item.description,
      quantity: item.quantityToSource,
      unit: item.unit,
      category: item.category,
      material: item.material,
      size: item.size,
      grade: item.grade,
      pressureRating: item.pressureRating,
      schedule: item.schedule,
      standard: item.standard,
      brand: item.brand,
    },
    fetchPages: true,
  };

  const coverage: CoverageEntry[] = [];
  let candidates: SourcingCandidate[] = [];

  for (const adapter of getSearchAdapters()) {
    if (!adapter.available()) {
      await db.searchQuery.createMany({
        data: queries.map((query) => ({
          sessionId: session.id,
          adapter: adapter.key,
          query,
          status: "NOT_CONFIGURED",
          error: adapter.unavailableReason?.() ?? "Not configured",
        })),
      });
      coverage.push({
        adapter: adapter.key,
        label: adapter.label,
        status: "NOT_CONFIGURED",
        queries: queries.length,
        results: 0,
        note: adapter.unavailableReason?.(),
      });
      continue;
    }
    try {
      const result = await adapter.search(queries, context);
      if (result.queries.length > 0) {
        await db.searchQuery.createMany({
          data: result.queries.map((query) => ({
            sessionId: session.id,
            adapter: adapter.key,
            query: query.query,
            status: query.status,
            resultCount: query.resultCount,
            error: query.error ?? null,
          })),
        });
      }
      coverage.push({
        adapter: adapter.key,
        label: adapter.label,
        status: result.status,
        queries: result.queries.length,
        results: result.candidates.length,
        note: result.note,
      });
      candidates.push(...result.candidates);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Adapter failed";
      coverage.push({
        adapter: adapter.key,
        label: adapter.label,
        status: "FAILED",
        queries: queries.length,
        results: 0,
        note: message,
      });
    }
  }

  candidates = await enrichWithPageEvidence(candidates);

  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = [
      candidate.supplierName.toLowerCase(),
      candidate.title.toLowerCase().slice(0, 120),
      candidate.unitPrice ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const requestSpec = {
    description: item.description,
    category: item.category,
    brand: item.brand,
    size: item.size,
    material: item.material,
    grade: item.grade,
    pressureRating: item.pressureRating,
    schedule: item.schedule,
    standard: item.standard,
  };

  let offerCount = 0;
  let exactCount = 0;
  const supplierNames = new Set<string>();

  for (const candidate of uniqueCandidates) {
    const specs = candidateSpecs(candidate);
    const match = matchProduct(requestSpec, specs, { strictStandard: Boolean(item.standard) });
    supplierNames.add(candidate.supplierName);

    const result = await db.searchResult.create({
      data: {
        sessionId: session.id,
        adapter: candidate.adapter,
        sourceUrl: candidate.sourceUrl ?? null,
        supplierId: candidate.supplierId ?? null,
        supplierName: candidate.supplierName,
        title: candidate.title.slice(0, 300),
        snippet: candidate.snippet?.slice(0, 1200) ?? null,
        priceText: candidate.priceText ?? null,
        currency: candidate.currency ?? null,
        moq: candidate.moq ?? null,
        availability: candidate.availability ?? null,
        evidenceJson: stringifyJson({
          ...(candidate.evidence ?? {}),
          match: { status: match.status, reasons: match.reasons, mismatches: match.mismatches, missing: match.missing },
          quantityNeeded: item.quantityToSource,
        }),
        matchStatus: match.status,
        confidence: Math.round(match.score * 100) / 100,
        retrievedAt: candidate.retrievedAt,
        isDemo: candidate.isDemo ?? false,
      },
    });

    if (match.status === "NO_MATCH") continue;

    if (match.status === "EXACT" || match.status === "EQUIVALENT") exactCount += 1;
    const status =
      match.status === "EXACT" || match.status === "EQUIVALENT"
        ? "VERIFIED"
        : match.status === "POSSIBLE"
          ? "POSSIBLE_MATCH"
          : "LISTING_FOUND";

    await db.supplierOffer.create({
      data: {
        enquiryItemId: item.id,
        supplierId: candidate.supplierId ?? null,
        supplierName: candidate.supplierName,
        searchResultId: result.id,
        productTitle: candidate.title.slice(0, 300),
        matchStatus: match.status,
        unitPrice: candidate.unitPrice ?? null,
        currency: candidate.currency ?? null,
        quantityAvailable: null,
        moq: candidate.moq ?? null,
        shippingCost: null,
        otherCharges: null,
        taxes: null,
        leadTimeDays: candidate.leadTimeDays ?? null,
        deliveryLocation: null,
        validityDate: null,
        status,
        sourceType:
          candidate.adapter === "INTERNAL_SUPPLIERS"
            ? "INTERNAL_DB"
            : candidate.adapter === "B2B_MARKETPLACE"
              ? "MARKETPLACE"
              : "PUBLIC_WEB",
        sourceUrl: candidate.sourceUrl ?? null,
        quotedAt: candidate.retrievedAt,
        verificationStatus: candidate.unitPrice != null ? "PARTIAL" : "UNVERIFIED",
        evidenceJson: stringifyJson({
          specifications: candidate.evidence?.specifications ?? null,
          match: { status: match.status, reasons: match.reasons, missing: match.missing },
          priceSource: candidate.unitPrice != null ? "Public listing" : "No public price",
        }),
        isDemo: candidate.isDemo ?? false,
      },
    });
    offerCount += 1;
  }

  const evaluation = await recomputeOffersForItem(item.id);

  const okAdapters = coverage.filter((c) => c.status === "OK").length;
  const failedAdapters = coverage.filter((c) => c.status === "FAILED").length;
  const sessionStatus =
    okAdapters === 0 && failedAdapters > 0
      ? "FAILED"
      : failedAdapters > 0 || coverage.some((c) => c.status === "NOT_CONFIGURED")
        ? "PARTIAL"
        : "COMPLETED";

  const summary = {
    results: uniqueCandidates.length,
    offers: offerCount,
    exactMatches: exactCount,
    suppliers: supplierNames.size,
    rankableOffers: evaluation.ranked.filter((entry) => entry.evaluation.rankable).length,
    quantityNeeded: item.quantityToSource,
    currency: evaluation.targetCurrency,
  };

  await db.searchSession.update({
    where: { id: session.id },
    data: {
      status: sessionStatus,
      completedAt: new Date(),
      sourcesJson: stringifyJson(coverage),
      summaryJson: stringifyJson(summary),
    },
  });

  await db.enquiryItem.update({
    where: { id: item.id },
    data: {
      sourcingStatus: offerCount > 0 ? "RESULTS_READY" : "NO_RESULTS",
    },
  });

  return {
    sessionId: session.id,
    status: sessionStatus,
    coverage,
    results: uniqueCandidates.length,
    offers: offerCount,
    suppliers: supplierNames.size,
    message:
      offerCount === 0
        ? "No verifiable supplier offer was found for this item."
        : `${supplierNames.size} supplier${supplierNames.size === 1 ? "" : "s"} found across ${
            coverage.filter((c) => c.status === "OK").length
          } connected source${coverage.filter((c) => c.status === "OK").length === 1 ? "" : "s"}.`,
  };
}
