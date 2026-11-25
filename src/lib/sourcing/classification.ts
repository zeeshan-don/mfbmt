import type { SourcingCandidate } from "./types";

/**
 * Explainable match reporting for the sourcing dashboard.
 *
 * The database keeps the existing deterministic match statuses
 * (EXACT | EQUIVALENT | POSSIBLE | INSUFFICIENT | NO_MATCH). This module maps
 * them to business-readable buckets without changing stored values:
 *
 *   EXACT       every required attribute matched
 *   COMPATIBLE  plausible technical match with no known critical conflict
 *               (including an owner-approved substitution)
 *   POSSIBLE    the supplier looks relevant but required specifications are unknown
 *   NONE        a known incompatible specification
 *   UNVERIFIED  there was not enough evidence to judge
 */
export type MatchBucket = "EXACT" | "COMPATIBLE" | "POSSIBLE" | "NONE" | "UNVERIFIED";

export const MATCH_BUCKET_LABELS: Record<MatchBucket, string> = {
  EXACT: "Exact product match",
  COMPATIBLE: "Compatible match",
  POSSIBLE: "Possible match",
  NONE: "No match",
  UNVERIFIED: "Unverified",
};

export function matchBucket(status: string | null | undefined): MatchBucket {
  switch ((status ?? "").toUpperCase()) {
    case "EXACT":
      return "EXACT";
    case "EQUIVALENT":
    case "POSSIBLE":
      return "COMPATIBLE";
    case "INSUFFICIENT":
      return "POSSIBLE";
    case "NO_MATCH":
      return "NONE";
    default:
      return "UNVERIFIED";
  }
}

export type MatchSummary = {
  exact: number;
  compatible: number;
  possible: number;
  none: number;
  unverified: number;
};

export function summarizeMatches(statuses: Array<string | null | undefined>): MatchSummary {
  const summary: MatchSummary = { exact: 0, compatible: 0, possible: 0, none: 0, unverified: 0 };
  for (const status of statuses) {
    const bucket = matchBucket(status);
    if (bucket === "EXACT") summary.exact += 1;
    else if (bucket === "COMPATIBLE") summary.compatible += 1;
    else if (bucket === "POSSIBLE") summary.possible += 1;
    else if (bucket === "NONE") summary.none += 1;
    else summary.unverified += 1;
  }
  return summary;
}

/** A stable supplier identity: recorded supplier id, website domain, or name. */
export function supplierIdentity(candidate: Pick<SourcingCandidate, "supplierId" | "supplierName" | "sourceUrl">): string {
  if (candidate.supplierId) return `supplier:${candidate.supplierId}`;
  if (candidate.sourceUrl) {
    try {
      return `domain:${new URL(candidate.sourceUrl).hostname.replace(/^www\./i, "").toLowerCase()}`;
    } catch {
      // Fall through to the normalized name.
    }
  }
  return `name:${candidate.supplierName.trim().toLowerCase()}`;
}

/** Source URL without query/fragment noise, so mirrors and trackers collapse. */
export function normalizedSourceUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./i, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}
