import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/env", () => ({
  env: {
    WEB_SEARCH_PROVIDER: "auto",
    TAVILY_API_KEY: "tavily-test-key",
    SERPER_API_KEY: "serper-test-key",
    BRAVE_SEARCH_API_KEY: "",
    SEARCH_MAX_RESULTS: 3,
    SEARCH_REQUEST_TIMEOUT_MS: 1000,
  },
  isDemoMode: false,
  isProd: false,
  MAX_UPLOAD_MB: 12,
}));

import { webSearchAdapter } from "../src/lib/sourcing/adapters/web";
import { marketplaceAdapter } from "../src/lib/sourcing/adapters/marketplace";

const context = {
  request: {
    description: "Long radius elbow 0.5in carbon steel WPB",
    quantity: 90,
    unit: "pcs",
    category: "Fittings",
    material: "Carbon Steel",
    size: "0.5in",
    standard: "ASTM A234",
  },
  fetchPages: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function tavilyEmpty() {
  return jsonResponse({ results: [] });
}

function serperResult(url = "https://gulf-fittings.example/elbow") {
  return jsonResponse({
    organic: [
      {
        title: "Carbon steel long radius elbow ASTM A234 WPB",
        link: url,
        snippet: "0.5 inch carbon steel WPB elbow. Class 150.",
      },
    ],
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("public web search provider chain", () => {
  it("falls back when a provider succeeds with zero usable results", async () => {
    fetchMock
      .mockResolvedValueOnce(tavilyEmpty())
      .mockResolvedValueOnce(serperResult());

    const result = await webSearchAdapter.search(["long radius elbow 0.5in carbon steel"], context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("OK");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].supplierName).toBe("gulf-fittings.example");
    expect(result.candidates[0].evidence?.provider).toBe("serper");
    expect(result.note).toMatch(/no usable results/i);
  });

  it("retains results from a working provider when another provider fails", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("tavily")) return jsonResponse({ error: "upstream" }, 503);
      if (url.includes("serper")) return serperResult();
      return jsonResponse({}, 404);
    });

    const result = await webSearchAdapter.search(
      ["long radius elbow 0.5in carbon steel", "long radius elbow ASTM A234"],
      context,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.status).toBe("PARTIAL");
    expect(result.queries.some((query) => query.status === "FAILED")).toBe(true);
    expect(result.queries.some((query) => query.status === "SKIPPED")).toBe(true);
    expect(result.note).toMatch(/tavily failed/i);
  });

  it("reports a failed search when every provider fails instead of claiming success", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("tavily")) return jsonResponse({ error: "down" }, 500);
      return jsonResponse({ error: "quota" }, 429);
    });

    const result = await webSearchAdapter.search(["long radius elbow carbon steel"], context);
    expect(result.status).toBe("FAILED");
    expect(result.candidates).toHaveLength(0);
    expect(result.note ?? "").not.toMatch(/no supplier exists/i);
  });

  it("does not treat an empty successful response as proof that no supplier exists", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ results: [], organic: [] }));

    const result = await webSearchAdapter.search(["long radius elbow carbon steel"], context);
    expect(result.status).toBe("OK");
    expect(result.candidates).toHaveLength(0);
    expect(result.note).toMatch(/no usable supplier results/i);
    // Both configured providers were actually tried.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("marketplace adapter", () => {
  it("is reported as not configured instead of pretending to search", async () => {
    const result = await marketplaceAdapter.search(["elbow"], context);
    expect(marketplaceAdapter.available()).toBe(false);
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(result.candidates).toHaveLength(0);
    expect(result.note).toMatch(/api|credentials/i);
  });
});
