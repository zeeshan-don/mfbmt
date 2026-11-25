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
  if (!response.ok) {
    const err = new Error(`Tavily HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
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
  if (!response.ok) {
    const err = new Error(`Serper HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
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
  if (!response.ok) {
    const err = new Error(`Brave HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
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

/**
 * Whether an error from a search provider warrants falling back to the next
 * provider. Quota/auth/rate-limit errors mean the provider can't serve us;
 * transient network errors also fall back since retrying the same provider
 * won't help mid-request.
 */
function isFallbackError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status != null) {
    // Auth, quota, rate limit, forbidden — provider can't serve us
    if ([401, 402, 403, 429].includes(status)) return true;
    // Server errors — provider is likely down
    if (status >= 500) return true;
  }
  // Network/timeout errors (no status) — fall back
  if (status == null) return true;
  return false;
}

type Provider = { name: string; search: (query: string) => Promise<SearchHit[]> };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry for transient provider failures. Auth/quota/rate-limit errors
 * are not retried here; they fall through to the next provider instead.
 */
async function searchWithRetry(provider: Provider, query: string): Promise<SearchHit[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await provider.search(query);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number })?.status;
      const transient = status == null || status >= 500;
      if (!transient || attempt > 0) throw error;
      await delay(150);
    }
  }
  throw lastError;
}

/**
 * Build the provider chain in priority order: Tavily → Serper → Brave.
 * Only providers with configured API keys are included.
 * If WEB_SEARCH_PROVIDER is explicitly set to a single provider, only that
 * provider is used (no fallback) — unless backup keys are also configured,
 * in which case the full chain is used with the explicit provider first.
 */
function getProviderChain(): Provider[] {
  const explicit = env.WEB_SEARCH_PROVIDER.toLowerCase();

  // "none" is a real off switch. API keys may still be present in the
  // environment (for example a shared staging secret); they must not cause a
  // search when the organization/provider setting is disabled.
  if (explicit === "none") return [];

  // If explicitly set to a single provider with no backup keys, use only that
  if (explicit === "tavily" && env.TAVILY_API_KEY && !env.SERPER_API_KEY && !env.BRAVE_SEARCH_API_KEY) {
    return [{ name: "tavily", search: tavily }];
  }
  if (explicit === "serper" && env.SERPER_API_KEY && !env.TAVILY_API_KEY && !env.BRAVE_SEARCH_API_KEY) {
    return [{ name: "serper", search: serper }];
  }
  if (explicit === "brave" && env.BRAVE_SEARCH_API_KEY && !env.TAVILY_API_KEY && !env.SERPER_API_KEY) {
    return [{ name: "brave", search: brave }];
  }

  // Default: build full chain from available keys (Tavily → Serper → Brave)
  const chain: Provider[] = [];
  if (env.TAVILY_API_KEY) chain.push({ name: "tavily", search: tavily });
  if (env.SERPER_API_KEY) chain.push({ name: "serper", search: serper });
  if (env.BRAVE_SEARCH_API_KEY) chain.push({ name: "brave", search: brave });

  // If explicit provider is set, move it to front of chain
  if (explicit !== "none" && explicit !== "auto") {
    const idx = chain.findIndex((p) => p.name === explicit);
    if (idx > 0) {
      const [provider] = chain.splice(idx, 1);
      chain.unshift(provider);
    }
  }

  return chain;
}

export const webSearchAdapter: SearchAdapter = {
  key: "PUBLIC_WEB",
  label: "Public web search",
  available: () => getProviderChain().length > 0,
  unavailableReason: () => {
    const chain = getProviderChain();
    if (chain.length === 0) {
      if (env.WEB_SEARCH_PROVIDER === "none") {
        return "Public web search is turned off (WEB_SEARCH_PROVIDER=none). Set it to auto or a provider to enable it.";
      }
      return `The ${env.WEB_SEARCH_PROVIDER} API key is missing. Add it or set WEB_SEARCH_PROVIDER=none to disable.`;
    }
    return "";
  },
  async search(queries: string[], context: AdapterContext): Promise<AdapterResult> {
    void context;
    const chain = getProviderChain();
    if (chain.length === 0) {
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
    const seenUrls = new Set<string>();
    const triedProviders: string[] = [];
    const usedProviders: string[] = [];
    const fallbackNotes: string[] = [];
    let successfulQueries = 0;
    let failedQueries = 0;

    for (const provider of chain) {
      triedProviders.push(provider.name);
      const providerRuns: QueryRun[] = [];
      const providerCandidates: SourcingCandidate[] = [];
      const providerSeen = new Set<string>();

      for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        try {
          const hits = await searchWithRetry(provider, query);
          successfulQueries += 1;
          providerRuns.push({ query, status: "OK", resultCount: hits.length });
          for (const hit of hits) {
            if (providerSeen.has(hit.url)) continue;
            providerSeen.add(hit.url);
            const text = `${hit.title} ${hit.snippet}`;
            const price = extractPriceFromText(text);
            const specs = extractSpecsFromText(text);
            providerCandidates.push({
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
              evidence: { specifications: specs, provider: provider.name, query },
              retrievedAt: new Date(),
            });
          }
        } catch (error) {
          failedQueries += 1;
          const status = (error as { status?: number })?.status;
          providerRuns.push({
            query,
            status: "FAILED",
            resultCount: 0,
            error: error instanceof Error ? error.message.slice(0, 160) : "Search failed",
          });
          if (isFallbackError(error)) {
            fallbackNotes.push(
              `${provider.name} failed (${status ?? "network/timeout"}); next configured source was tried.`,
            );
            // Every query still has an explicit status. The unattempted ones
            // are recorded as skipped rather than silently missing.
            for (const remaining of queries.slice(index + 1)) {
              providerRuns.push({
                query: remaining,
                status: "SKIPPED",
                resultCount: 0,
                error: "Provider unavailable; next source used.",
              });
            }
            break;
          }
        }
      }

      runs.push(...providerRuns);

      if (providerCandidates.length > 0) {
        // Keep what this provider actually returned, even if it failed part-way.
        for (const candidate of providerCandidates) {
          if (candidate.sourceUrl && seenUrls.has(candidate.sourceUrl)) continue;
          if (candidate.sourceUrl) seenUrls.add(candidate.sourceUrl);
          candidates.push(candidate);
        }
        usedProviders.push(provider.name);
        break;
      }
      // A successful response with zero usable results must not stop the
      // fallback chain: another provider may have different coverage.
      if (chain.indexOf(provider) < chain.length - 1) {
        fallbackNotes.push(`${provider.name} returned no usable results; next configured source was tried.`);
      }
    }

    const status =
      successfulQueries > 0 && failedQueries > 0
        ? "PARTIAL"
        : successfulQueries > 0
          ? "OK"
          : failedQueries > 0
            ? "FAILED"
            : "SKIPPED";

    const note =
      candidates.length === 0 && successfulQueries > 0
        ? `Searches ran on ${[...new Set(triedProviders)].join(", ")} but returned no usable supplier results. ${fallbackNotes.join(" ")}`.trim()
        : fallbackNotes.length > 0
          ? fallbackNotes.join(" ")
          : undefined;

    return {
      adapter: webSearchAdapter.key,
      label: webSearchAdapter.label,
      status,
      queries: runs,
      candidates,
      note,
    };
  },
};
