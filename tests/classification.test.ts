import { describe, expect, it } from "vitest";
import { ruleClassify } from "../src/lib/ai/classify";

const base = { channel: "WHATSAPP", hasAttachments: false };

describe("message classification", () => {
  it("treats an explicit quote request for products as an RFQ", () => {
    const result = ruleClassify({ ...base, text: "Please quote 10 hammers" });
    expect(result.classification).toBe("RFQ");
    expect(result.isQuotationRequest).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("does not treat a product availability question as an RFQ", () => {
    const result = ruleClassify({ ...base, text: "Do you have SS 316 fittings?" });
    expect(result.classification).toBe("AVAILABILITY");
    expect(result.isQuotationRequest).toBe(false);
  });

  it("does not treat a delivery thank-you as an RFQ", () => {
    const result = ruleClassify({ ...base, text: "Thanks for yesterday's delivery" });
    expect(result.classification).toBe("FOLLOW_UP");
    expect(result.isQuotationRequest).toBe(false);
  });

  it("classifies a birthday greeting as personal", () => {
    const result = ruleClassify({ ...base, text: "Happy birthday!" });
    expect(result.classification).toBe("PERSONAL");
  });

  it("never creates a business enquiry for an excluded family contact", () => {
    const result = ruleClassify({
      ...base,
      text: "Please quote 10 hammers for my shop",
      excludedCategory: "FAMILY",
    });
    expect(result.classification).toBe("PERSONAL");
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.isQuotationRequest).toBe(false);
  });

  it("treats an excluded personal contact the same way", () => {
    const result = ruleClassify({ ...base, text: "Need 5 valves", excludedCategory: "PERSONAL" });
    expect(result.classification).toBe("PERSONAL");
  });

  it("recognises a supplier offering goods", () => {
    const result = ruleClassify({
      ...base,
      text: "We can supply SS316 elbows. Please find our offer and price list attached.",
    });
    expect(result.classification).toBe("SUPPLIER");
    expect(result.isQuotationRequest).toBe(false);
  });

  it("classifies an invoice request as business but not an RFQ", () => {
    const result = ruleClassify({ ...base, text: "Can you send the invoice for last month?" });
    expect(result.classification).toBe("FOLLOW_UP");
    expect(result.isQuotationRequest).toBe(false);
  });

  it("marks an unclear message as unclear", () => {
    const result = ruleClassify({ ...base, text: "Need this urgently" });
    expect(["UNCLEAR", "RFQ"]).toContain(result.classification);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it("treats an attachment without text as a possible RFQ needing review", () => {
    const result = ruleClassify({ ...base, channel: "EMAIL", hasAttachments: true, text: "" });
    expect(result.classification).toBe("RFQ");
    expect(result.confidence).toBeLessThanOrEqual(0.65);
  });
});
