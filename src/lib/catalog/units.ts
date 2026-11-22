/**
 * Unit conversion.
 *
 * Two kinds of units exist:
 *
 *  1. Units of a physical dimension with a fixed, internationally defined
 *     factor (length, mass, volume, area).
 *  2. Count units. Only the truly atomic "one item" units (pcs/pc/each/ea) are
 *     interchangeable. Packaging and grouping words (box, pair, set, roll,
 *     coil, bundle, carton, drum, bag, …) have no universal factor: one box is
 *     not one piece, one roll is not one metre and one drum is not one litre.
 *     They convert only when a factor is explicitly configured for the
 *     product, e.g. 1 box = 20 pcs.
 *
 * Unknown units, ambiguous units and dimensionally incompatible requests return
 * null. Nothing is guessed, silently rounded or inflated.
 */

export type UnitDimension = "length" | "mass" | "volume" | "area" | "count" | "other";

type UnitDefinition = {
  dimension: Exclude<UnitDimension, "other">;
  /** Factor to the dimension base unit. Null means "not convertible by itself". */
  toBase: number | null;
};

const UNITS: Record<string, UnitDefinition> = {
  // Length — base metre
  m: { dimension: "length", toBase: 1 },
  mm: { dimension: "length", toBase: 0.001 },
  cm: { dimension: "length", toBase: 0.01 },
  km: { dimension: "length", toBase: 1000 },
  in: { dimension: "length", toBase: 0.0254 },
  inch: { dimension: "length", toBase: 0.0254 },
  ft: { dimension: "length", toBase: 0.3048 },
  yd: { dimension: "length", toBase: 0.9144 },

  // Mass — base kilogram
  kg: { dimension: "mass", toBase: 1 },
  g: { dimension: "mass", toBase: 0.001 },
  mg: { dimension: "mass", toBase: 1e-6 },
  t: { dimension: "mass", toBase: 1000 },
  tonne: { dimension: "mass", toBase: 1000 },
  lb: { dimension: "mass", toBase: 0.45359237 },
  oz: { dimension: "mass", toBase: 0.028349523125 },

  // Volume — base litre
  l: { dimension: "volume", toBase: 1 },
  lt: { dimension: "volume", toBase: 1 },
  ml: { dimension: "volume", toBase: 0.001 },
  m3: { dimension: "volume", toBase: 1000 },
  gal: { dimension: "volume", toBase: 3.785411784 },
  ft3: { dimension: "volume", toBase: 28.316846592 },

  // Area — base square metre
  m2: { dimension: "area", toBase: 1 },
  mm2: { dimension: "area", toBase: 1e-6 },
  cm2: { dimension: "area", toBase: 1e-4 },
  ft2: { dimension: "area", toBase: 0.09290304 },
  in2: { dimension: "area", toBase: 0.00064516 },

  // Atomic counts — one item. These are genuinely interchangeable.
  pcs: { dimension: "count", toBase: 1 },
  pc: { dimension: "count", toBase: 1 },
  piece: { dimension: "count", toBase: 1 },
  pieces: { dimension: "count", toBase: 1 },
  each: { dimension: "count", toBase: 1 },
  ea: { dimension: "count", toBase: 1 },

  // Packaging / grouping units. Dimension is count-like, but there is no
  // universal factor. A product-specific packaging row must supply it.
  pair: { dimension: "count", toBase: null },
  pairs: { dimension: "count", toBase: null },
  set: { dimension: "count", toBase: null },
  sets: { dimension: "count", toBase: null },
  box: { dimension: "count", toBase: null },
  boxes: { dimension: "count", toBase: null },
  roll: { dimension: "count", toBase: null },
  rolls: { dimension: "count", toBase: null },
  coil: { dimension: "count", toBase: null },
  coils: { dimension: "count", toBase: null },
  bundle: { dimension: "count", toBase: null },
  bundles: { dimension: "count", toBase: null },
  carton: { dimension: "count", toBase: null },
  cartons: { dimension: "count", toBase: null },
  drum: { dimension: "count", toBase: null },
  drums: { dimension: "count", toBase: null },
  bag: { dimension: "count", toBase: null },
  bags: { dimension: "count", toBase: null },
  pack: { dimension: "count", toBase: null },
  packs: { dimension: "count", toBase: null },
  pallet: { dimension: "count", toBase: null },
  pallets: { dimension: "count", toBase: null },
  lot: { dimension: "count", toBase: null },
  length: { dimension: "count", toBase: null },
  lengths: { dimension: "count", toBase: null },
};

export function normalizeUnit(unit: string): string {
  return (unit ?? "").trim().toLowerCase();
}

export function isKnownUnit(unit: string): boolean {
  return normalizeUnit(unit) in UNITS;
}

/** A unit that can be converted using its own fixed factor (e.g. m, kg, pcs). */
export function isSelfConvertibleUnit(unit: string): boolean {
  const definition = UNITS[normalizeUnit(unit)];
  return Boolean(definition && definition.toBase != null);
}

export function unitDimension(unit: string): UnitDimension {
  return UNITS[normalizeUnit(unit)]?.dimension ?? "other";
}

/** Units whose factor must come from an explicit product packaging configuration. */
export function requiresConfiguredFactor(unit: string): boolean {
  const definition = UNITS[normalizeUnit(unit)];
  return Boolean(definition && definition.toBase == null);
}

/**
 * Converts a quantity only when both units carry a fixed, dimensionally valid
 * factor. Unknown, ambiguous and incompatible conversions return null.
 * No rounding is applied.
 */
export function convertQuantity(value: number, fromUnit: string, toUnit: string): number | null {
  if (!Number.isFinite(value)) return null;
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return value;

  const fromDefinition = UNITS[from];
  const toDefinition = UNITS[to];
  if (!fromDefinition || !toDefinition) return null;
  if (fromDefinition.dimension !== toDefinition.dimension) return null;
  if (fromDefinition.toBase == null || toDefinition.toBase == null) return null;
  if (toDefinition.toBase === 0) return null;

  const result = (value * fromDefinition.toBase) / toDefinition.toBase;
  return Number.isFinite(result) ? result : null;
}

export function canConvert(fromUnit: string, toUnit: string): boolean {
  return convertQuantity(1, fromUnit, toUnit) !== null;
}

// ── Explicit product packaging factors ──────────────────────────────────────

/**
 * A configured relationship such as { unit: "box", baseUnit: "pcs", factor: 20 }
 * meaning one box contains 20 pieces. `baseUnit` must itself be resolvable
 * (a fixed unit or another configured unit), so carton → box → pcs chains work.
 */
export type PackagingConversion = {
  unit: string;
  baseUnit: string;
  factor: number;
};

export type PackagingValidation =
  | { ok: true; conversions: PackagingConversion[] }
  | { ok: false; error: string };

export function validatePackagingConversions(input: PackagingConversion[]): PackagingValidation {
  if (!Array.isArray(input)) return { ok: false, error: "Packaging conversions must be a list." };
  const seen = new Set<string>();
  const conversions: PackagingConversion[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Each packaging conversion must be an object." };
    const unit = normalizeUnit(raw.unit);
    const baseUnit = normalizeUnit(raw.baseUnit);
    const factor = Number(raw.factor);

    if (!unit || !baseUnit) return { ok: false, error: "Packaging conversions need both a unit and a base unit." };
    if (unit === baseUnit) return { ok: false, error: `A unit cannot be defined in terms of itself (${unit}).` };
    if (!isKnownUnit(unit)) return { ok: false, error: `Unknown packaging unit "${raw.unit}".` };
    if (!isKnownUnit(baseUnit)) return { ok: false, error: `Unknown base unit "${raw.baseUnit}".` };
    if (!Number.isFinite(factor) || factor <= 0) {
      return { ok: false, error: `The factor for 1 ${unit} must be a positive finite number.` };
    }
    // A fixed physical/count unit already has a universal meaning. Re-defining
    // it per product would silently shadow that meaning and create conflicting
    // conversion paths, so it is rejected instead of stored.
    if (UNITS[unit]?.toBase != null) {
      return { ok: false, error: `"${unit}" is a fixed unit and cannot be redefined by product packaging.` };
    }
    if (seen.has(unit)) return { ok: false, error: `Two different factors were supplied for ${unit}; the conversion is ambiguous.` };
    seen.add(unit);
    conversions.push({ unit, baseUnit, factor });
  }

  // Detect cycles by resolving every configured unit to a fixed factor.
  for (const conversion of conversions) {
    const seenUnits = new Set<string>();
    let current = conversion.unit;
    for (let depth = 0; depth < conversions.length + 2; depth += 1) {
      if (seenUnits.has(current)) {
        return { ok: false, error: `Packaging conversions contain a cycle involving ${current}.` };
      }
      seenUnits.add(current);
      const definition = UNITS[current];
      if (definition && definition.toBase != null) break;
      const next = conversions.find((candidate) => candidate.unit === current);
      if (!next) {
        return { ok: false, error: `No factor is configured for ${current}; the conversion is incomplete.` };
      }
      current = next.baseUnit;
    }
  }

  return { ok: true, conversions };
}

type ResolvedUnit = { dimension: Exclude<UnitDimension, "other">; factorToBase: number };

/**
 * Resolves a unit to its dimension base, applying configured packaging factors
 * when needed. Returns null for unknown, ambiguous or cyclic definitions.
 */
function resolveUnit(unit: string, conversions: PackagingConversion[], seen = new Set<string>()): ResolvedUnit | null {
  const normalized = normalizeUnit(unit);
  const definition = UNITS[normalized];
  if (definition?.toBase != null) return { dimension: definition.dimension, factorToBase: definition.toBase };
  if (!definition || seen.has(normalized)) return null;
  seen.add(normalized);
  const configured = conversions.find((candidate) => normalizeUnit(candidate.unit) === normalized);
  if (!configured || !Number.isFinite(configured.factor) || configured.factor <= 0) return null;
  const base = resolveUnit(configured.baseUnit, conversions, seen);
  if (!base) return null;
  return { dimension: base.dimension, factorToBase: base.factorToBase * configured.factor };
}

/**
 * Converts with explicit product packaging. Standard physical conversions work
 * without configuration; packaging units only work when a valid factor exists.
 * Returns null for every unsupported or ambiguous request.
 */
export function convertWithPackaging(
  value: number,
  fromUnit: string,
  toUnit: string,
  conversions: PackagingConversion[],
): number | null {
  if (!Number.isFinite(value)) return null;
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return value;

  const validation = validatePackagingConversions(conversions);
  if (!validation.ok) return null;

  const fromResolved = resolveUnit(from, validation.conversions);
  const toResolved = resolveUnit(to, validation.conversions);
  if (!fromResolved || !toResolved) return null;
  if (fromResolved.dimension !== toResolved.dimension) return null;
  if (toResolved.factorToBase === 0) return null;

  const result = (value * fromResolved.factorToBase) / toResolved.factorToBase;
  return Number.isFinite(result) ? result : null;
}

export function canConvertWithPackaging(
  fromUnit: string,
  toUnit: string,
  conversions: PackagingConversion[],
): boolean {
  return convertWithPackaging(1, fromUnit, toUnit, conversions) !== null;
}

/** True when both units can be added together without an explicit factor. */
export function unitsAreComparable(left: string, right: string): boolean {
  return normalizeUnit(left) === normalizeUnit(right) || canConvert(left, right);
}
