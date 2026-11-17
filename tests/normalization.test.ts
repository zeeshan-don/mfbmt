import { describe, expect, it } from "vitest";
import {
  normalizeMaterial,
  normalizePressure,
  normalizeSize,
  normalizeUnit,
  parseQuantity,
  sizeToMm,
} from "../src/lib/catalog/normalize";
import { parseLineItems, finalizeItems } from "../src/lib/ai/extract";
import { ExtractionSchema } from "../src/lib/validation/extraction";

describe("quantity and unit parsing", () => {
  it("reads quantity and unit from a natural phrase", () => {
    expect(parseQuantity("20 pcs")).toEqual({ quantity: 20, unit: "pcs" });
    expect(parseQuantity("10")).toEqual({ quantity: 10, unit: null });
    expect(parseQuantity("5 nos")).toEqual({ quantity: 5, unit: "pcs" });
    expect(parseQuantity("no quantity given").quantity).toBeNull();
  });

  it("normalizes unit synonyms", () => {
    expect(normalizeUnit("Pieces")).toBe("pcs");
    expect(normalizeUnit("nos")).toBe("pcs");
    expect(normalizeUnit("MTR")).toBe("m");
    expect(normalizeUnit("kgs")).toBe("kg");
    expect(normalizeUnit(null)).toBe("pcs");
  });
});

describe("specification normalization", () => {
  it("converts inch and mm sizes to a comparable value", () => {
    expect(sizeToMm("1 inch")).toBeCloseTo(25.4, 1);
    expect(sizeToMm("DN25")).toBe(25);
    expect(sizeToMm('1/2"')).toBeCloseTo(12.7, 1);
    expect(normalizeSize("1 inch")).toBe("1in");
    expect(normalizeSize("DN25")).toBe("0.984in");
  });

  it("normalizes stainless steel materials without hiding the grade", () => {
    expect(normalizeMaterial("stainless steel 316")).toBe("SS316");
    expect(normalizeMaterial("SS 316L")).toBe("SS316L");
    expect(normalizeMaterial("SS304")).toBe("SS304");
    expect(normalizeMaterial("mild steel")).toBe("MS");
  });

  it("normalizes pressure classes", () => {
    expect(normalizePressure("class 150")).toBe("CLASS150");
    expect(normalizePressure("PN16")).toBe("PN16");
    expect(normalizePressure("16 bar")).toBe("PN160");
  });
});

describe("line item extraction", () => {
  it("extracts quantity, material, size and category", () => {
    const items = parseLineItems("20 pcs SS316 elbow 1 inch", "message");
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(20);
    expect(items[0].unit).toBe("pcs");
    expect(items[0].material?.toUpperCase()).toContain("316");
    expect(items[0].size).toBeTruthy();
  });

  it("extracts several products from one message", () => {
    const items = parseLineItems("10 hammers\n20 pcs SS316 elbow 1 inch\n5 industrial valves", "message");
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("asks for the hammer type instead of inventing a specification", () => {
    const [item] = finalizeItems(parseLineItems("10 hammers", "message"));
    expect(item.missingFields).toContain("Product type");
    expect(item.clarificationQuestion).toMatch(/which hammer type/i);
  });

  it("marks a valve without size, material and rating as incomplete", () => {
    const [item] = finalizeItems(parseLineItems("5 industrial valves", "message"));
    expect(item.missingFields.length).toBeGreaterThan(0);
    expect(item.missingFields).toContain("Product type");
    expect(item.clarificationQuestion).toBeTruthy();
  });

  it("ignores narrative lines such as a quote request heading", () => {
    const items = parseLineItems("Please quote:\n10 hammers", "message");
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("hammers");
  });

  it("treats a complete elbow specification as ready", () => {
    const [item] = finalizeItems(parseLineItems("20 pcs SS316 elbow 1 inch", "message"));
    expect(item.missingFields).toHaveLength(0);
  });

  it("does not invent a quantity when none is stated", () => {
    const [item] = finalizeItems(parseLineItems("SS316 elbow 1 inch", "message"));
    expect(item.quantity).toBeNull();
    expect(item.missingFields).toContain("quantity");
  });
});

describe("extraction schema validation", () => {
  it("accepts a valid structured extraction", () => {
    const parsed = ExtractionSchema.safeParse({
      isRfq: true,
      classification: "RFQ",
      classificationConfidence: 0.9,
      classificationReason: "Asks for a quotation",
      items: [
        { description: "SS316 elbow", quantity: 10, unit: "pcs", size: "1 inch", material: "SS316", missingFields: [] },
      ],
      unreadableParts: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid classification and negative quantity", () => {
    const parsed = ExtractionSchema.safeParse({
      isRfq: true,
      classification: "SOMETHING_ELSE",
      classificationConfidence: 2,
      classificationReason: "x",
      items: [{ description: "x", quantity: -5 }],
    });
    expect(parsed.success).toBe(false);
  });
});
