import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { runWithTenant } from "../src/lib/tenant";

vi.mock("../src/lib/sourcing/registry", () => ({
  getSearchAdapters: () => [
    {
      key: "PUBLIC_WEB",
      label: "Public web search",
      available: () => true,
      search: async (queries: string[]) => {
        const isFollowUp = queries.some((query) => query.toLowerCase().includes("site:gulf-fittings.example"));
        const sourceUrl = isFollowUp
          ? "https://gulf-fittings.example/products/elbow-pressure"
          : "https://gulf-fittings.example/products/elbow";
        return {
          adapter: "PUBLIC_WEB",
          label: "Public web search",
          status: "OK",
          queries: queries.map((query) => ({ query, status: "OK", resultCount: 1 })),
          candidates: [
            {
              adapter: "PUBLIC_WEB",
              sourceUrl,
              supplierName: "gulf-fittings.example",
              title: "Carbon steel long radius elbow ASTM A234 WPB",
              snippet: "6 inch schedule 40 class 150 butt weld elbow",
              evidence: { provider: "test-search" },
              retrievedAt: new Date(),
            },
          ],
        };
      },
    },
  ],
}));

vi.mock("../src/lib/sourcing/pages", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/sourcing/pages")>();
  return {
    ...original,
    fetchPublicResource: vi.fn(),
  };
});

import { fetchPublicResource } from "../src/lib/sourcing/pages";
import { resumeDeepResearchRun, runDeepResearchForItem } from "../src/lib/sourcing/research/engine";

const fetchMock = vi.mocked(fetchPublicResource);
const RUN = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

const productHtml = `<!doctype html><html><head><title>Gulf Fittings — Carbon Steel Elbow</title></head>
<body><h1>Carbon steel long radius elbow</h1>
<p>Carbon Steel ASTM A234 WPB 6 inch schedule 40 class 150 butt weld.</p>
<p>Contact sales@gulf-fittings.example for a quotation.</p>
<a href="/contact">Contact</a></body></html>`;

const productHtmlMissingPressure = `<!doctype html><html><head><title>Gulf Fittings — Carbon Steel Elbow</title></head>
<body><h1>Carbon steel long radius elbow</h1>
<p>Carbon Steel ASTM A234 WPB 6 inch schedule 40 butt weld.</p>
<a href="/contact">Contact</a></body></html>`;

const pressureHtml = `<!doctype html><html><head><title>Gulf Fittings — Elbow pressure class</title></head>
<body><h1>Elbow technical data</h1><p>Carbon Steel ASTM A234 WPB 6 inch schedule 40 class 150 butt weld elbow.</p></body></html>`;

function productResource() {
  return {
    ok: true as const,
    status: "OK" as const,
    finalUrl: "https://gulf-fittings.example/products/elbow",
    contentType: "text/html",
    body: Buffer.from(productHtml),
    text: productHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    links: ["/contact"],
    truncated: false,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(async () => {
  await rawDb.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await rawDb.$disconnect();
});

describe("end-to-end deep research with a connected web source", () => {
  it("turns a search lead into an investigated, evidence-backed exact candidate", async () => {
    const org = `org_deep_web_${RUN}`;
    organizationIds.push(org);
    await rawDb.organization.create({
      data: {
        id: org,
        slug: `deep-web-${RUN}`,
        name: "Deep Web Test",
        country: "AE",
        defaultCurrency: "AED",
        status: "ACTIVE",
      },
    });
    const enquiry = await rawDb.enquiry.create({
      data: {
        organizationId: org,
        publicRef: `ENQ-DEEP-WEB-${RUN}`,
        channel: "MANUAL",
        rawText: "Carbon steel long radius elbow 6 inch ASTM A234 WPB schedule 40 class 150",
        deliveryLocation: "Dubai, UAE",
        status: "SOURCING",
      },
    });
    const item = await rawDb.enquiryItem.create({
      data: {
        organizationId: org,
        enquiryId: enquiry.id,
        description: "Carbon steel long radius elbow",
        category: "Pipe Fittings",
        size: "6 inch",
        material: "Carbon Steel",
        grade: "WPB",
        pressureRating: "Class 150",
        schedule: "SCH 40",
        standard: "ASTM A234",
        quantity: 10,
        quantityToSource: 10,
        unit: "pcs",
        missingFields: "[]",
      },
    });

    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/contact")) {
        return {
          ok: true,
          status: "OK",
          finalUrl: "https://gulf-fittings.example/contact",
          contentType: "text/html",
          body: Buffer.from("<html><title>Contact</title><body>Contact our sales office in Dubai.</body></html>"),
          text: "Contact our sales office in Dubai.",
          links: [],
          truncated: false,
        };
      }
      return productResource();
    });

    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 8, maxRounds: 2, maxUrls: 6, maxConcurrentPages: 2 }),
    );

    const run = await rawDb.researchRun.findUnique({
      where: { id: result.runId! },
      include: { candidates: true, pages: true, evidence: true, queries: true },
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.candidates).toBe(1);
    expect(result.exact).toBe(1);
    expect(result.coverage.length).toBeGreaterThan(0);
    expect(run?.candidates).toHaveLength(1);
    expect(run?.candidates[0].matchStatus).toBe("EXACT");
    expect(run?.candidates[0].domain).toBe("gulf-fittings.example");
    expect(run?.pages.some((page) => page.status === "FETCHED" && page.pageType === "PRODUCT")).toBe(true);
    // Contact pages are useful for contact extraction but must not count as
    // product evidence or be classified as product pages just because the domain
    // contains the word "fittings".
    expect(run?.pages.find((page) => page.url.endsWith("/contact"))?.pageType).toBe("CONTACT");
    expect(run?.candidates[0].pageCount).toBe(1);
    expect(JSON.parse(run?.candidates[0].contactJson ?? "[]")).toEqual([
      expect.objectContaining({ type: "EMAIL", value: "sales@gulf-fittings.example" }),
    ]);
    expect(run?.evidence.some((entry) => entry.sourceType === "PAGE" && entry.field === "grade")).toBe(true);
    expect(run?.evidence.every((entry) => entry.sourceType !== "SEARCH_SNIPPET" || entry.verificationStatus === "SNIPPET_ONLY")).toBe(true);
    expect(run?.queries.some((query) => query.category === "EXACT_SPECIFICATION")).toBe(true);
    // No supplier quote, RFQ or message is created automatically.
    expect(await rawDb.supplierQuote.count({ where: { organizationId: org } })).toBe(0);
  });

  it("runs an evidence-gap follow-up round and resolves a missing pressure class", async () => {
    const org = `org_deep_follow_${RUN}`;
    organizationIds.push(org);
    await rawDb.organization.create({
      data: {
        id: org,
        slug: `deep-follow-${RUN}`,
        name: "Deep Follow-up Test",
        country: "AE",
        defaultCurrency: "AED",
        status: "ACTIVE",
      },
    });
    const enquiry = await rawDb.enquiry.create({
      data: {
        organizationId: org,
        publicRef: `ENQ-DEEP-FOLLOW-${RUN}`,
        channel: "MANUAL",
        rawText: "Carbon steel long radius elbow 6 inch ASTM A234 WPB schedule 40 class 150",
        deliveryLocation: "Dubai, UAE",
        status: "SOURCING",
      },
    });
    const item = await rawDb.enquiryItem.create({
      data: {
        organizationId: org,
        enquiryId: enquiry.id,
        description: "Carbon steel long radius elbow",
        category: "Pipe Fittings",
        size: "6 inch",
        material: "Carbon Steel",
        grade: "WPB",
        pressureRating: "Class 150",
        schedule: "SCH 40",
        standard: "ASTM A234",
        quantity: 10,
        quantityToSource: 10,
        unit: "pcs",
        missingFields: "[]",
      },
    });

    fetchMock.mockImplementation(async (url) => {
      const pressure = String(url).includes("pressure");
      const body = pressure ? pressureHtml : productHtmlMissingPressure;
      return {
        ok: true,
        status: "OK",
        finalUrl: String(url),
        contentType: "text/html",
        body: Buffer.from(body),
        text: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        links: ["/contact"],
        truncated: false,
      };
    });

    const result = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 12, maxRounds: 3, maxUrls: 8 }),
    );

    const run = await rawDb.researchRun.findUnique({
      where: { id: result.runId! },
      include: { queries: true, pages: true, candidates: true },
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.exact).toBe(1);
    expect(run?.iteration).toBeGreaterThanOrEqual(2);
    expect(run?.queries.some((query) => query.category === "FOLLOW_UP")).toBe(true);
    expect(run?.queries.some((query) => /site:gulf-fittings\.example/.test(query.query))).toBe(true);
    expect(run?.pages.some((page) => page.url.includes("pressure"))).toBe(true);
    expect(run?.candidates[0].matchStatus).toBe("EXACT");
  });

  it("resumes pending supplier pages and evidence-gap follow-ups from a partial run", async () => {
    const org = `org_deep_resume_${RUN}`;
    organizationIds.push(org);
    await rawDb.organization.create({
      data: {
        id: org,
        slug: `deep-resume-${RUN}`,
        name: "Deep Resume Test",
        country: "AE",
        defaultCurrency: "AED",
        status: "ACTIVE",
      },
    });
    const enquiry = await rawDb.enquiry.create({
      data: {
        organizationId: org,
        publicRef: `ENQ-DEEP-RESUME-${RUN}`,
        channel: "MANUAL",
        rawText: "Carbon steel long radius elbow 6 inch ASTM A234 WPB schedule 40 class 150",
        deliveryLocation: "Dubai, UAE",
        status: "SOURCING",
      },
    });
    const item = await rawDb.enquiryItem.create({
      data: {
        organizationId: org,
        enquiryId: enquiry.id,
        description: "Carbon steel long radius elbow",
        category: "Pipe Fittings",
        size: "6 inch",
        material: "Carbon Steel",
        grade: "WPB",
        pressureRating: "Class 150",
        schedule: "SCH 40",
        standard: "ASTM A234",
        quantity: 10,
        quantityToSource: 10,
        unit: "pcs",
        missingFields: "[]",
      },
    });

    fetchMock.mockImplementation(async (url) => {
      const pressure = String(url).includes("pressure");
      const body = pressure ? pressureHtml : productHtmlMissingPressure;
      return {
        ok: true,
        status: "OK",
        finalUrl: String(url),
        contentType: "text/html",
        body: Buffer.from(body),
        text: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        links: ["/contact"],
        truncated: false,
      };
    });

    const first = await runWithTenant({ organizationId: org, source: "test" }, () =>
      runDeepResearchForItem(item.id, { maxQueries: 20, maxRounds: 1, maxUrls: 1 }),
    );
    expect(first.runId).toBeTruthy();
    // Simulate a worker that returned a partial result rather than finishing the
    // remaining investigation and follow-up rounds.
    await rawDb.researchRun.update({
      where: { id: first.runId! },
      data: { status: "PARTIAL", stage: "PARTIAL", completedAt: new Date() },
    });

    const resumed = await runWithTenant({ organizationId: org, source: "test" }, () =>
      resumeDeepResearchRun(first.runId!, { maxQueries: 20, maxRounds: 3, maxUrls: 3 }),
    );
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.exact).toBe(1);

    const run = await rawDb.researchRun.findUnique({
      where: { id: first.runId! },
      include: { pages: true, candidates: true, queries: true },
    });
    expect(run?.candidates[0].matchStatus).toBe("EXACT");
    expect(run?.pages.some((page) => page.url.includes("pressure"))).toBe(true);
    expect(run?.queries.some((query) => query.category === "FOLLOW_UP")).toBe(true);
  });
});
