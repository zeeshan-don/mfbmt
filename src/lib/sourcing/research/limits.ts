import { env } from "../../env";
import { getSettingJson } from "../../settings";
import type { ResearchLimits } from "../../validation/research";

const SETTINGS_KEY = "sourcing.deepResearch.limits";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxRounds: 3,
  maxQueries: 20,
  maxUrls: 20,
  maxPagesPerDomain: 5,
  maxConcurrentPages: 3,
  maxFollowUpAiPasses: 1,
  maxAiCalls: 12,
  budgetAed: null,
  maxPageBytes: 750_000,
  requestTimeoutMs: 12_000,
};

/**
 * Deep research is a paid capability. Every bound is configurable, but the
 * engine clamps it to a safe range so a bad environment value cannot create an
 * unbounded crawl or an unbounded AI spend.
 */
export async function getResearchLimits(overrides: Partial<ResearchLimits> = {}): Promise<ResearchLimits> {
  const stored = await getSettingJson<Partial<ResearchLimits>>(SETTINGS_KEY, {}).catch(() => ({}));
  // Explicit undefined must not erase a stored limit. Callers typically pass a
  // full options object with only the fields the owner overrode.
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<ResearchLimits>;
  const merged = { ...DEFAULT_RESEARCH_LIMITS, ...stored, ...definedOverrides };
  const envBudget = env.DEEP_RESEARCH_BUDGET_AED > 0 ? env.DEEP_RESEARCH_BUDGET_AED : null;
  return {
    maxRounds: clampInt(merged.maxRounds, env.DEEP_RESEARCH_MAX_ROUNDS, 1, 10),
    maxQueries: clampInt(merged.maxQueries, env.DEEP_RESEARCH_MAX_QUERIES, 1, 100),
    maxUrls: clampInt(merged.maxUrls, env.DEEP_RESEARCH_MAX_URLS, 1, 100),
    maxPagesPerDomain: clampInt(merged.maxPagesPerDomain, env.DEEP_RESEARCH_MAX_PAGES_PER_DOMAIN, 1, 30),
    maxConcurrentPages: clampInt(merged.maxConcurrentPages, env.DEEP_RESEARCH_MAX_CONCURRENT_PAGES, 1, 10),
    maxFollowUpAiPasses: clampInt(
      merged.maxFollowUpAiPasses,
      env.DEEP_RESEARCH_MAX_FOLLOWUP_AI_PASSES,
      0,
      5,
    ),
    maxAiCalls: clampInt(merged.maxAiCalls, env.DEEP_RESEARCH_MAX_AI_CALLS, 0, 50),
    budgetAed: (() => {
      if (merged.budgetAed == null) return envBudget;
      const parsed = Number(merged.budgetAed);
      return Number.isFinite(parsed) ? Math.min(100_000, Math.max(0, parsed)) : envBudget;
    })(),
    maxPageBytes: clampInt(merged.maxPageBytes, env.DEEP_RESEARCH_MAX_PAGE_BYTES, 10_000, 2_000_000),
    requestTimeoutMs: clampInt(
      merged.requestTimeoutMs,
      env.DEEP_RESEARCH_REQUEST_TIMEOUT_MS,
      1_000,
      60_000,
    ),
  };
}

export async function saveResearchLimits(input: Partial<ResearchLimits>): Promise<ResearchLimits> {
  const current = await getResearchLimits();
  const next = await getResearchLimits({ ...current, ...input });
  const { setSettingJson } = await import("../../settings");
  await setSettingJson(SETTINGS_KEY, next);
  return next;
}
