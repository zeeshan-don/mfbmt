import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import { runDeepResearchForItem } from "../src/lib/sourcing/research/engine";
import { researchCandidateKey } from "../src/lib/sourcing/research/engine";

const RUN = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

async function makeOrganization(label: string) {
  const id = `org_deep_${RUN}_${label}`;
  await rawDb.organization.create({
    data: {
      id,
      slug: `deep-${RUN}-${label}`,
      name: `Deep Research Test ${label}`,
      country: "AE",
      timezone: "Asia/Dubai",
      defaultCurrency: "AED",
      procurementProfile: "GENERAL",
      status: "ACTIVE",
    },
  });
  organizationIds.push(id);
  return id;
}

async function makeItem(org: string, description = "Elbow 6 inch Carbon Steel WPB Class 150 SCH 40 ASTM A234") {
  const enquiry = await rawDb.enquiry.create({
    data: {
      organizationId: org,
      publicRef: `ENQ-DEEP-${RUN}-${Math.random().toString(36).slice(2, 7)}`,
      channel: "MANUAL",
      rawText: description,
      customerName: "Test Customer",
      deliveryLocation: "Dubai, UAE",
      requestedDeliveryTimeframe: "3 days",
      status: "SOURCING",
    },
  });
  const item = await rawDb.enquiryItem.create({
    data: {
      organizationId: org,
      enquiryId: enquiry.id,
      description,
      category: "Pipe Fittings",
      size: "6 inch",
      material: "Carbon Steel",
      grade: "WPB",
      pressureRating: "Class 150",
      schedule: "SCH 40",
      standard: "ASTM A234",
      unit: "pcs",
      quantity: 20,
      quantityToSource: 20,
      missingFields: "[]",
    },
  });
  return { enquiry, item };
}

afterAll(async () => {
  await rawDb.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await rawDb.$disconnect();
});

describe("deep research workflow persistence", () => {
  it("persists the run, executed queries, internal evidence and an exact candidate", async () => {
    const org = await makeOrganization("internal");
    const { item } = await makeItem(org);
    await rawDb.supplier.create({
      data: {
        organizationId: org,
        name: "Gulf Fittings LLC",
        status: "ACTIVE",
        country: "AE",
        email: "sales@gulf-fittings.example",
      },
    });
    const supplier = await rawDb.supplier.findFirst({ where: { organizationId: org } });
    await rawDb.supplierProduct.create({
      data: {
        organizationId: org,
        supplierId: supplier!.id,
        title: "Long radius elbow 6 inch Carbon Steel WPB",
        description: "Butt weld elbow ASTM A234",
        specs: JSON.stringify({
          material: "Carbon Steel",
          grade: "WPB",
          size: "6 inch",
          pressureRating: "Class 150",
          schedule: "SCH 40",
          standard: "ASTM A234",
        }),
        unitPrice: 42,
        currency: "AED",
      },
    });

    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 6, maxRounds: 2, maxUrls: 2 }),
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.runId).toBeTruthy();
    expect(result.candidates).toBe(1);
    expect(result.exact).toBe(1);
    expect(result.suppliersWithEvidence).toBe(1);
    expect(result.queries).toBeGreaterThan(0);
    expect(result.evidence).toBeGreaterThan(0);

    const run = await rawDb.researchRun.findUnique({
      where: { id: result.runId! },
      include: { candidates: true, queries: true, sources: true, evidence: true },
    });
    expect(run?.organizationId).toBe(org);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.activeKey).toBeNull();
    expect(run?.planJson).toMatch(/Long radius elbow|Elbow/i);
    expect(run?.candidates).toHaveLength(1);
    expect(run?.candidates[0].matchStatus).toBe("EXACT");
    expect(run?.queries.length).toBeGreaterThan(0);
    expect(run?.sources.length).toBeGreaterThan(0);
    expect(run?.evidence.some((entry) => entry.sourceType === "INTERNAL")).toBe(true);
    expect(run?.coverageJson).toMatch(/INTERNAL_SUPPLIERS/);
    expect(run?.coverageJson).toMatch(/B2B_MARKETPLACE/);
    expect(run?.coverageJson).toMatch(/NOT_CONFIGURED/);
  });

  it("does not start a second active run for the same product", async () => {
    const org = await makeOrganization("duplicate");
    const { item } = await makeItem(org);
    const active = await rawDb.researchRun.create({
      data: {
        organizationId: org,
        enquiryId: item.enquiryId,
        enquiryItemId: item.id,
        activeKey: `deep:${org}:${item.id}`,
        status: "SEARCHING",
        stage: "SEARCHING",
        planJson: "{}",
        limitsJson: "{}",
      },
    });

    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 1, maxRounds: 1 }),
    );
    expect(result.alreadyRunning).toBe(true);
    expect(result.runId).toBe(active.id);
    expect(await rawDb.researchRun.count({ where: { organizationId: org } })).toBe(1);
  });

  it("keeps research runs tenant-scoped in reads and writes", async () => {
    const first = await makeOrganization("tenant-a");
    const second = await makeOrganization("tenant-b");
    const { item } = await makeItem(first);
    await runWithTenant({ organizationId: first, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 2, maxRounds: 1 }),
    );

    const firstVisible = await runWithTenant({ organizationId: first, source: "test" }, () =>
      db.researchRun.findMany(),
    );
    const secondVisible = await runWithTenant({ organizationId: second, source: "test" }, () =>
      db.researchRun.findMany(),
    );
    expect(firstVisible.length).toBe(1);
    expect(secondVisible).toHaveLength(0);
    expect(firstVisible[0].organizationId).toBe(first);
  });

  it("returns SKIPPED for a service line or an item covered by stock", async () => {
    const org = await makeOrganization("skip");
    const { item } = await makeItem(org, "Hydrotest service for pipe spools");
    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id),
    );
    expect(result.status).toBe("SKIPPED");
    expect(result.runId).toBeNull();
  });

  it("keeps suppliers on different domains separate and deduplicates the same domain", () => {
    expect(
      researchCandidateKey({
        adapter: "PUBLIC_WEB",
        supplierName: "Example",
        title: "Elbow",
        sourceUrl: "https://www.example.com/a",
        retrievedAt: new Date(),
      }),
    ).toBe(
      researchCandidateKey({
        adapter: "PUBLIC_WEB",
        supplierName: "Example",
        title: "Elbow 2",
        sourceUrl: "https://example.com/b",
        retrievedAt: new Date(),
      }),
    );
    expect(
      researchCandidateKey({
        adapter: "PUBLIC_WEB",
        supplierName: "Example",
        title: "Elbow",
        sourceUrl: "https://example.com/a",
        retrievedAt: new Date(),
      }),
    ).not.toBe(
      researchCandidateKey({
        adapter: "PUBLIC_WEB",
        supplierName: "Example",
        title: "Elbow",
        sourceUrl: "https://other.example/a",
        retrievedAt: new Date(),
      }),
    );
  });
});
