import { createHash } from "node:crypto";
import { db } from "../../db";
import { env } from "../../env";
import { getCurrentOrganization } from "../../organization";
import { getOrgLimits } from "../../limits";
import { parseJson, stringifyJson } from "../../json";
import { requireTenantId } from "../../tenant";
import { writeAudit } from "../../audit";
import { estimateAiCostUsd } from "../../ai/usage";
import { isServiceCategory, isServiceDescription } from "../../catalog/industrialSpec";
import { getSearchAdapters } from "../registry";
import type { AdapterContext, CoverageEntry, SourcingCandidate } from "../types";
import { normalizeDomain } from "../contacts";
import { normalizedSourceUrl } from "../classification";
import {
  RESEARCH_ACTIVE_STATUSES,
  ResearchPlanSchema,
  type ResearchEvidenceClaim,
  type ResearchPlan,
  type ResearchQuery,
  type ResearchRunOptions,
  type ResearchStatus,
} from "../../validation/research";
import { getResearchLimits } from "./limits";
import {
  augmentPlanWithAi,
  buildResearchPlan,
  planFollowUpQueries,
  type FollowUpGap,
  type PlannerItem,
} from "./planner";
import { executeResearchQueries, type ResearchSearchOutcome } from "./search";
import {
  discoverResearchLinks,
  investigateResearchUrl,
  snippetEvidence,
  type InvestigatedPage,
} from "./investigation";
import {
  qualifySupplierCandidate,
  type ResearchEvidenceRecord,
} from "./qualification";

const DIRECTORY_DOMAINS = [
  "alibaba.com",
  "indiamart.com",
  "made-in-china.com",
  "tradeindia.com",
  "thomasnet.com",
  "europages",
  "globalsources.com",
  "exportersindia.com",
  "ec21.com",
  "tradekey.com",
  "go4worldbusiness.com",
  "yellowpages",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "wikipedia.org",
  "amazon.",
  "ebay.",
];
const SOCIAL_OR_DIRECTORY = /(?:^|\.)(?:alibaba|indiamart|made-in-china|tradeindia|thomasnet|globalsources|exportersindia|ec21|tradekey|go4worldbusiness|linkedin|facebook|instagram|youtube|wikipedia)\./i;

export type DeepResearchResult = {
  runId: string | null;
  status: "SKIPPED" | ResearchStatus;
  candidates: number;
  exact: number;
  compatible: number;
  possible: number;
  unverified: number;
  noMatch: number;
  suppliersWithEvidence: number;
  queries: number;
  pages: number;
  evidence: number;
  searchRequests: number;
  pageFetches: number;
  documentsProcessed: number;
  aiCalls: number;
  estimatedCostUsd: number;
  coverage: CoverageEntry[];
  message: string;
  alreadyRunning?: boolean;
};

type RunState = {
  searchRequests: number;
  pageFetches: number;
  documentsProcessed: number;
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  providerFailures: string[];
  budgetStopped: boolean;
  coverage: CoverageEntry[];
};

function resultFor(status: DeepResearchResult["status"], message: string, runId: string | null = null): DeepResearchResult {
  return {
    runId,
    status,
    candidates: 0,
    exact: 0,
    compatible: 0,
    possible: 0,
    unverified: 0,
    noMatch: 0,
    suppliersWithEvidence: 0,
    queries: 0,
    pages: 0,
    evidence: 0,
    searchRequests: 0,
    pageFetches: 0,
    documentsProcessed: 0,
    aiCalls: 0,
    estimatedCostUsd: 0,
    coverage: [],
    message,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isDirectory(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return DIRECTORY_DOMAINS.some((entry) => host === entry || host.endsWith(`.${entry}`)) || SOCIAL_OR_DIRECTORY.test(host);
  } catch {
    return false;
  }
}

function candidateKey(candidate: SourcingCandidate): string {
  const domain = normalizeDomain(candidate.sourceUrl);
  if (domain) return `domain:${domain}`;
  if (candidate.supplierId) return `supplier:${candidate.supplierId}`;
  return `name:${slug(candidate.supplierName)}`;
}

function candidateDomain(candidate: SourcingCandidate): string | null {
  return normalizeDomain(candidate.sourceUrl);
}

function isActive(status: string): boolean {
  return RESEARCH_ACTIVE_STATUSES.includes(status as ResearchStatus);
}

function mergeCoverage(previous: CoverageEntry, next: CoverageEntry): CoverageEntry {
  const status =
    next.status === "OK" && previous.status === "OK"
      ? "OK"
      : next.status === "NOT_CONFIGURED" && previous.status === "NOT_CONFIGURED"
        ? "NOT_CONFIGURED"
        : next.status === "SKIPPED" && previous.status === "SKIPPED"
          ? "SKIPPED"
          : next.status === "OK" && previous.status === "NOT_CONFIGURED"
            ? "OK"
            : "PARTIAL";
  return {
    ...next,
    status,
    queries: previous.queries + next.queries,
    results: previous.results + next.results,
    note: next.note ?? previous.note,
  };
}

async function emitEvent(
  runId: string,
  stage: string,
  message: string,
  iteration: number,
  meta: Record<string, unknown> = {},
  level: "INFO" | "WARN" | "ERROR" = "INFO",
): Promise<void> {
  await db.researchEvent
    .create({
      data: {
        runId,
        stage,
        level,
        message: message.slice(0, 900),
        iteration,
        metaJson: stringifyJson(meta),
      },
    })
    .catch(() => undefined);
}

async function isCancelled(runId: string): Promise<boolean> {
  const row = await db.researchRun.findUnique({ where: { id: runId }, select: { status: true } });
  return row?.status === "CANCELLED";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function itemAsPlanner(item: {
  id: string;
  enquiryId: string;
  description: string;
  category: string | null;
  brand: string | null;
  size: string | null;
  material: string | null;
  grade: string | null;
  pressureRating: string | null;
  schedule: string | null;
  standard: string | null;
  quantity: number;
  quantityToSource: number;
  unit: string;
  missingFields: string;
  industrialSpecJson: string | null;
  fastenerSpecJson: string | null;
  enquiry?: {
    deliveryLocation: string | null;
    requestedDeliveryTimeframe: string | null;
    urgency: string | null;
  } | null;
}): PlannerItem {
  return {
    ...item,
    enquiry: item.enquiry
      ? {
          deliveryLocation: item.enquiry.deliveryLocation,
          requestedDeliveryTimeframe: item.enquiry.requestedDeliveryTimeframe,
          urgency: item.enquiry.urgency,
        }
      : null,
  };
}

function evidenceFromInternal(candidate: SourcingCandidate, familyTerms: string[]): ResearchEvidenceClaim[] {
  const specs = parseJson<Record<string, unknown>>(
    typeof candidate.evidence?.specs === "string" ? candidate.evidence.specs : "{}",
    {},
  );
  const extracted = (candidate.evidence?.specifications ?? {}) as Record<string, unknown>;
  const value = (key: string): string | null => {
    const raw = extracted[key] ?? specs[key];
    return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  };
  const sourceUrl = candidate.sourceUrl ?? `internal://supplier/${candidate.supplierId ?? slug(candidate.supplierName)}`;
  const retrievedAt = candidate.retrievedAt.toISOString();
  const claims: ResearchEvidenceClaim[] = [];
  const add = (field: string, raw: string | null) => {
    if (!raw) return;
    claims.push({
      field,
      claim: `${field} is ${raw}`,
      value: raw,
      sourceUrl,
      pageTitle: candidate.title,
      sourceType: "INTERNAL",
      excerpt: `Recorded supplier directory value: ${raw}`,
      retrievedAt,
      extractionMethod: "DETERMINISTIC",
      verificationStatus: "SUPPORTED",
    });
  };
  const familyText = `${candidate.title} ${candidate.supplierName} ${String(candidate.evidence?.productCategory ?? "")}`.toLowerCase();
  const familyTerm = familyTerms.find((term) => familyText.includes(term.toLowerCase()));
  add("productFamily", familyTerm ?? null);
  add("material", value("material"));
  add("grade", value("grade"));
  add("size", value("size"));
  add("pressureRating", value("pressureRating"));
  add("schedule", value("schedule"));
  add("standard", value("standard"));
  add("brand", value("brand"));
  add("availability", value("availability") ?? candidate.availability ?? null);
  add("unitPrice", candidate.unitPrice != null ? String(candidate.unitPrice) : null);
  add("currency", candidate.currency ?? null);
  add("moq", candidate.moq != null ? String(candidate.moq) : null);
  add("leadTimeDays", candidate.leadTimeDays != null ? String(candidate.leadTimeDays) : null);
  const email = candidate.evidence?.contactEmail;
  const phone = candidate.evidence?.contactPhone;
  add("email", typeof email === "string" ? email : null);
  add("phone", typeof phone === "string" ? phone : null);
  return claims;
}

function targetScore(candidate: SourcingCandidate, familyTerms: string[]): number {
  const text = `${candidate.title} ${candidate.snippet ?? ""} ${candidate.sourceUrl ?? ""}`.toLowerCase();
  let score = 0;
  if (familyTerms.some((term) => text.includes(term.toLowerCase()))) score += 4;
  if (/product|catalog|datasheet|specification|technical|pdf/.test(text)) score += 3;
  if (/distributor|stockist|manufacturer|supplier/.test(text)) score += 1;
  if (candidate.sourceUrl) score += 1;
  return score;
}

async function saveClaims(input: {
  runId: string;
  candidateId: string;
  pageId: string | null;
  claims: ResearchEvidenceClaim[];
  seen: Set<string>;
}): Promise<ResearchEvidenceRecord[]> {
  const saved: ResearchEvidenceRecord[] = [];
  for (const claim of input.claims) {
    const key = `${input.candidateId}|${claim.field}|${(claim.value ?? "").toLowerCase()}|${claim.sourceUrl}|${claim.sourceType}`;
    if (input.seen.has(key)) {
      const existing = await db.researchEvidence.findFirst({
        where: {
          runId: input.runId,
          candidateId: input.candidateId,
          field: claim.field,
          sourceUrl: claim.sourceUrl,
          sourceType: claim.sourceType,
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) saved.push(existing as unknown as ResearchEvidenceRecord);
      continue;
    }
    input.seen.add(key);
    const row = await db.researchEvidence.create({
      data: {
        runId: input.runId,
        candidateId: input.candidateId,
        pageId: input.pageId,
        field: claim.field,
        claim: claim.claim,
        value: claim.value ?? null,
        sourceUrl: claim.sourceUrl,
        pageTitle: claim.pageTitle ?? null,
        sourceType: claim.sourceType,
        excerpt: claim.excerpt ?? null,
        documentLocation: claim.documentLocation ?? null,
        pageNumber: claim.pageNumber ?? null,
        sheetName: claim.sheetName ?? null,
        rowNumber: claim.rowNumber ?? null,
        retrievedAt: new Date(claim.retrievedAt),
        extractionMethod: claim.extractionMethod,
        verificationStatus: claim.verificationStatus,
      },
    });
    saved.push({ ...claim, id: row.id });
  }
  return saved;
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].map((value) => value.trim()).filter(Boolean))].slice(0, 40);
}

/**
 * Bounded iterative supplier research for one RFQ line.
 *
 * All state is persisted. A worker crash or a cancelled run leaves the queries,
 * sources, pages, evidence and candidates that were already obtained; resuming
 * skips those and continues from the remaining budget.
 */
export async function runDeepResearchForItem(
  enquiryItemId: string,
  options: ResearchRunOptions = { mode: "DEEP" },
): Promise<DeepResearchResult> {
  const organizationId = await requireTenantId();
  const item = await db.enquiryItem.findUnique({
    where: { id: enquiryItemId },
    include: { enquiry: true },
  });
  if (!item) throw new Error("Enquiry item not found");
  if (item.quantityToSource <= 0) {
    return resultFor("SKIPPED", "Nothing needs to be sourced for this item.");
  }
  if (isServiceCategory(item.category) || isServiceDescription(item.description)) {
    return resultFor("SKIPPED", "This is a service line. Price it manually; supplier product research is not used.");
  }
  if (item.enquiry.status === "IGNORED" || item.enquiry.status === "REJECTED") {
    return resultFor("SKIPPED", "The enquiry is not an active sourcing request.");
  }

  if (options.resumeRunId) {
    return resumeDeepResearchRun(options.resumeRunId, options);
  }

  const activeKey = `deep:${organizationId}:${item.id}`;
  const existing = await db.researchRun.findFirst({
    where: { activeKey, status: { in: [...RESEARCH_ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    const result = await summarizeRun(existing.id);
    return { ...result, alreadyRunning: true, message: "Research is already running for this product." };
  }

  const limits = await getResearchLimits({
    maxRounds: options.maxRounds,
    maxQueries: options.maxQueries,
    maxUrls: options.maxUrls,
    maxPagesPerDomain: options.maxPagesPerDomain,
    maxConcurrentPages: options.maxConcurrentPages,
    budgetAed: options.budgetAed,
  });
  const org = await getCurrentOrganization().catch(() => null);
  const orgLimits = await getOrgLimits();
  const context = {
    location: org?.country === "AE" ? "UAE" : (org?.country ?? null),
    deliveryLocation: item.enquiry.deliveryLocation,
    deliveryTimeframe: item.enquiry.requestedDeliveryTimeframe,
    certifications: parseJson<string[]>(item.enquiry.customerInstructionsJson, []).filter((entry) =>
      /certif|iso|astm|api|en\s*10204|mill\s*certificate/i.test(entry),
    ),
    maxQueries: limits.maxQueries,
  };
  const plan = buildResearchPlan(itemAsPlanner(item), context);

  let run;
  try {
    run = await db.researchRun.create({
      data: {
        organizationId,
        enquiryId: item.enquiryId,
        enquiryItemId: item.id,
        activeKey,
        mode: "DEEP",
        status: "QUEUED",
        stage: "QUEUED",
        planJson: stringifyJson(plan),
        limitsJson: stringifyJson({ ...limits, webSearchEnabled: orgLimits.webSearchEnabled }),
        coverageJson: "[]",
        budgetAed: limits.budgetAed,
        startedAt: new Date(),
      },
    });
  } catch (error) {
    // The unique activeKey is the race-safe duplicate guard.
    const raced = await db.researchRun.findFirst({ where: { activeKey } });
    if (raced) {
      const result = await summarizeRun(raced.id);
      return { ...result, alreadyRunning: true, message: "Research is already running for this product." };
    }
    throw error;
  }

  await emitEvent(run.id, "QUEUED", "Deep research queued.", 0, {
    product: plan.product.productName,
    limits,
  });
  await writeAudit({
    action: "sourcing.deep_research.started",
    entityType: "ResearchRun",
    entityId: run.id,
    actorLabel: "sourcing",
    meta: { enquiryItemId: item.id, maxQueries: limits.maxQueries, maxRounds: limits.maxRounds },
  }).catch(() => undefined);

  return processDeepResearchRun(run.id, { plan, webSearchEnabled: orgLimits.webSearchEnabled });
}

async function processDeepResearchRun(
  runId: string,
  initial: { plan?: ResearchPlan; webSearchEnabled?: boolean } = {},
): Promise<DeepResearchResult> {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    include: { enquiryItem: { include: { enquiry: true } }, enquiry: true },
  });
  if (!run) throw new Error("Research run not found");
  if (run.status === "CANCELLED") return summarizeRun(run.id);

  const item = run.enquiryItem;
  if (!item) {
    await finishRun(runId, "FAILED", "The RFQ line no longer exists.");
    return summarizeRun(runId);
  }
  const storedLimits = parseJson<Partial<Awaited<ReturnType<typeof getResearchLimits>>> & { webSearchEnabled?: boolean }>(
    run.limitsJson,
    {},
  );
  // A resumed historical run may have an incomplete limits snapshot. Rebuild it
  // through the same clamp/settings path so it cannot become unbounded.
  const limits = await getResearchLimits(storedLimits);
  const webSearchEnabled =
    initial.webSearchEnabled ?? storedLimits.webSearchEnabled ?? (await getOrgLimits()).webSearchEnabled;
  const state: RunState = {
    searchRequests: run.searchRequests,
    pageFetches: run.pageFetches,
    documentsProcessed: run.documentsProcessed,
    aiCalls: run.aiCalls,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    estimatedCostUsd: run.estimatedCostUsd,
    providerFailures: [],
    budgetStopped: false,
    coverage: parseJson<CoverageEntry[]>(run.coverageJson, []),
  };
  const storedPlan = initial.plan ? null : parseJson<unknown>(run.planJson, null);
  const parsedPlan = storedPlan ? ResearchPlanSchema.safeParse(storedPlan) : null;
  const orgForPlan = initial.plan || parsedPlan?.success ? null : await getCurrentOrganization().catch(() => null);
  let plan: ResearchPlan =
    initial.plan ??
    (parsedPlan?.success ? parsedPlan.data : null) ??
    buildResearchPlan(itemAsPlanner(item), {
      location: orgForPlan?.country === "AE" ? "UAE" : (orgForPlan?.country ?? null),
      deliveryLocation: item.enquiry.deliveryLocation,
      deliveryTimeframe: item.enquiry.requestedDeliveryTimeframe,
      maxQueries: limits.maxQueries,
    });

  await db.researchRun.update({
    where: { id: runId },
    data: { status: "PLANNING", stage: "PLANNING", planJson: stringifyJson(plan), error: null },
  });

  try {
    // Optional semantic planning pass. It may add queries; it cannot remove the
    // deterministic ones or exceed the run budget.
    if (plan.source === "DETERMINISTIC" && canUseAi(run, state, limits, 1)) {
      const augmented = await augmentPlanWithAi(plan, {
        maxAdditional: Math.min(8, limits.maxQueries - plan.queries.length),
        enquiryId: run.enquiryId,
        onAttempt: () => {
          state.aiCalls += 1;
        },
        onUsage: (usage) => {
          state.inputTokens += usage.inputTokens;
          state.outputTokens += usage.outputTokens;
          state.estimatedCostUsd += estimateAiCostUsd(usage.inputTokens, usage.outputTokens);
        },
      });
      if (augmented.queries.length > plan.queries.length) {
        const added = augmented.queries.length - plan.queries.length;
        plan = augmented;
        await db.researchRun.update({
          where: { id: runId },
          data: {
            planJson: stringifyJson(plan),
            aiCalls: state.aiCalls,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            estimatedCostUsd: state.estimatedCostUsd,
          },
        });
        await emitEvent(runId, "PLANNING", "AI added focused planning queries.", 0, { added });
      } else if (state.aiCalls > run.aiCalls) {
        await db.researchRun.update({
          where: { id: runId },
          data: {
            aiCalls: state.aiCalls,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            estimatedCostUsd: state.estimatedCostUsd,
          },
        });
      }
    }

    const existingQueries = await db.researchQuery.findMany({ where: { runId } });
    const executed = new Set(existingQueries.map((entry) => entry.query.trim().toLowerCase()));
    const existingPages = await db.researchPage.findMany({ where: { runId } });
    const pageSeen = new Set(
      existingPages
        .flatMap((page) => [page.url, page.finalUrl])
        .filter((url): url is string => Boolean(url))
        .map((url) => normalizedSourceUrl(url)),
    );
    const domainAttempts = new Map<string, number>();
    for (const page of existingPages) {
      if (page.domain) domainAttempts.set(page.domain, (domainAttempts.get(page.domain) ?? 0) + 1);
    }
    const evidenceSeen = new Set(
      (await db.researchEvidence.findMany({ where: { runId }, select: { candidateId: true, field: true, value: true, sourceUrl: true, sourceType: true } }))
        .map((entry) => `${entry.candidateId ?? ""}|${entry.field}|${(entry.value ?? "").toLowerCase()}|${entry.sourceUrl}|${entry.sourceType}`),
    );
    const sourceSeen = new Set(
      (await db.researchSource.findMany({ where: { runId }, select: { sourceUrl: true } }))
        .map((entry) => normalizedSourceUrl(entry.sourceUrl))
        .filter(Boolean),
    );
    const candidateRows = await db.researchCandidate.findMany({ where: { runId } });
    const candidatesByKey = new Map(candidateRows.map((candidate) => [candidate.candidateKey, candidate]));

    // Reconstruct pending work from durable sources and discovered links so a
    // resumed run continues investigating leads it had already found, instead
    // of starting over with a new search or abandoning those URLs.
    const resumableTargets: Array<{ url: string; key: string; score: number }> = [];
    const resumableSeen = new Set<string>();
    const existingSources = await db.researchSource.findMany({
      where: { runId, sourceUrl: { not: null } },
      select: { sourceUrl: true, domain: true },
    });
    for (const source of existingSources) {
      if (!source.sourceUrl) continue;
      const key = source.domain ? `domain:${source.domain}` : `domain:${normalizeDomain(source.sourceUrl) ?? ""}`;
      const candidate = candidatesByKey.get(key);
      const normalized = normalizedSourceUrl(source.sourceUrl);
      if (!candidate || !normalized || pageSeen.has(normalized) || resumableSeen.has(normalized)) continue;
      resumableSeen.add(normalized);
      resumableTargets.push({ url: source.sourceUrl, key: candidate.candidateKey, score: 2 });
    }
    for (const page of existingPages) {
      if (!page.candidateKey || !candidatesByKey.has(page.candidateKey)) continue;
      const links = parseJson<string[]>(page.linksJson, []);
      for (const link of links) {
        const normalized = normalizedSourceUrl(link);
        if (!normalized || pageSeen.has(normalized) || resumableSeen.has(normalized)) continue;
        resumableSeen.add(normalized);
        resumableTargets.push({ url: link, key: page.candidateKey, score: 1 });
      }
    }

    const totalPagesSoFar = existingPages.length;
    let pagesFetched = totalPagesSoFar;
    const initialQueriesRemain = plan.queries.some((query) => !executed.has(query.query.toLowerCase()));
    const startRound = initialQueriesRemain || existingQueries.length === 0 ? 1 : Math.max(2, run.iteration);
    let followUpQueries: ResearchQuery[] = [];
    if (startRound > 1) {
      // The previous worker stopped after its first round. Rebuild the evidence
      // gaps from saved candidates before continuing, so follow-ups are not lost
      // just because the in-memory list of gaps did not survive the interruption.
      const savedQualification = await refreshCandidateQualifications(runId, item, plan);
      followUpQueries = planFollowUpQueries({
        item: itemAsPlanner(item),
        plan,
        gaps: buildEvidenceGaps(savedQualification, plan),
        existingQueries: [...executed],
        iteration: startRound,
      });
      if (
        webSearchEnabled &&
        resumableTargets.length > 0 &&
        pagesFetched < limits.maxUrls &&
        state.estimatedCostUsd < budgetUsd(limits)
      ) {
        await db.researchRun.update({ where: { id: runId }, data: { status: "INVESTIGATING", stage: "INVESTIGATING" } });
        const resumedPages = await investigateTargets({
          runId,
          targets: resumableTargets,
          plan,
          item,
          limits,
          pageSeen,
          domainAttempts,
          evidenceSeen,
          candidatesByKey,
          state,
          pagesFetched,
        });
        pagesFetched = resumedPages.pagesFetched;
        state.budgetStopped = state.budgetStopped || resumedPages.budgetStopped;
        if (await isCancelled(runId)) return summarizeRun(runId);
        await refreshCandidateQualifications(runId, item, plan);
      }
    }
    let consecutiveEmptyRounds = 0;

    const adapters = getSearchAdapters();
    const searchContext: AdapterContext = {
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

    for (let round = startRound; round <= limits.maxRounds; round += 1) {
      if (await isCancelled(runId)) return summarizeRun(runId);
      if (state.estimatedCostUsd >= budgetUsd(limits)) {
        state.budgetStopped = true;
        await emitEvent(runId, "SEARCHING", "Research budget reached; no further paid work was started.", round, {}, "WARN");
        break;
      }
      const remainingQueryBudget = Math.max(0, limits.maxQueries - executed.size);
      if (remainingQueryBudget === 0) {
        state.budgetStopped = true;
        await emitEvent(runId, "SEARCHING", "Query budget reached; stopping before another round.", round, {
          executed: executed.size,
          maxQueries: limits.maxQueries,
        }, "WARN");
        break;
      }

      // Reserve part of the query budget for evidence-gap follow-ups. Otherwise
      // an exhaustive first round can consume the cap and make the workflow
      // indistinguishable from a one-shot search.
      const initialRoundCap = Math.max(1, Math.floor(limits.maxQueries * 0.7));
      const roundBudget = round === 1 ? Math.min(remainingQueryBudget, initialRoundCap) : remainingQueryBudget;
      const roundQueries =
        round === 1
          ? plan.queries.filter((query) => !executed.has(query.query.toLowerCase())).slice(0, roundBudget)
          : followUpQueries.filter((query) => !executed.has(query.query.toLowerCase())).slice(0, roundBudget);
      if (roundQueries.length === 0) break;

      await db.researchRun.update({
        where: { id: runId },
        data: { status: "SEARCHING", stage: "SEARCHING", iteration: round },
      });
      await emitEvent(runId, "SEARCHING", `Round ${round}: ${roundQueries.length} focused queries.`, round, {
        categories: [...new Set(roundQueries.map((query) => query.category))],
      });

      const outcome: ResearchSearchOutcome = await executeResearchQueries({
        queries: roundQueries,
        context: searchContext,
        adapters,
        webSearchEnabled,
        concurrency: 2,
      });
      for (const query of roundQueries) executed.add(query.query.toLowerCase());
      state.searchRequests += outcome.searchRequests;
      if (outcome.coverage.length > 0) {
        const byAdapter = new Map(state.coverage.map((entry) => [entry.adapter, entry]));
        for (const entry of outcome.coverage) {
          const previous = byAdapter.get(entry.adapter);
          byAdapter.set(entry.adapter, previous ? mergeCoverage(previous, entry) : entry);
        }
        state.coverage = [...byAdapter.values()];
      }
      state.providerFailures.push(
        ...outcome.coverage.filter((entry) => entry.status === "FAILED").map((entry) => entry.label),
      );

      await persistQueryResults(runId, outcome, round);
      await db.researchRun.update({
        where: { id: runId },
        data: {
          searchRequests: state.searchRequests,
          coverageJson: stringifyJson(state.coverage),
        },
      });

      // Turn raw results into sources and unique business candidates. Directory
      // and social pages remain raw results; they are never presented as a
      // supplier's own website. Start with durable targets left by an earlier
      // interrupted run, then add this round's new leads.
      const newTargets: Array<{ url: string; key: string; score: number }> = [...resumableTargets];
      for (const hit of outcome.hits) {
        for (const candidate of hit.candidates) {
          if (isDirectory(candidate.sourceUrl)) {
            await persistSource(runId, candidate, hit.provider, sourceSeen, null);
            continue;
          }
          const key = candidateKey(candidate);
          if (!key) continue;
          const row = await ensureCandidate(runId, key, candidate, candidatesByKey);
          if (!row) continue;
          await persistSource(runId, candidate, hit.provider, sourceSeen, row.id);
          const snippets = snippetEvidence({
            title: candidate.title,
            snippet: candidate.snippet ?? null,
            url: candidate.sourceUrl ?? `internal://supplier/${candidate.supplierId ?? key}`,
            provider: hit.provider,
            retrievedAt: candidate.retrievedAt,
          });
          if (snippets.length > 0) {
            await saveClaims({
              runId,
              candidateId: row.id,
              pageId: null,
              claims: snippets,
              seen: evidenceSeen,
            });
          }
          if (candidate.adapter === "INTERNAL_SUPPLIERS") {
            const internal = evidenceFromInternal(candidate, plan.product.commonTerminology);
            if (internal.length > 0) {
              await saveClaims({
                runId,
                candidateId: row.id,
                pageId: null,
                claims: internal,
                seen: evidenceSeen,
              });
            }
          }
          if (candidate.sourceUrl) {
            newTargets.push({ url: candidate.sourceUrl, key, score: targetScore(candidate, plan.product.commonTerminology) });
          }
        }
      }

      // Investigate promising websites, not every result. This is the stage
      // that turns a search lead into evidence-backed supplier research.
      if (webSearchEnabled && pagesFetched < limits.maxUrls) {
        await db.researchRun.update({ where: { id: runId }, data: { status: "INVESTIGATING", stage: "INVESTIGATING" } });
        const result = await investigateTargets({
          runId,
          targets: newTargets,
          plan,
          item,
          limits,
          pageSeen,
          domainAttempts,
          evidenceSeen,
          candidatesByKey,
          state,
          pagesFetched,
        });
        pagesFetched = result.pagesFetched;
        state.budgetStopped = state.budgetStopped || result.budgetStopped;
      }

      // A cancellation may arrive while a page is being fetched. Do not analyze
      // or overwrite the terminal cancelled state after that in-flight work.
      if (await isCancelled(runId)) return summarizeRun(runId);

      await db.researchRun.update({ where: { id: runId }, data: { status: "ANALYZING", stage: "ANALYZING" } });
      const qualified = await refreshCandidateQualifications(runId, item, plan);
      const summary = summarizeCandidates(qualified);
      await db.researchRun.update({
        where: { id: runId },
        data: { summaryJson: stringifyJson(summary) },
      });

      if (summary.exact > 0 || summary.compatible > 0) consecutiveEmptyRounds = 0;
      else consecutiveEmptyRounds += 1;

      if (state.budgetStopped || state.estimatedCostUsd >= budgetUsd(limits)) break;

      // A sufficient shortlist can stop early. The owner can still ask for more.
      if (summary.exact >= 2 && summary.candidates >= 3) {
        await emitEvent(runId, "ANALYZING", "Enough evidence-backed candidates found; stopping early.", round, summary);
        break;
      }

      if (round < limits.maxRounds) {
        const gaps = buildEvidenceGaps(qualified, plan);
        followUpQueries = planFollowUpQueries({
          item: itemAsPlanner(item),
          plan,
          gaps,
          existingQueries: [...executed],
          iteration: round + 1,
        });
        if (followUpQueries.length === 0) {
          if (consecutiveEmptyRounds > 0) {
            await emitEvent(runId, "FOLLOW_UP", "No meaningful follow-up query remains.", round, summary);
          }
          break;
        }
        await db.researchRun.update({ where: { id: runId }, data: { status: "FOLLOW_UP", stage: "FOLLOW_UP" } });
        await emitEvent(runId, "FOLLOW_UP", `${followUpQueries.length} follow-up queries planned from evidence gaps.`, round + 1, {
          gaps: gaps.slice(0, 12),
        });
      }
    }

    const finalCandidates = await db.researchCandidate.findMany({ where: { runId } });
    const summary = summarizeCandidates(finalCandidates);
    const coverage = state.coverage.length > 0 ? state.coverage : [];
    const operationalProblem =
      state.providerFailures.length > 0 ||
      state.budgetStopped ||
      coverage.some((entry) => entry.status === "FAILED" || entry.status === "PARTIAL");
    const noCandidates = finalCandidates.length === 0;
    const allFailed = coverage.length > 0 && coverage.every((entry) => entry.status === "FAILED" || entry.status === "NOT_CONFIGURED");
    const status: ResearchStatus = noCandidates && allFailed ? "FAILED" : noCandidates || operationalProblem ? "PARTIAL" : "COMPLETED";
    const report = {
      product: plan.product,
      status,
      summary,
      coverage,
      limitations: [
        "Search results are leads, not verified supplier facts.",
        "A published catalogue does not prove stock, price or availability.",
        "Marketplace access is only included when an approved API integration is configured.",
        ...state.providerFailures.map((failure) => `${failure} failed or was partially unavailable.`),
        ...(state.budgetStopped ? ["The configured research budget stopped the run before all possible rounds."] : []),
      ],
      generatedAt: new Date().toISOString(),
    };
    const finished = await db.researchRun.updateMany({
      where: { id: runId, status: { not: "CANCELLED" } },
      data: {
        status,
        stage: status,
        summaryJson: stringifyJson(summary),
        reportJson: stringifyJson(report),
        coverageJson: stringifyJson(coverage),
        searchRequests: state.searchRequests,
        pageFetches: state.pageFetches,
        documentsProcessed: state.documentsProcessed,
        aiCalls: state.aiCalls,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        estimatedCostUsd: state.estimatedCostUsd,
        completedAt: new Date(),
        activeKey: null,
        error: status === "FAILED" ? "No configured source returned a usable supplier lead." : null,
      },
    });
    if (finished.count === 0) return summarizeRun(runId);
    await writeAudit({
      action: "sourcing.deep_research.completed",
      entityType: "ResearchRun",
      entityId: runId,
      actorLabel: "sourcing",
      meta: { status, ...summary },
    }).catch(() => undefined);
    return summarizeRun(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 800) : "Deep research failed";
    const existingCandidates = await db.researchCandidate.count({ where: { runId } }).catch(() => 0);
    const status: ResearchStatus = existingCandidates > 0 ? "PARTIAL" : "FAILED";
    const failed = await db.researchRun
      .updateMany({
        where: { id: runId, status: { not: "CANCELLED" } },
        data: {
          status,
          stage: status,
          error: message,
          completedAt: new Date(),
          activeKey: null,
          searchRequests: state.searchRequests,
          pageFetches: state.pageFetches,
          documentsProcessed: state.documentsProcessed,
          aiCalls: state.aiCalls,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          estimatedCostUsd: state.estimatedCostUsd,
          coverageJson: stringifyJson(state.coverage),
        },
      })
      .catch(() => ({ count: 0 }));
    if (failed.count === 0) return summarizeRun(runId);
    await emitEvent(runId, "FAILED", message, 0, {}, "ERROR");
    return summarizeRun(runId);
  }
}

async function finishRun(runId: string, status: ResearchStatus, message: string): Promise<void> {
  await db.researchRun.update({
    where: { id: runId },
    data: {
      status,
      stage: status,
      error: status === "FAILED" ? message : null,
      completedAt: new Date(),
      activeKey: null,
    },
  });
  await emitEvent(runId, status, message, 0, {}, status === "FAILED" ? "ERROR" : "INFO");
}

async function persistQueryResults(runId: string, outcome: ResearchSearchOutcome, round: number): Promise<void> {
  if (outcome.hits.length === 0) return;
  await db.researchQuery.createMany({
    data: outcome.hits.map((hit) => ({
      runId,
      iteration: round,
      round,
      query: hit.query.query.slice(0, 300),
      productTarget: hit.query.productTarget.slice(0, 160),
      objective: hit.query.objective.slice(0, 240),
      location: hit.query.location?.slice(0, 120) ?? null,
      requiredEvidence: hit.query.requiredEvidence.slice(0, 240),
      category: hit.query.category,
      reason: hit.query.reason.slice(0, 240),
      provider: hit.provider,
      status: hit.status,
      resultCount: hit.resultCount,
      error: hit.error?.slice(0, 500) ?? null,
    })),
    skipDuplicates: true,
  });
}

async function persistSource(
  runId: string,
  candidate: SourcingCandidate,
  provider: string,
  seen: Set<string>,
  candidateId: string | null,
): Promise<void> {
  const key = normalizedSourceUrl(candidate.sourceUrl) || `name:${candidate.supplierName.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  await db.researchSource.create({
    data: {
      runId,
      provider: String(candidate.evidence?.provider ?? provider),
      queryId: null,
      sourceUrl: candidate.sourceUrl ?? null,
      domain: candidateDomain(candidate),
      title: candidate.title.slice(0, 300),
      snippet: candidate.snippet?.slice(0, 1600) ?? null,
      supplierName: candidate.supplierName.slice(0, 220),
      sourceType: candidate.adapter === "INTERNAL_SUPPLIERS" ? "INTERNAL_SUPPLIER_RECORD" : "SEARCH_RESULT",
      evidenceJson: stringifyJson({
        ...(candidate.evidence ?? {}),
        candidateId,
        adapter: candidate.adapter,
        provider: candidate.evidence?.provider ?? provider,
      }),
      retrievedAt: candidate.retrievedAt,
    },
  });
}

async function ensureCandidate(
  runId: string,
  key: string,
  candidate: SourcingCandidate,
  candidatesByKey: Map<string, { id: string; candidateKey: string; canonicalName: string; domain: string | null; website: string | null; description: string | null; classification: string | null; country: string | null; city: string | null; contactJson: string; productCategoriesJson: string; capabilitiesJson: string; certificationsJson: string; aliasesJson: string; branchesJson: string; matchStatus: string; matchJson: string; confidence: number; evidenceCount: number; pageCount: number; supplierId: string | null; status: string }>,
): Promise<{ id: string; candidateKey: string; canonicalName: string; domain: string | null; website: string | null; description: string | null; classification: string | null; country: string | null; city: string | null; contactJson: string; productCategoriesJson: string; capabilitiesJson: string; certificationsJson: string; aliasesJson: string; branchesJson: string; matchStatus: string; matchJson: string; confidence: number; evidenceCount: number; pageCount: number; supplierId: string | null; status: string } | null> {
  if (!key) return null;
  const existing = candidatesByKey.get(key);
  if (existing) return existing;
  const domain = candidateDomain(candidate);
  const row = await db.researchCandidate.create({
    data: {
      runId,
      candidateKey: key,
      canonicalName: candidate.supplierName.trim().slice(0, 220) || domain || "Unknown supplier",
      domain,
      website: originOf(candidate.sourceUrl),
      description: null,
      classification: "UNKNOWN",
      country: null,
      city: null,
      contactJson: "[]",
      productCategoriesJson: "[]",
      capabilitiesJson: "[]",
      certificationsJson: "[]",
      aliasesJson: "[]",
      branchesJson: "[]",
      matchStatus: "UNVERIFIED",
      matchJson: "{}",
      confidence: 0,
      evidenceCount: 0,
      pageCount: 0,
      supplierId: candidate.supplierId ?? null,
      status: "NEW",
    },
  });
  candidatesByKey.set(key, row);
  return row;
}

async function investigateTargets(input: {
  runId: string;
  targets: Array<{ url: string; key: string; score: number }>;
  plan: ResearchPlan;
  item: NonNullable<Awaited<ReturnType<typeof db.enquiryItem.findUnique>>> & { enquiry: { deliveryLocation: string | null; requestedDeliveryTimeframe: string | null; urgency: string | null } };
  limits: Awaited<ReturnType<typeof getResearchLimits>>;
  pageSeen: Set<string>;
  domainAttempts: Map<string, number>;
  evidenceSeen: Set<string>;
  candidatesByKey: Map<string, { id: string; candidateKey: string; canonicalName: string; domain: string | null; website: string | null; description: string | null; classification: string | null; country: string | null; city: string | null; contactJson: string; productCategoriesJson: string; capabilitiesJson: string; certificationsJson: string; aliasesJson: string; branchesJson: string; matchStatus: string; matchJson: string; confidence: number; evidenceCount: number; pageCount: number; supplierId: string | null; status: string }>;
  state: RunState;
  pagesFetched: number;
}): Promise<{ pagesFetched: number; budgetStopped: boolean }> {
  const pending = [...input.targets].sort((a, b) => b.score - a.score);
  let pagesFetched = input.pagesFetched;
  let budgetStopped = false;
  // Reserve AI calls per page before concurrent work starts, so a batch cannot
  // exceed maxAiCalls simply because several pages fan out at once.
  let aiSlots = Math.max(0, input.limits.maxAiCalls - input.state.aiCalls);

  while (pending.length > 0 && pagesFetched < input.limits.maxUrls) {
    if (await isCancelled(input.runId)) break;
    if (input.state.estimatedCostUsd >= budgetUsd(input.limits)) {
      budgetStopped = true;
      break;
    }
    const batch: Array<{ url: string; key: string }> = [];
    while (batch.length < input.limits.maxConcurrentPages && pending.length > 0 && pagesFetched < input.limits.maxUrls) {
      const target = pending.shift();
      if (!target) break;
      const normalized = normalizedSourceUrl(target.url);
      if (!normalized || input.pageSeen.has(normalized)) continue;
      const domain = normalizeDomain(target.url);
      if (domain && (input.domainAttempts.get(domain) ?? 0) >= input.limits.maxPagesPerDomain) continue;
      input.pageSeen.add(normalized);
      if (domain) input.domainAttempts.set(domain, (input.domainAttempts.get(domain) ?? 0) + 1);
      batch.push(target);
    }
    if (batch.length === 0) break;

    const investigated = await mapLimit(batch, input.limits.maxConcurrentPages, async (target) => {
      if (await isCancelled(input.runId)) return null;
      const aiAllowed =
        aiSlots > 0 &&
        canUseAi(
          { aiCalls: input.state.aiCalls, estimatedCostUsd: input.state.estimatedCostUsd },
          input.state,
          input.limits,
          1,
        );
      if (aiAllowed) aiSlots -= 1;
      const result = await investigateResearchUrl({
        url: target.url,
        familyTerms: input.plan.product.commonTerminology,
        limits: { maxPageBytes: input.limits.maxPageBytes, requestTimeoutMs: input.limits.requestTimeoutMs },
        aiAllowed,
        fetchAllowed: true,
        enquiryId: input.item.enquiryId,
      });
      return { target, result };
    });

    for (const entry of investigated) {
      if (!entry) continue;
      pagesFetched += 1;
      const { target, result } = entry;
      const candidate = input.candidatesByKey.get(target.key);
      if (!candidate) continue;

      const page = await persistPage(input.runId, target.key, result);
      if (result.status === "FETCHED") {
        input.state.pageFetches += 1;
        const contentType = result.contentType ?? "";
        if (
          ["PDF", "SPREADSHEET", "OCR"].includes(result.evidence[0]?.sourceType ?? "") ||
          /pdf|spreadsheet|excel|csv|image\//i.test(contentType)
        ) {
          input.state.documentsProcessed += 1;
        }
        if (result.aiUsage) {
          input.state.aiCalls += 1;
          input.state.inputTokens += result.aiUsage.inputTokens;
          input.state.outputTokens += result.aiUsage.outputTokens;
          input.state.estimatedCostUsd += estimateAiCostUsd(result.aiUsage.inputTokens, result.aiUsage.outputTokens);
        }
        await saveClaims({
          runId: input.runId,
          candidateId: candidate.id,
          pageId: page.id,
          claims: result.evidence,
          seen: input.evidenceSeen,
        });
        if (result.supplier) await mergeSupplierProfile(candidate.id, result.supplier);
        if (result.promptInjectionSuspected) {
          await emitEvent(input.runId, "INVESTIGATING", "Retrieved content contained instruction-like text; it was treated as untrusted data only.", input.plan.queries.length, {
            url: result.finalUrl ?? result.url,
          }, "WARN");
        }
        // Follow relevant same-site links, but only within the per-domain and
        // total URL budgets.
        const domain = result.domain;
        const remainingForDomain = domain ? Math.max(0, input.limits.maxPagesPerDomain - (input.domainAttempts.get(domain) ?? 0)) : 0;
        if (remainingForDomain > 0) {
          const links = discoverResearchLinks(result.finalUrl ?? result.url, result.links, remainingForDomain);
          for (const link of links) {
            const normalized = normalizedSourceUrl(link);
            if (normalized && !input.pageSeen.has(normalized)) {
              pending.push({ url: link, key: target.key, score: 1 });
            }
          }
        }
      } else {
        await emitEvent(input.runId, "INVESTIGATING", `Page not used: ${result.note ?? result.status}.`, 0, {
          url: result.url,
          status: result.status,
        }, "WARN");
      }
      await db.researchRun.update({
        where: { id: input.runId },
        data: {
          pageFetches: input.state.pageFetches,
          documentsProcessed: input.state.documentsProcessed,
          aiCalls: input.state.aiCalls,
          inputTokens: input.state.inputTokens,
          outputTokens: input.state.outputTokens,
          estimatedCostUsd: input.state.estimatedCostUsd,
        },
      });
      if (input.state.estimatedCostUsd >= budgetUsd(input.limits)) {
        budgetStopped = true;
        break;
      }
    }
    if (budgetStopped) break;
  }

  return { pagesFetched, budgetStopped };
}

async function persistPage(runId: string, candidateKeyValue: string, result: InvestigatedPage): Promise<{ id: string }> {
  const existing = await db.researchPage.findFirst({ where: { runId, url: result.url } });
  if (existing) return existing;
  const page = await db.researchPage.create({
    data: {
      runId,
      candidateKey: candidateKeyValue,
      url: result.url.slice(0, 2048),
      finalUrl: result.finalUrl?.slice(0, 2048) ?? null,
      domain: result.domain,
      title: result.title?.slice(0, 300) ?? null,
      pageType: result.pageType,
      status: result.status,
      httpStatus: result.httpStatus,
      contentType: result.contentType?.slice(0, 160) ?? null,
      contentHash: result.contentHash,
      excerpt: result.excerpt?.slice(0, 1600) ?? null,
      text: result.text?.slice(0, 60_000) ?? null,
      linksJson: stringifyJson(result.links.slice(0, 30)),
      documentLocation: result.documentLocation,
      pageCount: result.pageCount,
      fetchedAt: result.fetchedAt,
    },
  });
  return page;
}

async function mergeSupplierProfile(
  candidateId: string,
  profile: NonNullable<InvestigatedPage["supplier"]>,
): Promise<void> {
  const candidate = await db.researchCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return;
  const parsedContacts = parseJson<unknown>(candidate.contactJson, []);
  const existingContacts = Array.isArray(parsedContacts)
    ? (parsedContacts as Array<{ type: string; value: string; sourceUrl: string; verificationStatus: string }>)
    : [];
  const contacts = [...existingContacts];
  for (const contact of profile.contacts) {
    if (!contacts.some((entry) => entry.type === contact.type && entry.value.toLowerCase() === contact.value.toLowerCase())) {
      contacts.push(contact);
    }
  }
  const canonical =
    profile.canonicalName &&
    !/^(home|products?|contact|about|welcome|catalogue)$/i.test(profile.canonicalName) &&
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(profile.canonicalName)
      ? profile.canonicalName
      : candidate.canonicalName;
  await db.researchCandidate.update({
    where: { id: candidateId },
    data: {
      canonicalName: canonical.slice(0, 220),
      website: candidate.website ?? profile.website,
      description: candidate.description ?? profile.description,
      classification: candidate.classification === "UNKNOWN" ? profile.classification : candidate.classification,
      country: candidate.country ?? profile.countries[0] ?? null,
      city: candidate.city ?? profile.locations[0] ?? null,
      contactJson: stringifyJson(contacts.slice(0, 20)),
      productCategoriesJson: stringifyJson(
        mergeUnique(parseJson<string[]>(candidate.productCategoriesJson, []), profile.productCategories),
      ),
      capabilitiesJson: stringifyJson(mergeUnique(parseJson<string[]>(candidate.capabilitiesJson, []), profile.capabilities)),
      certificationsJson: stringifyJson(mergeUnique(parseJson<string[]>(candidate.certificationsJson, []), profile.certifications)),
      aliasesJson: stringifyJson(mergeUnique(parseJson<string[]>(candidate.aliasesJson, []), profile.aliases)),
      branchesJson: stringifyJson(mergeUnique(parseJson<string[]>(candidate.branchesJson, []), profile.branches)),
    },
  });
}

async function refreshCandidateQualifications(
  runId: string,
  item: NonNullable<Awaited<ReturnType<typeof db.enquiryItem.findUnique>>>,
  plan: ResearchPlan,
): Promise<Array<{ id: string; matchStatus: string; missingAttributes: string[]; domain: string | null; canonicalName: string }>> {
  const [candidates, evidence, pages, equivalences] = await Promise.all([
    db.researchCandidate.findMany({ where: { runId } }),
    db.researchEvidence.findMany({ where: { runId } }),
    db.researchPage.findMany({
      where: { runId, status: "FETCHED" },
      select: { candidateKey: true, pageType: true, excerpt: true, text: true },
    }),
    db.materialEquivalence.findMany({
      where: { isActive: true },
      select: { requestedMaterial: true, offeredMaterial: true, requestedGrade: true, offeredGrade: true, reason: true },
    }),
  ]);
  const evidenceByCandidate = new Map<string, ResearchEvidenceRecord[]>();
  for (const claim of evidence) {
    if (!claim.candidateId) continue;
    const list = evidenceByCandidate.get(claim.candidateId) ?? [];
    list.push({
      id: claim.id,
      field: claim.field,
      claim: claim.claim,
      value: claim.value,
      sourceUrl: claim.sourceUrl,
      pageTitle: claim.pageTitle,
      sourceType: claim.sourceType as ResearchEvidenceClaim["sourceType"],
      excerpt: claim.excerpt,
      documentLocation: claim.documentLocation,
      pageNumber: claim.pageNumber,
      sheetName: claim.sheetName,
      rowNumber: claim.rowNumber,
      retrievedAt: claim.retrievedAt.toISOString(),
      extractionMethod: claim.extractionMethod as ResearchEvidenceClaim["extractionMethod"],
      verificationStatus: claim.verificationStatus as ResearchEvidenceClaim["verificationStatus"],
    });
    evidenceByCandidate.set(claim.candidateId, list);
  }

  const output: Array<{ id: string; matchStatus: string; missingAttributes: string[]; domain: string | null; canonicalName: string }> = [];
  for (const candidate of candidates) {
    const claims = evidenceByCandidate.get(candidate.id) ?? [];
    const pageEvidence = pages.filter(
      (page) =>
        page.candidateKey === candidate.candidateKey &&
        ["PRODUCT", "CATALOGUE", "CERTIFICATION", "LOCATION"].includes(page.pageType),
    );
    const familyTerms = plan.product.commonTerminology;
    const hasFamilyEvidence =
      pageEvidence.some((page) => {
        const text = `${page.excerpt ?? ""} ${page.text ?? ""}`.toLowerCase();
        return familyTerms.some((term) => text.includes(term.toLowerCase()));
      }) ||
      parseJson<string[]>(candidate.productCategoriesJson, []).some((category) =>
        familyTerms.some((term) => category.toLowerCase().includes(term.toLowerCase())),
      );
    const qualification = qualifySupplierCandidate({
      item: {
        description: item.description,
        category: item.category,
        brand: item.brand,
        size: item.size,
        material: item.material,
        grade: item.grade,
        pressureRating: item.pressureRating,
        schedule: item.schedule,
        standard: item.standard,
        industrialSpecJson: item.industrialSpecJson,
        fastenerSpecJson: item.fastenerSpecJson,
        missingFields: item.missingFields,
      },
      understanding: plan.product,
      evidence: claims,
      hasFamilyEvidence,
      equivalences,
    });
    await db.researchCandidate.update({
      where: { id: candidate.id },
      data: {
        matchStatus: qualification.status,
        matchJson: stringifyJson(qualification),
        confidence: qualification.confidence,
        evidenceCount: claims.length,
        pageCount: pageEvidence.length,
      },
    });
    output.push({
      id: candidate.id,
      matchStatus: qualification.status,
      missingAttributes: qualification.missingAttributes.map((entry) => entry.label),
      domain: candidate.domain,
      canonicalName: candidate.canonicalName,
    });
  }
  return output;
}

function buildEvidenceGaps(
  candidates: Array<{ id: string; matchStatus: string; missingAttributes: string[]; domain: string | null; canonicalName: string }>,
  plan: ResearchPlan,
): FollowUpGap[] {
  const gaps: FollowUpGap[] = [];
  for (const candidate of candidates) {
    if (candidate.matchStatus === "EXACT" || candidate.matchStatus === "NO_MATCH") continue;
    if (!candidate.domain) continue;
    const missing = uniqueStrings(candidate.missingAttributes)
      .concat(plan.product.unknownSpecifications)
      .slice(0, 4);
    if (missing.length === 0) continue;
    gaps.push({
      domain: candidate.domain,
      supplierName: candidate.canonicalName,
      missing,
      reason:
        candidate.matchStatus === "POSSIBLE"
          ? `The website is relevant to the product family, but is missing ${missing.join(", ")}.`
          : `The published evidence does not yet resolve ${missing.join(", ")}.`,
    });
  }
  // If no candidates have domains, follow-up cannot investigate a supplier
  // website. Do not invent follow-up searches that cannot resolve the gap.
  return gaps.slice(0, 8);
}

function summarizeCandidates(
  candidates: Array<{ matchStatus: string }>,
): {
  candidates: number;
  suppliersWithEvidence: number;
  exact: number;
  compatible: number;
  possible: number;
  unverified: number;
  noMatch: number;
} {
  const summary = {
    candidates: candidates.length,
    suppliersWithEvidence: 0,
    exact: 0,
    compatible: 0,
    possible: 0,
    unverified: 0,
    noMatch: 0,
  };
  for (const candidate of candidates) {
    if (candidate.matchStatus === "EXACT") {
      summary.exact += 1;
      summary.suppliersWithEvidence += 1;
    } else if (candidate.matchStatus === "COMPATIBLE") {
      summary.compatible += 1;
      summary.suppliersWithEvidence += 1;
    } else if (candidate.matchStatus === "POSSIBLE") {
      summary.possible += 1;
      summary.suppliersWithEvidence += 1;
    } else if (candidate.matchStatus === "NO_MATCH") {
      summary.noMatch += 1;
    } else {
      summary.unverified += 1;
    }
  }
  return summary;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function budgetUsd(limits: Awaited<ReturnType<typeof getResearchLimits>>): number {
  if (limits.budgetAed == null) return Number.POSITIVE_INFINITY;
  const rate = env.FIXED_USD_AED > 0 ? env.FIXED_USD_AED : 3.6725;
  return limits.budgetAed / rate;
}

function canUseAi(
  run: { aiCalls: number; estimatedCostUsd: number },
  state: RunState,
  limits: Awaited<ReturnType<typeof getResearchLimits>>,
  additionalCalls = 1,
): boolean {
  if (limits.maxAiCalls <= 0) return false;
  if (run.aiCalls + additionalCalls > limits.maxAiCalls) return false;
  if (run.estimatedCostUsd >= budgetUsd(limits)) return false;
  // Keep the state object in the signature so callers can see that the budget
  // is checked against the same counters that are persisted after each page.
  return state.estimatedCostUsd < budgetUsd(limits);
}

export async function resumeDeepResearchRun(
  runId: string,
  options: ResearchRunOptions = { mode: "DEEP" },
): Promise<DeepResearchResult> {
  const organizationId = await requireTenantId();
  const run = await db.researchRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) throw new Error("Research run not found");
  if (run.status === "CANCELLED") return summarizeRun(run.id);
  if (!isActive(run.status) && run.status === "COMPLETED") return summarizeRun(run.id);
  const activeKey = run.activeKey ?? `deep:${organizationId}:${run.enquiryItemId ?? run.enquiryId}`;
  const previousLimits = parseJson<{ webSearchEnabled?: boolean }>(run.limitsJson, {});
  const webSearchEnabled = previousLimits.webSearchEnabled ?? (await getOrgLimits()).webSearchEnabled;
  try {
    await db.researchRun.update({
      where: { id: run.id },
      data: {
        activeKey,
        status: "QUEUED",
        stage: "QUEUED",
        error: null,
        completedAt: null,
        limitsJson: stringifyJson({
          ...(await getResearchLimits({
            maxRounds: options.maxRounds,
            maxQueries: options.maxQueries,
            maxUrls: options.maxUrls,
            maxPagesPerDomain: options.maxPagesPerDomain,
            maxConcurrentPages: options.maxConcurrentPages,
            budgetAed: options.budgetAed,
          })),
          webSearchEnabled,
        }),
      },
    });
  } catch {
    const current = await db.researchRun.findFirst({ where: { activeKey } });
    if (current && current.id !== run.id) return { ...(await summarizeRun(current.id)), alreadyRunning: true };
  }
  return processDeepResearchRun(run.id);
}

export async function cancelDeepResearchRun(runId: string): Promise<DeepResearchResult> {
  const run = await db.researchRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Research run not found");
  if (!isActive(run.status) && run.status !== "PARTIAL" && run.status !== "FAILED") {
    return summarizeRun(runId);
  }
  await db.researchRun.update({
    where: { id: runId },
    data: {
      status: "CANCELLED",
      stage: "CANCELLED",
      activeKey: null,
      completedAt: new Date(),
      error: null,
    },
  });
  await emitEvent(runId, "CANCELLED", "Research cancelled by the owner. Existing results were preserved.", run.iteration, {}, "WARN");
  await writeAudit({
    action: "sourcing.deep_research.cancelled",
    entityType: "ResearchRun",
    entityId: runId,
    actorLabel: "owner",
  }).catch(() => undefined);
  return summarizeRun(runId);
}

export async function summarizeRun(runId: string): Promise<DeepResearchResult> {
  const run = await db.researchRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Research run not found");
  const [candidates, queries, pages, evidence] = await Promise.all([
    db.researchCandidate.findMany({ where: { runId }, select: { matchStatus: true } }),
    db.researchQuery.count({ where: { runId } }),
    db.researchPage.count({ where: { runId } }),
    db.researchEvidence.count({ where: { runId } }),
  ]);
  const summary = summarizeCandidates(candidates);
  const coverage = parseJson<CoverageEntry[]>(run.coverageJson, []);
  return {
    runId,
    status: run.status as ResearchStatus,
    candidates: summary.candidates,
    exact: summary.exact,
    compatible: summary.compatible,
    possible: summary.possible,
    unverified: summary.unverified,
    noMatch: summary.noMatch,
    suppliersWithEvidence: summary.suppliersWithEvidence,
    queries,
    pages,
    evidence,
    searchRequests: run.searchRequests,
    pageFetches: run.pageFetches,
    documentsProcessed: run.documentsProcessed,
    aiCalls: run.aiCalls,
    estimatedCostUsd: Math.round(run.estimatedCostUsd * 1_000_000) / 1_000_000,
    coverage,
    message:
      summary.candidates === 0
        ? "No usable supplier candidate was found. This is not proof that no supplier exists."
        : `${summary.suppliersWithEvidence} supplier candidate${summary.suppliersWithEvidence === 1 ? "" : "s"} with relevant evidence; ${summary.exact} exact and ${summary.compatible} compatible.`,
  };
}

/**
 * Runs bounded deep research for every sourceable line in an enquiry. Each line
 * has its own run so a multi-product RFQ cannot hide one product's gaps behind
 * another's results.
 */
export async function runDeepResearchForEnquiry(
  enquiryId: string,
  options: ResearchRunOptions = { mode: "DEEP" },
): Promise<DeepResearchResult[]> {
  const items = await db.enquiryItem.findMany({
    where: { enquiryId, quantityToSource: { gt: 0 } },
    orderBy: { lineNo: "asc" },
    select: { id: true },
  });
  const results: DeepResearchResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(2, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await runDeepResearchForItem(items[index].id, options);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Intuitive aliases for callers and tests. */
export const runDeepResearch = runDeepResearchForItem;
export const startDeepResearch = runDeepResearchForItem;
export const resumeDeepResearch = resumeDeepResearchRun;
export const cancelResearchRun = cancelDeepResearchRun;

/** Stable, non-secret identifier for a website entity. */
export function researchCandidateKey(candidate: SourcingCandidate): string {
  return candidateKey(candidate);
}

/** Stable hash used to avoid processing an unchanged page twice. */
export function researchContentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
