import { db } from "../db";
import { parseJson, stringifyJson } from "../json";
import { matchProduct } from "../inventory/matching";
import { parseFastenerSpec, parseFastenerSpecJson } from "../fasteners/spec";
import {
  industrialSpecFromFields,
  parseIndustrialSpecJson,
} from "../catalog/industrialSpec";
import { recomputeOffersForItem } from "../costing/evaluate";
import { buildSearchQueries } from "./queries";
import { isServiceCategory, isServiceDescription } from "../catalog/industrialSpec";
import { getSearchAdapters } from "./registry";
import { fetchPublicPage } from "./pages";
import {
  extractLeadTimeDays,
  extractMoq,
  extractPriceFromText,
  extractSpecsFromText,
} from "./extract";
import type { AdapterContext, CoverageEntry, SourcingCandidate } from "./types";
import { getOrgLimits } from "../limits";
import { readSearchCache, searchCacheKey, writeSearchCache } from "./cache";
import { extractPublicContacts } from "./contacts";
import { upsertProspectsAndDraftRfqs } from "../suppliers/prospects";
import { compareSourcedSuppliers } from "./aiCompare";
import { writeAudit } from "../audit";

const PAGE_FETCH_LIMIT = 5;

function candidateSpecs(candidate: SourcingCandidate, category: string | null | undefined) {
  const stored = parseJson<Record<string, unknown>>(
    typeof candidate.evidence?.specs === "string" ? (candidate.evidence.specs as string) : "{}",
    {},
  );
  const extracted = (candidate.evidence?.specifications ?? {}) as Record<string, unknown>;
  const pick = (key: string) =>
    (extracted[key] as string | undefined) ?? (stored[key] as string | undefined) ?? null;
  const description = `${candidate.title} ${candidate.snippet ?? ""}`.slice(0, 400);
  return {
    description,
    material: pick("material"),
    size: pick("size"),
    grade: pick("grade"),
    pressureRating: pick("pressureRating"),
    schedule: pick("schedule"),
    standard: pick("standard"),
    brand: pick("brand"),
    industrialSpec: industrialSpecFromFields(category, {
      description,
      size: pick("size"),
      material: pick("material"),
      grade: pick("grade"),
      pressureRating: pick("pressureRating"),
      schedule: pick("schedule"),
      standard: pick("standard"),
      brand: pick("brand"),
    }),
    fastenerSpec: parseFastenerSpec({
      description,
      size: pick("size"),
      material: pick("material"),
      grade: pick("grade"),
      standard: pick("standard"),
    }),
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
    const publicContacts = extractPublicContacts(page.text, page.finalUrl, page.links);
    candidate.evidence = {
      ...(candidate.evidence ?? {}),
      specifications: specs,
      pageFetch: "OK",
      pageExcerpt: page.text.slice(0, 600),
      publicContacts,
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
  if (isServiceCategory(item.category) || isServiceDescription(item.description)) {
    await db.enquiryItem.update({
      where: { id: item.id },
      data: { sourcingStatus: "NOT_REQUIRED", clarificationQuestion: "Service line — quote manually. Services are not sourced as products." },
    });
    return {
      sessionId: null,
      status: "SKIPPED",
      coverage: [],
      results: 0,
      offers: 0,
      suppliers: 0,
      message: "This is a service line. Price it manually; supplier product search is not used.",
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

  const limits = await getOrgLimits();
  // The query cap is a per-organization commercial control, not an arbitrary
  // hidden constant. Cached results still satisfy repeated searches.
  const queries = buildSearchQueries(item).slice(0, limits.maxSearchQueriesPerItem);
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
    if (adapter.key === "PUBLIC_WEB" && !limits.webSearchEnabled) {
      coverage.push({ adapter: adapter.key, label: adapter.label, status: "NOT_CONFIGURED", queries: queries.length, results: 0, note: "Web search is disabled in this organization's limits." });
      continue;
    }
    const cacheKey = searchCacheKey(adapter.key, queries, context.request as unknown as Record<string, unknown>);
    const cached = await readSearchCache(cacheKey);
    if (cached) {
      candidates.push(...cached);
      coverage.push({ adapter: adapter.key, label: adapter.label, status: "OK", queries: queries.length, results: cached.length, note: "Served from the organization search cache." });
      continue;
    }
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
      if (result.status === "OK") {
        await writeSearchCache(cacheKey, result.candidates, limits.searchCacheTtlDays);
      }
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

  // AI comparison of the fetched websites. It only judges evidence already
  // present and never invents prices, stock or lead times. When AI is not
  // configured or the budget is exhausted, sourcing keeps its deterministic
  // behaviour and no comparison is recorded.
  const aiComparison = await compareSourcedSuppliers({
    request: context.request,
    candidates,
    enquiryId: item.enquiryId,
  }).catch(() => null);
  if (aiComparison) {
    for (const candidate of candidates) {
      const entry = aiComparison.assessment.get(candidate.supplierName.trim().toLowerCase());
      if (entry) {
        candidate.evidence = { ...(candidate.evidence ?? {}), aiComparison: entry, aiSummary: aiComparison.summary };
      }
    }
    await writeAudit({
      actorLabel: "sourcing-ai",
      action: "sourcing.ai_comparison",
      entityType: "SearchSession",
      entityId: session.id,
      meta: {
        candidates: candidates.length,
        recommended: [...aiComparison.assessment.values()].filter((value) => value.recommended).length,
        summary: aiComparison.summary,
      },
    }).catch(() => undefined);
  }

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

  const equivalences = await db.materialEquivalence.findMany({
    where: { isActive: true },
    select: { requestedMaterial: true, offeredMaterial: true, requestedGrade: true, offeredGrade: true, reason: true },
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
    fastenerSpec: parseFastenerSpecJson(item.fastenerSpecJson),
    industrialSpec: parseIndustrialSpecJson(item.industrialSpecJson),
  };

  let offerCount = 0;
  let exactCount = 0;
  const supplierNames = new Set<string>();

  for (const candidate of uniqueCandidates) {
    const specs = candidateSpecs(candidate, item.category);
    const match = matchProduct(requestSpec, specs, { strictStandard: Boolean(item.standard), equivalences });
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
        offeredSpecJson: stringifyJson(specs.fastenerSpec),
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

  try {
    await upsertProspectsAndDraftRfqs(item, uniqueCandidates);
  } catch (error) {
    // Prospect discovery is additive; an error here must not hide the offers
    // and coverage that were already produced by this sourcing run.
    console.warn("Prospect discovery failed:", error instanceof Error ? error.message : error);
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
