import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeJson } = vi.hoisted(() => ({ completeJson: vi.fn() }));

vi.mock("../src/lib/ai/provider", () => ({
  aiStatus: () => ({ configured: true, provider: "test", model: "test" }),
  completeJson,
  DATA_ONLY_RULE: "data-only",
}));

import { extractEnquiry } from "../src/lib/ai/extract";

const baseData = {
  isRfq: true,
  classification: "RFQ",
  classificationConfidence: 0.92,
  classificationReason: "Customer asked for a quotation.",
  customerName: null,
  customerPhone: null,
  customerEmail: null,
  deliveryLocation: null,
  deliveryDate: null,
  currency: null,
  unreadableParts: [],
  notes: null,
};

function aiResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      ...baseData,
      customerContext: {
        greeting: "Hi",
        urgency: "Urgent",
        requestedDeliveryTimeframe: "3 days",
        deliveryLocation: null,
        instructions: ["Please process this urgently."],
        commercialRequirements: [],
        certifications: [],
        notes: [],
      },
      items: [],
      ...overrides,
    },
  };
}

const document = {
  filename: "customer-items.pdf",
  kind: "pdf" as const,
  text: "[page 1]\nLong radius elbow, carbon steel, ASTM A234 WPB, 90 pcs",
  pages: [{ page: 1, text: "Long radius elbow, carbon steel, ASTM A234 WPB, 90 pcs" }],
};

beforeEach(() => completeJson.mockReset());

describe("AI semantic extraction", () => {
  it("rejects a greeting returned as a product and keeps it as context", async () => {
    completeJson.mockResolvedValue(
      aiResult({
        items: [
          {
            description: "Hi, I need these items urgently in 3 days.",
            quantity: null,
            unit: null,
            sourceRef: "Email body",
            missingFields: ["quantity"],
            confidence: {},
          },
          {
            description: "Long radius elbow, carbon steel, ASTM A234 WPB",
            quantity: 90,
            unit: "pcs",
            category: "Fittings",
            size: "0.5in",
            material: "Carbon Steel",
            grade: "A234 WPB",
            standard: "ASTM A234",
            sourceRef: "customer-items.pdf page 1",
            evidence: [
              {
                field: "quantity",
                value: "90",
                sourceRef: "customer-items.pdf page 1",
                quote: "Long radius elbow, carbon steel, ASTM A234 WPB, 90 pcs",
              },
            ],
            missingFields: [],
            confidence: {},
          },
          {
            description: "Please confirm availability.",
            quantity: null,
            unit: null,
            sourceRef: "Email body",
            missingFields: [],
            confidence: {},
          },
        ],
      }),
    );

    const result = await extractEnquiry(
      {
        text: "Hi, I need these items urgently in 3 days.",
        subject: "Urgent RFQ",
        documents: [document],
      },
      { industrial: true },
    );

    expect(result.source).toBe("ai");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/long radius elbow/i);
    expect(result.items[0].quantity).toBe(90);
    expect(result.items[0].evidence?.[0].sourceRef).toMatch(/customer-items\.pdf page 1/i);
    expect(result.extraction.customerContext?.urgency).toMatch(/urgent/i);
    expect(result.extraction.customerContext?.requestedDeliveryTimeframe).toBe("3 days");
    expect(result.extraction.customerContext?.instructions.join(" ")).toMatch(/process this urgently/i);
    expect(result.extraction.customerContext?.notes.join(" ")).toMatch(/need these items|confirm availability/i);
    expect(result.extraction.notes ?? "").not.toMatch(/hi, I need/i);
  });

  it("sends the email body together with the attachment instead of discarding the body", async () => {
    completeJson.mockResolvedValue(aiResult({ items: [] }));

    await extractEnquiry(
      {
        text: "Urgent: deliver to Dubai site within 3 days. Please quote 10 pcs gate valve.",
        subject: "Site requirement",
        documents: [document],
      },
      { industrial: true },
    );

    const request = completeJson.mock.calls[0][0] as { user: string; system: string };
    expect(request.user).toMatch(/gate valve/i);
    expect(request.user).toMatch(/customer-items\.pdf/i);
    expect(request.user).toMatch(/Dubai site/i);
    expect(request.system).toMatch(/greeting.*never a product|never a product/i);
  });

  it("falls back to the deterministic parser when the model returns no products", async () => {
    completeJson.mockResolvedValue(aiResult({ items: [] }));

    const result = await extractEnquiry(
      {
        text: "Hi, please quote the attached.",
        documents: [document],
      },
      { industrial: true },
    );

    expect(result.source).toBe("rule");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/long radius elbow/i);
    expect(result.aiError).toMatch(/no product lines/i);
  });

  it("caches a completed AI extraction for unchanged content", async () => {
    completeJson.mockResolvedValue(aiResult({ items: [] }));

    const input = {
      text: "Cached enquiry: please process urgently. Delivery within 3 days.",
      subject: "Cache check",
      documents: [],
    };
    await extractEnquiry(input, { industrial: false });
    await extractEnquiry(input, { industrial: false });

    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});
