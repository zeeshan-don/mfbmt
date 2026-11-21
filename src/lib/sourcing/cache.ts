import { db } from "../db";
import { sha256 } from "../crypto";
import { parseJson, stringifyJson } from "../json";
import type { SourcingCandidate } from "./types";

/** Stable, non-secret cache key for one adapter + normalized query set. */
export function searchCacheKey(adapter: string, queries: string[], context: Record<string, unknown>): string {
  return sha256(JSON.stringify({ adapter, queries: [...queries].sort(), context }));
}

export async function readSearchCache(cacheKey: string): Promise<SourcingCandidate[] | null> {
  const row = await db.searchCache.findUnique({
    where: { organizationId_cacheKey: { organizationId: (await import("../tenant")).getTenantId() ?? "", cacheKey } },
  }).catch(() => null);
  if (!row || row.expiresAt <= new Date()) return null;
  const parsed = parseJson<Array<Record<string, unknown>>>(row.payloadJson, []);
  return parsed.map((candidate) => ({
    ...(candidate as unknown as SourcingCandidate),
    retrievedAt: candidate.retrievedAt ? new Date(String(candidate.retrievedAt)) : new Date(),
  }));
}

export async function writeSearchCache(
  cacheKey: string,
  candidates: SourcingCandidate[],
  ttlDays: number,
  sourceUrl?: string,
): Promise<void> {
  const organizationId = (await import("../tenant")).getTenantId();
  if (!organizationId) return;
  try {
    await db.searchCache.upsert({
      where: { organizationId_cacheKey: { organizationId, cacheKey } },
      update: {
        payloadJson: stringifyJson(candidates),
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
        sourceUrl: sourceUrl ?? null,
      },
      create: {
        organizationId,
        cacheKey,
        kind: "SEARCH",
        payloadJson: stringifyJson(candidates),
        sourceUrl: sourceUrl ?? null,
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      },
    });
  } catch (error) {
    // Cache is an optimisation; a write failure must not fail sourcing.
    console.error("[search-cache] write failed", error instanceof Error ? error.message : "unknown");
  }
}
