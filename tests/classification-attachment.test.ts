import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeJson } = vi.hoisted(() => ({ completeJson: vi.fn() }));

vi.mock("../src/lib/ai/provider", () => ({
  aiStatus: () => ({ configured: true, provider: "test", model: "test" }),
  completeJson,
  DATA_ONLY_RULE: "data-only",
}));

import { classifyMessage } from "../src/lib/ai/classify";

function aiResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      classification: "PERSONAL",
      confidence: 0.95,
      reason: "Greeting",
      mentionsProducts: false,
      isQuotationRequest: false,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      ...overrides,
    },
  };
}

describe("attachment-backed classification", () => {
  beforeEach(() => completeJson.mockReset());

  it("overrides a personal AI result when a document is attached", async () => {
    completeJson.mockResolvedValue(aiResult());
    const result = await classifyMessage({
      channel: "EMAIL",
      hasAttachments: true,
      text: "Hi, I urgently need these items",
    });

    expect(result.result.classification).toBe("RFQ");
    expect(result.result.isQuotationRequest).toBe(true);
    expect(result.result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("keeps RFQ when the model says RFQ but not a quotation request", async () => {
    completeJson.mockResolvedValue(
      aiResult({ classification: "RFQ", confidence: 0.4, isQuotationRequest: false }),
    );
    const result = await classifyMessage({
      channel: "EMAIL",
      hasAttachments: true,
      text: "Hi, I urgently need these items",
    });

    expect(result.result.classification).toBe("RFQ");
    expect(result.result.isQuotationRequest).toBe(true);
  });

  it("still allows a genuinely personal message with an attachment", async () => {
    completeJson.mockResolvedValue(aiResult());
    const result = await classifyMessage({
      channel: "EMAIL",
      hasAttachments: true,
      text: "Happy birthday, see you at dinner",
    });

    expect(result.result.classification).toBe("PERSONAL");
  });
});
