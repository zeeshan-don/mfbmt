import { describe, expect, it } from "vitest";
import { finalizeItems, parseLineItems } from "../src/lib/ai/extract";

const EXACT_MESSAGE =
  "We need 2,000 pieces of M8 x 40mm hex head bolts, DIN 933, stainless steel SS304, metric coarse thread with 1.25mm pitch. Plain finish. Please quote your best price and delivery time. Also quote 2,000 hex nuts M8, DIN 934, stainless steel SS304, A2-70 grade, metric coarse thread, 1.25mm pitch, plain finish. These should be compatible with the bolts above.";

describe("fastener extraction regression", () => {
  it("extracts the exact two-product customer message", () => {
    const items = finalizeItems(parseLineItems(EXACT_MESSAGE, "message"));
    expect(items).toHaveLength(2);

    const bolt = items[0].fastenerSpec!;
    expect(bolt.type).toBe("HEX_BOLT");
    expect(bolt.diameter).toBe("M8");
    expect(bolt.threadSeries).toBe("METRIC_COARSE");
    expect(bolt.pitchMm).toBe(1.25);
    expect(bolt.lengthMm).toBe(40);
    expect(bolt.material).toBe("SS304");
    expect(bolt.propertyClass).toBeNull();
    expect(bolt.finish).toBe("PLAIN");
    expect(bolt.standard).toBe("DIN 933");
    expect(items[0].quantity).toBe(2000);
    expect(items[0].missingFields).toContain("Property class");

    const nut = items[1].fastenerSpec!;
    expect(nut.type).toBe("HEX_NUT");
    expect(nut.diameter).toBe("M8");
    expect(nut.threadSeries).toBe("METRIC_COARSE");
    expect(nut.pitchMm).toBe(1.25);
    expect(nut.lengthMm).toBeNull();
    expect(nut.material).toBe("SS304");
    expect(nut.propertyClass).toBe("A2-70");
    expect(nut.finish).toBe("PLAIN");
    expect(nut.standard).toBe("DIN 934");
    expect(items[1].quantity).toBe(2000);
    expect(items[1].missingFields).toHaveLength(0);
  });

  it("extracts a single fully specified hex bolt", () => {
    const [item] = finalizeItems(parseLineItems("10 pcs M10 x 30mm hex bolt DIN 931 SS316 8.8 zinc plated metric coarse 1.5mm pitch", "message"));
    expect(item.fastenerSpec?.type).toBe("HEX_BOLT");
    expect(item.fastenerSpec?.diameter).toBe("M10");
    expect(item.fastenerSpec?.lengthMm).toBe(30);
    expect(item.fastenerSpec?.pitchMm).toBe(1.5);
    expect(item.fastenerSpec?.material).toBe("SS316");
    expect(item.fastenerSpec?.propertyClass).toBe("8.8");
    expect(item.fastenerSpec?.finish).toBe("ZINC_PLATED");
    expect(item.quantity).toBe(10);
  });

  it("extracts multiple products from one message", () => {
    const items = parseLineItems("5 hex bolts M6 x 20mm\n3 hex nuts M6", "message");
    expect(items).toHaveLength(2);
    expect(items[0].quantity).toBe(5);
    expect(items[1].quantity).toBe(3);
  });

  it("extracts explicit pitch written before the word pitch", () => {
    const [item] = finalizeItems(parseLineItems("2 pcs M8 x 40mm hex bolt 1.25mm pitch SS304 plain", "message"));
    expect(item.fastenerSpec?.pitchMm).toBe(1.25);
  });

  it("preserves M8 x 40mm as diameter M8 and length 40mm", () => {
    const [item] = finalizeItems(parseLineItems("1 hex bolt M8 x 40mm", "message"));
    expect(item.fastenerSpec?.diameter).toBe("M8");
    expect(item.fastenerSpec?.lengthMm).toBe(40);
    expect(item.size).toBe("M8 x 40mm");
  });

  it("does not invent a missing property class", () => {
    const [item] = finalizeItems(parseLineItems("1 hex bolt M8 x 40mm SS304 plain finish", "message"));
    expect(item.fastenerSpec?.propertyClass).toBeNull();
    expect(item.missingFields).toContain("Property class");
  });

  it("parses quantity stated as 2,000 pieces", () => {
    const [item] = parseLineItems("2,000 pieces hex bolt M8", "message");
    expect(item.quantity).toBe(2000);
  });

  it("preserves SS304 separately from A2-70", () => {
    const [item] = finalizeItems(parseLineItems("1 hex nut M8 SS304 A2-70", "message"));
    expect(item.fastenerSpec?.material).toBe("SS304");
    expect(item.fastenerSpec?.propertyClass).toBe("A2-70");
  });

  it("keeps a genuinely incomplete message incomplete", () => {
    const [item] = finalizeItems(parseLineItems("hex bolt", "message"));
    expect(item.missingFields.length).toBeGreaterThan(0);
    expect(item.fastenerSpec?.diameter).toBeNull();
  });
});