import { env } from "../../env";
import type { AdapterContext, AdapterResult, QueryRun, SearchAdapter, SourcingCandidate } from "../types";
import { extractMoq, extractPriceFromText, extractSpecsFromText, extractLeadTimeDays } from "../extract";

type SearchHit = { title: string; url: string; snippet: string };

async function tavily(query: string): Promise<SearchHit[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      max_results: env.SEARCH_MAX_RESULTS,
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(env.SEARCH_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
  const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (payload.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? "Product listing", url: r.url as string, snippet: r.content ?? "" }));
}

async function serper(query: string): Promise<SearchHit[]> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, num: env.SEARCH_MAX_RESULTS }),
    signal: AbortSignal.timeout(env.SEARCH_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
  const payload = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (payload.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({ title: r.title ?? "Product listing", url: r.link as string, snippet: r.snippet ?? "" }));
}

async function brave(query: string): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(env.SEARCH_MAX_RESULTS));
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY },
    signal: AbortSignal.timeout(env.SEARCH_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (payload.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? "Product listing", url: r.url as string, snippet: r.description ?? "" }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown supplier";
  }
}

function providerCall(): ((query: string) => Promise<SearchHit[]>) | null {
  switch (env.WEB_SEARCH_PROVIDER) {
    case "tavily":
      return env.TAVILY_API_KEY ? tavily : null;
    case "serper":
      return env.SERPER_API_KEY ? serper : null;
    case "brave":
      return env.BRAVE_SEARCH_API_KEY ? brave : null;
    default:
      return null;
  }
}

/**
 * Public web search. The adapter only reports what a listing advertises.
 * A listing without a visible price is recorded as a potential source, never
 * as a confirmed cheap offer.
 */
export const webSearchAdapter: SearchAdapter = {
  key: "PUBLIC_WEB",
  label: "Public web search",
  available: () => providerCall() !== null,
  unavailableReason: () =>
    env.WEB_SEARCH_PROVIDER === "none"
      ? "No web search provider is connected. Add one in Settings to search public supplier catalogues."
      : `The ${env.WEB_SEARCH_PROVIDER} API key is missing.`,
  async search(queries: string[], context: AdapterContext): Promise<AdapterResult> {
    const call = providerCall();
    if (!call) {
      return {
        adapter: webSearchAdapter.key,
        label: webSearchAdapter.label,
        status: "NOT_CONFIGURED",
        note: webSearchAdapter.unavailableReason?.(),
        queries: queries.map((q) => ({ query: q, status: "NOT_CONFIGURED" as const, resultCount: 0 })),
        candidates: [],
      };
    }

    const candidates: SourcingCandidate[] = [];
    const runs: QueryRun[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      try {
        const hits = await call(query);
        runs.push({ query, status: "OK", resultCount: hits.length });
        for (const hit of hits) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          const text = `${hit.title} ${hit.snippet}`;
          const price = extractPriceFromText(text);
          const specs = extractSpecsFromText(text);
          candidates.push({
            adapter: webSearchAdapter.key,
            sourceUrl: hit.url,
            supplierName: hostOf(hit.url),
            title: hit.title,
            snippet: hit.snippet,
            priceText: price.priceText,
            unitPrice: price.unitPrice,
            currency: price.currency,
            moq: extractMoq(text),
            availability: specs.availability ?? null,
            leadTimeDays: extractLeadTimeDays(text),
            evidence: { specifications: specs, provider: env.WEB_SEARCH_PROVIDER, query },
            retrievedAt: new Date(),
          });
        }
      } catch (error) {
        runs.push({
          query,
          status: "FAILED",
          resultCount: 0,
          error: error instanceof Error ? error.message.slice(0, 160) : "Search failed",
        });
      }
    }

    void context;
    const failures = runs.filter((run) => run.status === "FAILED").length;
    return {
      adapter: webSearchAdapter.key,
      label: webSearchAdapter.label,
      status: failures === runs.length && runs.length > 0 ? "FAILED" : "OK",
      queries: runs,
      candidates,
      note: failures > 0 ? `${failures} of ${runs.length} searches failed.` : undefined,
    };
  },
};
