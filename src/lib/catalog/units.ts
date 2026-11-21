/**
 * Explicit unit conversions. Only conversions with a stated, unambiguous factor
 * are supported. Converting between incompatible dimensions (e.g. length to
 * weight) returns null rather than guessing.
 */

export type UnitDimension = "length" | "mass" | "volume" | "area" | "count" | "other";

const DIMENSION: Record<string, UnitDimension> = {
  m: "length", mm: "length", cm: "length", km: "length", in: "length", ft: "length", yd: "length",
  kg: "mass", g: "mass", mg: "mass", t: "mass", lb: "mass", oz: "mass",
  l: "volume", ml: "volume", m3: "volume", gal: "volume", ft3: "volume",
  m2: "area", mm2: "area", ft2: "area", in2: "area",
  pcs: "count", pc: "count", set: "count", pair: "count", box: "count", roll: "count",
  coil: "count", bundle: "count", carton: "count", drum: "count", bag: "count",
};

/** Conversion factor to a base unit per dimension (m, kg, l, m2, pcs). */
const TO_BASE: Record<string, number> = {
  m: 1, mm: 0.001, cm: 0.01, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144,
  kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.0283495231,
  l: 1, ml: 0.001, m3: 1000, gal: 3.785411784, ft3: 28.3168466,
  m2: 1, mm2: 1e-6, ft2: 0.09290304, in2: 0.00064516,
  pcs: 1, pc: 1, set: 1, pair: 1, box: 1, roll: 1, coil: 1, bundle: 1, carton: 1, drum: 1, bag: 1,
};

export function unitDimension(unit: string): UnitDimension {
  const u = (unit || "").trim().toLowerCase();
  return DIMENSION[u] ?? "other";
}

/**
 * Convert a quantity from one unit to another. Returns null when the units are
 * unknown, dimensionally incompatible, or have no stated factor.
 */
export function convertQuantity(value: number, fromUnit: string, toUnit: string): number | null {
  if (!Number.isFinite(value)) return null;
  const from = (fromUnit || "").trim().toLowerCase();
  const to = (toUnit || "").trim().toLowerCase();
  if (from === to) return value;
  const fromDim = unitDimension(from);
  const toDim = unitDimension(to);
  if (fromDim === "other" || toDim === "other" || fromDim !== toDim) return null;
  const fromFactor = TO_BASE[from];
  const toFactor = TO_BASE[to];
  if (fromFactor == null || toFactor == null || toFactor === 0) return null;
  return (value * fromFactor) / toFactor;
}

export function canConvert(fromUnit: string, toUnit: string): boolean {
  return convertQuantity(1, fromUnit, toUnit) !== null;
}