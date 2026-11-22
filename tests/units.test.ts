import { describe, expect, it } from "vitest";
import {
  canConvert,
  canConvertWithPackaging,
  convertQuantity,
  convertWithPackaging,
  requiresConfiguredFactor,
  unitDimension,
  validatePackagingConversions,
} from "../src/lib/catalog/units";

describe("unit conversion correctness", () => {
  it("converts fixed physical units exactly", () => {
    expect(convertQuantity(1, "m", "mm")).toBe(1000);
    expect(convertQuantity(1.5, "ft", "in")).toBeCloseTo(18, 10);
    expect(convertQuantity(2, "kg", "g")).toBe(2000);
    expect(convertQuantity(1, "l", "ml")).toBe(1000);
    expect(convertQuantity(1, "m2", "cm2")).toBeCloseTo(10000, 10);
  });

  it("converts atomic count units to each other", () => {
    expect(convertQuantity(12, "pcs", "each")).toBe(12);
    expect(convertQuantity(3, "pc", "pcs")).toBe(3);
    expect(canConvert("each", "pcs")).toBe(true);
  });

  it("does NOT treat packaging or grouping units as one piece", () => {
    for (const unit of ["box", "pair", "set", "roll", "coil", "bundle", "carton", "drum", "bag"]) {
      expect(requiresConfiguredFactor(unit)).toBe(true);
      expect(convertQuantity(1, unit, "pcs")).toBeNull();
      expect(convertQuantity(1, unit, "each")).toBeNull();
    }
    expect(convertQuantity(1, "pair", "pcs")).toBeNull();
    expect(convertQuantity(1, "roll", "m")).toBeNull();
    expect(convertQuantity(1, "drum", "l")).toBeNull();
    expect(convertQuantity(1, "box", "piece")).toBeNull();
  });

  it("rejects dimensionally incompatible conversions", () => {
    expect(convertQuantity(1, "kg", "m")).toBeNull();
    expect(convertQuantity(1, "l", "kg")).toBeNull();
    expect(convertQuantity(1, "m2", "m")).toBeNull();
    expect(convertQuantity(1, "pcs", "kg")).toBeNull();
  });

  it("rejects unknown units and invalid values", () => {
    expect(convertQuantity(1, "widget", "pcs")).toBeNull();
    expect(convertQuantity(1, "m", "furlong")).toBeNull();
    expect(convertQuantity(Number.NaN, "m", "mm")).toBeNull();
    expect(unitDimension("widget")).toBe("other");
  });

  it("converts a configured product packaging factor without rounding", () => {
    const packaging = [{ unit: "box", baseUnit: "pcs", factor: 20 }];
    expect(convertWithPackaging(1, "box", "pcs", packaging)).toBe(20);
    expect(convertWithPackaging(0.5, "box", "pcs", packaging)).toBe(10);
    expect(convertWithPackaging(3, "pcs", "box", packaging)).toBeCloseTo(0.15, 12);
    expect(convertWithPackaging(1.25, "box", "pcs", packaging)).toBe(25);
  });

  it("supports a configured chain such as carton → box → pcs", () => {
    const packaging = [
      { unit: "box", baseUnit: "pcs", factor: 20 },
      { unit: "carton", baseUnit: "box", factor: 5 },
    ];
    expect(convertWithPackaging(1, "carton", "pcs", packaging)).toBe(100);
    expect(convertWithPackaging(2, "carton", "pcs", packaging)).toBe(200);
  });

  it("supports a product-specific roll length or drum volume only when configured", () => {
    expect(convertWithPackaging(1, "roll", "m", [])).toBeNull();
    expect(convertWithPackaging(1, "roll", "m", [{ unit: "roll", baseUnit: "m", factor: 50 }])).toBe(50);
    expect(convertWithPackaging(1, "drum", "l", [])).toBeNull();
    expect(convertWithPackaging(1, "drum", "l", [{ unit: "drum", baseUnit: "l", factor: 200 }])).toBe(200);
  });

  it("does not let a configured factor cross dimensions", () => {
    const packaging = [{ unit: "box", baseUnit: "kg", factor: 20 }];
    expect(convertWithPackaging(1, "box", "pcs", packaging)).toBeNull();
    expect(convertWithPackaging(1, "box", "kg", packaging)).toBe(20);
  });

  it("rejects invalid, duplicate, cyclic and unknown packaging factors", () => {
    expect(validatePackagingConversions([{ unit: "box", baseUnit: "pcs", factor: 0 }]).ok).toBe(false);
    expect(validatePackagingConversions([{ unit: "box", baseUnit: "pcs", factor: -1 }]).ok).toBe(false);
    expect(validatePackagingConversions([{ unit: "box", baseUnit: "pcs", factor: Number.POSITIVE_INFINITY }]).ok).toBe(false);
    expect(
      validatePackagingConversions([
        { unit: "box", baseUnit: "pcs", factor: 20 },
        { unit: "box", baseUnit: "each", factor: 24 },
      ]).ok,
    ).toBe(false);
    expect(validatePackagingConversions([{ unit: "box", baseUnit: "mystery", factor: 20 }]).ok).toBe(false);
    expect(
      validatePackagingConversions([
        { unit: "box", baseUnit: "carton", factor: 2 },
        { unit: "carton", baseUnit: "box", factor: 3 },
      ]).ok,
    ).toBe(false);
    expect(
      validatePackagingConversions([
        { unit: "box", baseUnit: "pcs", factor: 20 },
        { unit: "carton", baseUnit: "box", factor: 0 },
      ]).ok,
    ).toBe(false);
  });

  it("never silently converts when the packaging configuration is invalid", () => {
    const invalid = [{ unit: "box", baseUnit: "pcs", factor: Number.NaN }];
    expect(convertWithPackaging(1, "box", "pcs", invalid)).toBeNull();
    expect(canConvertWithPackaging("box", "pcs", invalid)).toBe(false);
  });

  it("returns null instead of Infinity when a huge quantity overflows", () => {
    expect(convertQuantity(Number.MAX_VALUE, "km", "mm")).toBeNull();
    expect(
      convertWithPackaging(Number.MAX_VALUE, "carton", "pcs", [
        { unit: "box", baseUnit: "pcs", factor: 20 },
        { unit: "carton", baseUnit: "box", factor: 5 },
      ]),
    ).toBeNull();
    expect(Number.isFinite(convertQuantity(1.5, "m", "mm") as number)).toBe(true);
  });

  it("rejects product packaging that tries to redefine a fixed unit", () => {
    const fixed = validatePackagingConversions([{ unit: "m", baseUnit: "pcs", factor: 2 }]);
    expect(fixed.ok).toBe(false);
    if (!fixed.ok) expect(fixed.error).toMatch(/fixed unit/i);
    expect(convertWithPackaging(1, "box", "pcs", [{ unit: "box", baseUnit: "pcs", factor: 20 }])).toBe(20);
  });

  it("keeps decimal and very small quantities exact without rounding", () => {
    expect(convertWithPackaging(0.000001, "box", "pcs", [{ unit: "box", baseUnit: "pcs", factor: 20 }])).toBeCloseTo(0.00002, 15);
    expect(convertQuantity(0.000001, "m", "mm")).toBeCloseTo(0.001, 15);
    expect(convertWithPackaging(1 / 3, "carton", "pcs", [
      { unit: "box", baseUnit: "pcs", factor: 20 },
      { unit: "carton", baseUnit: "box", factor: 3 },
    ])).toBeCloseTo(20, 12);
  });
});
