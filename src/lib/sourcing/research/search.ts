import type { AdapterContext, CoverageEntry, SearchAdapter, SourcingCandidate } from "../types";
import type { ResearchQuery } from "../../validation/research";

export type ResearchSearchResult = {
  query: ResearchQuery;
  provider: string;
  providerLabel: string;
  status: string;
  resultCount: number;
  error?: string;
  candidates: SourcingCandidate[];
};

export type ResearchSearchOutcome = {
  hits: ResearchSearchResult[];
  candidates: SourcingCandidate[];
  coverage: CoverageEntry[];
  searchRequests: number;
  notes: string[];
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs planned queries against every connected adapter. Each query/provider
 * pair keeps its own status, so a failed provider is never hidden behind a
 * working one and a raw search-result count is never shown as a supplier count.
 */
export async function executeResearchQueries(input: {
  queries: ResearchQuery[];
  context: AdapterContext;
  adapters: SearchAdapter[];
  webSearchEnabled: boolean;
  concurrency?: number;
}): Promise<ResearchSearchOutcome> {
  const hits: ResearchSearchResult[] = [];
  const notes: string[] = [];
  let searchRequests = 0;

  const perQuery = await mapLimit(input.queries, input.concurrency ?? 2, async (query) => {
    const queryHits: ResearchSearchResult[] = [];
    for (const adapter of input.adapters) {
      if (adapter.key === "PUBLIC_WEB" && !input.webSearchEnabled) {
        queryHits.push({
          query,
          provider: adapter.key,
          providerLabel: adapter.label,
          status: "NOT_CONFIGURED",
          resultCount: 0,
          error: "Web search is disabled in this organization's limits.",
          candidates: [],
        });
        continue;
      }
      if (!adapter.available()) {
        queryHits.push({
          query,
          provider: adapter.key,
          providerLabel: adapter.label,
          status: "NOT_CONFIGURED",
          resultCount: 0,
          error: adapter.unavailableReason?.() ?? "Not configured",
          candidates: [],
        });
        continue;
      }
      try {
        searchRequests += 1;
        const result = await adapter.search([query.query], input.context);
        const count = result.candidates.length;
        queryHits.push({
          query,
          provider: adapter.key,
          providerLabel: adapter.label,
          status: result.status,
          resultCount: count,
          error: result.note,
          candidates: result.candidates.map((candidate) => ({
            ...candidate,
            evidence: {
              ...(candidate.evidence ?? {}),
              discoveryProvider: String(candidate.evidence?.provider ?? adapter.key),
              discoveryQuery: query.query,
              researchCategory: query.category,
              researchObjective: query.objective,
            },
          })),
        });
        if (result.note) notes.push(`${adapter.label}: ${result.note}`);
      } catch (error) {
        queryHits.push({
          query,
          provider: adapter.key,
          providerLabel: adapter.label,
          status: "FAILED",
          resultCount: 0,
          error: error instanceof Error ? error.message.slice(0, 300) : "Adapter failed",
          candidates: [],
        });
      }
    }
    return queryHits;
  });

  for (const group of perQuery) hits.push(...group);

  const coverageMap = new Map<string, CoverageEntry>();
  for (const adapter of input.adapters) {
    const rows = hits.filter((hit) => hit.provider === adapter.key);
    const statuses = new Set(rows.map((row) => row.status));
    const status = statuses.has("OK")
      ? statuses.has("FAILED") || statuses.has("PARTIAL")
        ? "PARTIAL"
        : "OK"
      : statuses.has("PARTIAL")
        ? "PARTIAL"
        : statuses.has("FAILED")
          ? "FAILED"
          : statuses.has("NOT_CONFIGURED")
            ? "NOT_CONFIGURED"
            : "SKIPPED";
    coverageMap.set(adapter.key, {
      adapter: adapter.key,
      label: adapter.label,
      status,
      queries: rows.filter((row) => ["OK", "FAILED", "PARTIAL"].includes(row.status)).length,
      results: rows.reduce((sum, row) => sum + row.resultCount, 0),
      note:
        status === "NOT_CONFIGURED"
          ? rows.find((row) => row.error)?.error
          : rows.find((row) => row.status === "FAILED")?.error,
    });
  }

  const flat = hits.flatMap((hit) => hit.candidates);
  return {
    hits,
    candidates: flat,
    coverage: [...coverageMap.values()],
    searchRequests,
    notes: [...new Set(notes)],
  };
}
