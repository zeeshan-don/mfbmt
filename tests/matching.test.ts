import { describe, expect, it } from "vitest";
import { availableQuantity, isStockStale, matchProduct, stockSplit } from "../src/lib/inventory/matching";

const requested = {
  description: "SS316 elbow 1 inch",
  category: "Pipe Fittings",
  size: "1 inch",
  material: "SS316",
};

describe("product matching", () => {
  it("returns an exact match for the same size and material", () => {
    const result = matchProduct(requested, {
      description: "Stainless Steel Elbow 90° 1 inch SS316",
      category: "Pipe Fittings",
      size: "1 inch",
      material: "SS316",
    });
    expect(result.status).toBe("EXACT");
  });

  it("rejects SS304 as an exact match for a requested SS316 product", () => {
    const result = matchProduct(requested, {
      description: "Stainless Steel Elbow 90° 1 inch SS304",
      category: "Pipe Fittings",
      size: "1 inch",
      material: "SS304",
    });
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/material/i);
  });

  it("does not treat an unknown material as an exact match", () => {
    const result = matchProduct(requested, {
      description: "Stainless Steel Elbow 1 inch",
      category: "Pipe Fittings",
      size: "1 inch",
      material: null,
    });
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.missing).toContain("Material");
  });

  it("rejects a different size", () => {
    const result = matchProduct(requested, {
      description: "SS316 elbow 2 inch",
      category: "Pipe Fittings",
      size: "2 inch",
      material: "SS316",
    });
    expect(result.status).toBe("NO_MATCH");
  });

  it("marks a pressure-rated valve without a stated rating as not enough information", () => {
    const result = matchProduct(
      {
        description: "gate valve 1 inch SS316 class 150",
        category: "Valves",
        size: "1 inch",
        material: "SS316",
        pressureRating: "Class 150",
      },
      {
        description: "Stainless gate valve 1 inch SS316",
        category: "Valves",
        size: "1 inch",
        material: "SS316",
        pressureRating: null,
      },
    );
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.missing).toContain("Pressure rating");
    expect(result.status).not.toBe("EXACT");
  });

  it("rejects a different brand when a brand is required", () => {
    const result = matchProduct(
      { description: "ball valve 1 inch SS316", category: "Valves", size: "1 inch", material: "SS316", brand: "Kirloskar" },
      {
        description: "ball valve 1 inch SS316",
        category: "Valves",
        size: "1 inch",
        material: "SS316",
        brand: "Other Brand",
      },
    );
    expect(result.status).toBe("NO_MATCH");
  });

  it("rejects a completely different product type", () => {
    const result = matchProduct(requested, {
      description: "Hex bolt 1 inch SS316",
      category: "Industrial Fasteners",
      size: "1 inch",
      material: "SS316",
    });
    expect(result.status).toBe("NO_MATCH");
  });

  it("keeps an optional attribute missing as a possible match, not exact", () => {
    const result = matchProduct(
      { ...requested, schedule: "Sch 40" },
      { description: "Stainless Steel Elbow 1 inch SS316", category: "Pipe Fittings", size: "1 inch", material: "SS316" },
    );
    expect(result.status).toBe("POSSIBLE");
  });
});

describe("stock calculations", () => {
  it("never returns negative availability", () => {
    expect(availableQuantity(5, 8)).toBe(0);
    expect(availableQuantity(10, 3)).toBe(7);
  });

  it("splits a partially fulfilled request", () => {
    expect(stockSplit(10, 6)).toEqual({ fromStock: 6, toSource: 4 });
    expect(stockSplit(10, 0)).toEqual({ fromStock: 0, toSource: 10 });
    expect(stockSplit(10, 10)).toEqual({ fromStock: 10, toSource: 0 });
    expect(stockSplit(10, 25)).toEqual({ fromStock: 10, toSource: 0 });
  });

  it("treats old stock as potentially stale", () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    expect(isStockStale(old)).toBe(true);
    expect(isStockStale(new Date())).toBe(false);
    expect(isStockStale(null)).toBe(true);
  });
});
