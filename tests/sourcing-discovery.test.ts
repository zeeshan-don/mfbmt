import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { runWithTenant } from "../src/lib/tenant";
import { internalSupplierAdapter } from "../src/lib/sourcing/adapters/internal";
import { buildSearchQueries } from "../src/lib/sourcing/queries";
import {
  matchBucket,
  normalizedSourceUrl,
  summarizeMatches,
  supplierIdentity,
} from "../src/lib/sourcing/classification";
import { matchProduct } from "../src/lib/inventory/matching";
import { runSourcingForItem } from "../src/lib/sourcing/engine";
import { parseJson } from "../src/lib/json";

const RUN = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

async function makeOrganization(label: string) {
  const id = `org_sourcing_${RUN}_${label}`;
  await rawDb.organization.create({
    data: {
      id,
      slug: `sourcing-${RUN}-${label}`,
      name: `Sourcing Test ${label}`,
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

const context = {
  request: {
    description: "Elbow 1 inch SS316",
    quantity: 5,
    unit: "pcs",
    category: "Stainless Steel Fittings",
    material: "SS316",
    size: "1 inch",
  },
  fetchPages: false,
};

afterAll(async () => {
  await rawDb.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await rawDb.$disconnect();
});

describe("product-aware search queries", () => {
  it("keeps the critical technical attributes and adds focused variants", () => {
    const queries = buildSearchQueries(
      {
        description: "Long radius elbow",
        size: "0.5in",
        material: "Carbon Steel",
        grade: "WPB",
        schedule: "SCH 40",
        pressureRating: "Class 150",
        standard: "ASTM A234",
        location: "UAE",
      },
      5,
    );
    expect(queries[0]).toMatch(/long radius elbow/i);
    for (const required of ["0.5in", "Carbon Steel", "WPB", "SCH 40", "Class 150", "ASTM A234"]) {
      expect(queries[0]).toContain(required);
    }
    expect(queries.every((query) => query.trim().toLowerCase() !== "elbow")).toBe(true);
    expect(queries.some((query) => /long radius elbow/i.test(query) && /UAE/i.test(query))).toBe(true);
  });

  it("respects the per-organization query cap", () => {
    const queries = buildSearchQueries(
      { description: "Gate valve", size: "2 inch", material: "SS316", standard: "API 600" },
      2,
    );
    expect(queries).toHaveLength(2);
  });
});

describe("explainable match classification", () => {
  it("maps stored statuses to business buckets without changing them", () => {
    expect(matchBucket("EXACT")).toBe("EXACT");
    expect(matchBucket("EQUIVALENT")).toBe("COMPATIBLE");
    expect(matchBucket("POSSIBLE")).toBe("COMPATIBLE");
    expect(matchBucket("INSUFFICIENT")).toBe("POSSIBLE");
    expect(matchBucket("NO_MATCH")).toBe("NONE");
    expect(matchBucket(null)).toBe("UNVERIFIED");
  });

  it("counts exact, compatible, possible and incompatible results separately", () => {
    const summary = summarizeMatches(["EXACT", "EQUIVALENT", "POSSIBLE", "INSUFFICIENT", "NO_MATCH", null]);
    expect(summary).toEqual({ exact: 1, compatible: 2, possible: 1, none: 1, unverified: 1 });
  });

  it("never promotes a product with an incompatible material to an exact match", () => {
    const result = matchProduct(
      { description: "Elbow 1 inch SS316", material: "SS316", size: "1 inch", category: "Stainless Steel Fittings" },
      { description: "Elbow 1 inch SS304", material: "SS304", size: "1 inch" },
    );
    expect(result.status).toBe("NO_MATCH");
    expect(matchBucket(result.status)).toBe("NONE");
    expect(result.mismatches.join(" ")).toMatch(/material/i);
  });

  it("never calls a name-only listing an exact product match", () => {
    const result = matchProduct(
      { description: "Gate valve", category: "Valves" },
      { description: "Gate valve", category: "Valves" },
    );
    expect(result.status).toBe("INSUFFICIENT");
    expect(matchBucket(result.status)).toBe("POSSIBLE");
    expect(result.missing.join(" ")).toMatch(/specification|size|material|pressure/i);
  });

  it("keeps a plausible result with missing specifications separate from an exact match", () => {
    const result = matchProduct(
      {
        description: "Gate valve 2 inch SS316 Class 150",
        material: "SS316",
        size: "2 inch",
        pressureRating: "Class 150",
        category: "Valves",
      },
      { description: "Gate valve 2 inch SS316", material: "SS316", size: "2 inch" },
    );
    expect(result.status).toBe("INSUFFICIENT");
    expect(matchBucket(result.status)).toBe("POSSIBLE");
    expect(result.missing.join(" ")).toMatch(/pressure/i);
  });

  it("consolidates www and bare domains for supplier counting", () => {
    const a = supplierIdentity({ supplierName: "Example", sourceUrl: "https://www.example.com/a?utm=1" });
    const b = supplierIdentity({ supplierName: "Example", sourceUrl: "https://example.com/b" });
    expect(a).toBe(b);
    expect(normalizedSourceUrl("https://www.example.com/a/?utm=1")).toBe("https://example.com/a");
  });
});

describe("internal supplier directory", () => {
  it("finds recorded supplier products case-insensitively", async () => {
    const org = await makeOrganization("internal");
    await runWithTenant({ organizationId: org, source: "test" }, async () => {
      const supplier = await rawDb.supplier.create({
        data: {
          organizationId: org,
          name: "Gulf Fittings LLC",
          status: "ACTIVE",
          country: "AE",
        },
      });
      await rawDb.supplierProduct.create({
        data: {
          organizationId: org,
          supplierId: supplier.id,
          title: "Long Radius Elbow 1 inch SS316",
          description: "Butt weld elbow",
          specs: JSON.stringify({ material: "SS316", size: "1 inch" }),
          unitPrice: 12.5,
          currency: "AED",
        },
      });
    });

    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      internalSupplierAdapter.search(["long radius elbow ss316"], context),
    );
    expect(result.status).toBe("OK");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].supplierName).toBe("Gulf Fittings LLC");
    expect(result.note).toMatch(/matched the search words/i);
  });

  it("reports an accurate empty state when nothing is recorded", async () => {
    const org = await makeOrganization("empty");
    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      internalSupplierAdapter.search(["long radius elbow ss316"], context),
    );
    expect(result.status).toBe("OK");
    expect(result.candidates).toHaveLength(0);
    expect(result.note).toMatch(/no supplier products are recorded/i);
  });

  it("never reads another tenant's supplier directory", async () => {
    const first = await makeOrganization("tenant-a");
    const second = await makeOrganization("tenant-b");
    await runWithTenant({ organizationId: first, source: "test" }, async () => {
      const supplier = await rawDb.supplier.create({
        data: { organizationId: first, name: "Private Supplier", status: "ACTIVE" },
      });
      await rawDb.supplierProduct.create({
        data: {
          organizationId: first,
          supplierId: supplier.id,
          title: "Long Radius Elbow 1 inch SS316",
          specs: JSON.stringify({ material: "SS316", size: "1 inch" }),
        },
      });
    });

    const foreign = await runWithTenant({ organizationId: second, source: "test" }, () =>
      internalSupplierAdapter.search(["long radius elbow ss316"], context),
    );
    expect(foreign.candidates).toHaveLength(0);
    expect(foreign.note).toMatch(/no supplier products are recorded/i);
  });
});

describe("sourcing run reporting", () => {
  it("counts suppliers with evidence and records exact matches truthfully", async () => {
    const org = await makeOrganization("run");
    const result = await runWithTenant({ organizationId: org, source: "test" }, async () => {
      const supplier = await rawDb.supplier.create({
        data: { organizationId: org, name: "Recorded Supplier", status: "ACTIVE" },
      });
      await rawDb.supplierProduct.create({
        data: {
          organizationId: org,
          supplierId: supplier.id,
          title: "Elbow 1 inch SS316",
          specs: JSON.stringify({ material: "SS316", size: "1 inch" }),
          unitPrice: 10,
          currency: "AED",
        },
      });
      const enquiry = await rawDb.enquiry.create({
        data: {
          organizationId: org,
          publicRef: `ENQ-SRC-${RUN}`,
          channel: "MANUAL",
          rawText: "Elbow 1 inch SS316",
          status: "SOURCING",
        },
      });
      const item = await rawDb.enquiryItem.create({
        data: {
          organizationId: org,
          enquiryId: enquiry.id,
          description: "Elbow 1 inch SS316",
          category: "Stainless Steel Fittings",
          material: "SS316",
          size: "1 inch",
          unit: "pcs",
          quantity: 5,
          quantityToSource: 5,
          missingFields: "[]",
        },
      });
      const run = await runSourcingForItem(item.id);
      const session = await rawDb.searchSession.findFirst({
        where: { enquiryItemId: item.id },
        orderBy: { startedAt: "desc" },
      });
      return { run, session };
    });

    expect(result.run.offers).toBeGreaterThan(0);
    expect(result.run.suppliers).toBe(1);
    const summary = parseJson<Record<string, number>>(result.session?.summaryJson ?? "{}", {});
    expect(summary.suppliersWithEvidence).toBe(1);
    expect(summary.supplierCandidates).toBe(1);
    expect(summary.exactMatches).toBe(1);
    expect(summary.existingSupplierRecords).toBe(1);
    expect(summary.noMatchResults).toBe(0);
    expect(result.session?.status).not.toBe("FAILED");
  });
});
