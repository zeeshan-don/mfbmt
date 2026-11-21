import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { rawDb } from "../src/lib/db-base";
import { runWithTenant } from "../src/lib/tenant";
import { recordAiUsage } from "../src/lib/ai/usage";
import { getOrgLimits, saveOrgLimits, aiBudgetStatus, enquiryAllowanceStatus, monthBounds } from "../src/lib/limits";
import { getMonthlyUsage } from "../src/lib/usage";
import { readSearchCache, searchCacheKey, writeSearchCache } from "../src/lib/sourcing/cache";
import type { SourcingCandidate } from "../src/lib/sourcing/types";

const MFBMT = "org_mfbmt";
const OGS = "org_ogs";
const marker = randomUUID().slice(0, 8);

beforeAll(async () => {
  await runWithTenant({ organizationId: MFBMT, source: "test" }, () => recordAiUsage({
    jobType: `test-extraction-${marker}`,
    provider: "test",
    model: "test-model",
    inputTokens: 1_000,
    outputTokens: 500,
  }));
});

afterAll(async () => {
  for (const organizationId of [MFBMT, OGS]) {
    await rawDb.aiUsage.deleteMany({ where: { organizationId } });
    await rawDb.searchCache.deleteMany({ where: { organizationId } });
  }
  await db.$disconnect();
});

describe("AI usage and limits", () => {
  it("records provider tokens and prices them deterministically", async () => {
    const usage = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.aiUsage.findFirst({ where: { jobType: `test-extraction-${marker}` } }),
    );
    expect(usage?.inputTokens).toBe(1_000);
    expect(usage?.outputTokens).toBe(500);
    expect(usage?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("saves per-organization limits and keeps the tenant scope", async () => {
    const saved = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      saveOrgLimits({ maxItemsPerEnquiry: 7, maxSearchQueriesPerItem: 3, webSearchEnabled: true, monthlyAiBudgetAed: 321 }),
    );
    const read = await runWithTenant({ organizationId: MFBMT, source: "test" }, () => getOrgLimits());
    expect(saved.maxItemsPerEnquiry).toBe(7);
    expect(read.monthlyAiBudgetAed).not.toBe(321);
  });

  it("reports budget and allowance without inventing a rate", async () => {
    const [budget, allowance] = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      Promise.all([aiBudgetStatus(), enquiryAllowanceStatus()]),
    );
    expect(budget.budgetAed).toBeGreaterThan(0);
    expect(["NONE", "80", "100"]).toContain(budget.warning);
    expect(allowance.used).toBeGreaterThanOrEqual(0);
  });

  it("reports this month's deterministic usage", async () => {
    const usage = await runWithTenant({ organizationId: MFBMT, source: "test" }, () => getMonthlyUsage(monthBounds().label));
    expect(usage.aiInputTokens).toBeGreaterThanOrEqual(1_000);
    expect(usage.aiCalls).toBeGreaterThanOrEqual(1);
    expect(usage.aiCostAed == null || usage.aiCostAed >= 0).toBe(true);
  });
});

describe("search cache", () => {
  it("round trips candidates and isolates organizations", async () => {
    const queries = ["A106 Grade B pipe 6 inch", "seamless pipe 6 inch"];
    const key = searchCacheKey("PUBLIC_WEB", queries, { category: "Pipes" });
    const candidate: SourcingCandidate = {
      adapter: "PUBLIC_WEB",
      supplierName: "Synthetic test supplier",
      title: "Synthetic listing",
      retrievedAt: new Date("2026-01-01T00:00:00Z"),
      isDemo: true,
    };
    await runWithTenant({ organizationId: MFBMT, source: "test" }, () => writeSearchCache(key, [candidate], 7));
    const hit = await runWithTenant({ organizationId: MFBMT, source: "test" }, () => readSearchCache(key));
    const miss = await runWithTenant({ organizationId: OGS, source: "test" }, () => readSearchCache(key));
    expect(hit).toHaveLength(1);
    expect(hit?.[0].supplierName).toBe("Synthetic test supplier");
    expect(miss).toBeNull();
  });
});
