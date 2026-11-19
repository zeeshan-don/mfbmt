import { normalizeMaterial, normalizePressure, normalizeSchedule, normalizeSize, sizeToMm } from "./normalize";

/**
 * Configurable industrial product specifications for OGS.
 *
 * These schemas are data, not code paths: a category lists the attributes that
 * must be present before a product can be called an exact match. Fasteners keep
 * their separate, versioned deterministic matcher (src/lib/fasteners/spec.ts),
 * so adding industrial categories never changes MFBMT's fastener behaviour.
 */

export type IndustrialCategory = "Pipes" | "Valves" | "Flanges" | "Fittings" | "Chemicals" | "Industrial Spares";

export type IndustrialAttribute = {
  key: string;
  label: string;
  required: boolean;
  /** Numeric attributes are compared with unit-aware normalisation. */
  numeric?: boolean;
  aliases?: string[];
};

export const INDUSTRIAL_SCHEMAS: Record<IndustrialCategory, IndustrialAttribute[]> = {
  Pipes: [
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "nominalSize", label: "Nominal size", required: true },
    { key: "outsideDiameter", label: "Outside diameter", required: true, numeric: true },
    { key: "wallThickness", label: "Wall thickness", required: true, numeric: true },
    { key: "schedule", label: "Schedule", required: true },
    { key: "length", label: "Length", required: false },
    { key: "manufacturingType", label: "Manufacturing type", required: false },
    { key: "standard", label: "Standard", required: true },
    { key: "endPreparation", label: "End preparation", required: true },
    { key: "coating", label: "Coating", required: false },
    { key: "certification", label: "Certification", required: false },
  ],
  Valves: [
    { key: "valveType", label: "Valve type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "pressureClass", label: "Pressure class", required: true },
    { key: "endConnection", label: "End connection", required: true },
    { key: "bodyMaterial", label: "Body material", required: true },
    { key: "trimMaterial", label: "Trim material", required: true },
    { key: "operation", label: "Operation type", required: true },
    { key: "standard", label: "Applicable standard", required: true },
    { key: "testing", label: "Testing / certification", required: false },
  ],
  Flanges: [
    { key: "flangeType", label: "Flange type", required: true },
    { key: "nominalSize", label: "Nominal size", required: true },
    { key: "pressureClass", label: "Pressure class", required: true },
    { key: "facing", label: "Facing", required: true },
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "standard", label: "Standard", required: true },
    { key: "dimensions", label: "Dimensions", required: false },
  ],
  Fittings: [
    { key: "fittingType", label: "Fitting type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "schedule", label: "Schedule", required: true },
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "connection", label: "Connection type", required: true },
    { key: "standard", label: "Standard", required: true },
  ],
  Chemicals: [
    { key: "productName", label: "Product name", required: true },
    { key: "manufacturer", label: "Manufacturer", required: false },
    { key: "casNumber", label: "CAS number", required: false },
    { key: "chemicalGrade", label: "Chemical grade", required: true },
    { key: "purity", label: "Purity / concentration", required: true },
    { key: "physicalForm", label: "Physical form", required: true },
    { key: "packaging", label: "Packaging", required: true },
    { key: "quantity", label: "Quantity", required: true, numeric: true },
    { key: "unit", label: "Unit", required: true },
    { key: "sds", label: "SDS / MSDS", required: false },
    { key: "coa", label: "Certificate of Analysis", required: false },
    { key: "hazardClass", label: "Hazardous-material details", required: false },
  ],
  "Industrial Spares": [
    { key: "manufacturer", label: "Manufacturer", required: true },
    { key: "partNumber", label: "Part number", required: true },
    { key: "model", label: "Model", required: false },
    { key: "compatibleEquipment", label: "Compatible equipment", required: true },
    { key: "specifications", label: "Specifications", required: true },
    { key: "documentation", label: "Documentation", required: false },
  ],
};

const CATEGORY_ALIASES: Array<{ match: RegExp; category: IndustrialCategory }> = [
  // Fittings must be checked before the generic "pipe" match: "Pipe Fittings"
  // is a fitting, never a pipe.
  { match: /\bfitting|\belbow|\btee\b|\breducer|\bcoupling/i, category: "Fittings" },
  { match: /\bpipes?\b/i, category: "Pipes" },
  { match: /\bvalve/i, category: "Valves" },
  { match: /\bflange/i, category: "Flanges" },
  { match: /\bchemical|\bsolvent|\bacids?\b|\bcaustic/i, category: "Chemicals" },
  { match: /\bspares?\b|\bspare parts?|\bbearings?\b|\bseals?\b|\bgaskets?\b/i, category: "Industrial Spares" },
];

export function resolveIndustrialCategory(category: string | null | undefined): IndustrialCategory | null {
  if (!category) return null;
  for (const alias of CATEGORY_ALIASES) {
    if (alias.match.test(category)) return alias.category;
  }
  return null;
}

export function schemaFor(category: string | null | undefined): IndustrialAttribute[] | null {
  const resolved = resolveIndustrialCategory(category);
  return resolved ? INDUSTRIAL_SCHEMAS[resolved] : null;
}

export function requiredAttributes(category: string | null | undefined): IndustrialAttribute[] {
  return (schemaFor(category) ?? []).filter((attribute) => attribute.required);
}

export type IndustrialMatchStatus = "EXACT" | "EQUIVALENT" | "INSUFFICIENT" | "NO_MATCH";

export type IndustrialMatch = {
  status: IndustrialMatchStatus;
  reasons: string[];
  mismatches: string[];
  missing: string[];
  usedEquivalence: boolean;
};

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function sameValue(attribute: IndustrialAttribute, requested: string, offered: string): boolean {
  if (attribute.numeric) {
    const requestedMm = sizeToMm(requested);
    const offeredMm = sizeToMm(offered);
    if (requestedMm != null && offeredMm != null) return Math.abs(requestedMm - offeredMm) < 0.01;
    const a = Number(requested.replace(/[^0-9.]+/g, ""));
    const b = Number(offered.replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  switch (attribute.key) {
    case "size":
      return (normalizeSize(requested) ?? "").toUpperCase() === (normalizeSize(offered) ?? "").toUpperCase();
    case "schedule":
      return normalizeSchedule(requested) === normalizeSchedule(offered);
    case "pressureClass":
      return normalizePressure(requested) === normalizePressure(offered);
    case "material":
    case "bodyMaterial":
    case "trimMaterial":
      return normalizeMaterial(requested) === normalizeMaterial(offered);
    default:
      return requested.replace(/\s+/g, " ").toUpperCase() === offered.replace(/\s+/g, " ").toUpperCase();
  }
}

/**
 * Deterministic comparison. A cheap incompatible product can never be promoted
 * by price: a conflict on a required attribute is NO_MATCH, and absent required
 * information is INSUFFICIENT. Approving a material substitution requires an
 * explicit equivalence rule.
 */
export function compareIndustrialSpec(
  category: string | null | undefined,
  requested: Record<string, string | null | undefined>,
  offered: Record<string, string | null | undefined>,
  options: {
    equivalences?: Array<{
      requestedMaterial: string;
      offeredMaterial: string;
      requestedGrade?: string;
      offeredGrade?: string;
      reason?: string | null;
    }>;
  } = {},
): IndustrialMatch {
  const schema = schemaFor(category);
  if (!schema) {
    return { status: "INSUFFICIENT", reasons: [], mismatches: [], missing: ["Product category"], usedEquivalence: false };
  }

  const reasons: string[] = [];
  const mismatches: string[] = [];
  const missing: string[] = [];
  let usedEquivalence = false;

  for (const attribute of schema) {
    const requiredValue = text(requested[attribute.key]);
    const offeredValue = text(offered[attribute.key]);
    if (!attribute.required) continue;
    if (!requiredValue) {
      missing.push(attribute.label);
      continue;
    }
    if (!offeredValue) {
      missing.push(attribute.label);
      continue;
    }
    if (sameValue(attribute, requiredValue, offeredValue)) {
      reasons.push(`${attribute.label} matches (${offeredValue})`);
      continue;
    }

    if (attribute.key === "material" || attribute.key === "bodyMaterial") {
      const rule = (options.equivalences ?? []).find(
        (entry) =>
          normalizeMaterial(entry.requestedMaterial) === normalizeMaterial(requiredValue) &&
          normalizeMaterial(entry.offeredMaterial) === normalizeMaterial(offeredValue) &&
          (!entry.requestedGrade || entry.requestedGrade === text(requested.grade)) &&
          (!entry.offeredGrade || entry.offeredGrade === text(offered.grade)),
      );
      if (rule) {
        usedEquivalence = true;
        reasons.push(
          rule.reason
            ? `Approved substitution ${requiredValue} → ${offeredValue}: ${rule.reason}`
            : `Approved substitution ${requiredValue} → ${offeredValue}`,
        );
        continue;
      }
    }

    mismatches.push(`${attribute.label} differs: requested ${requiredValue}, offered ${offeredValue}`);
  }

  if (mismatches.length > 0) {
    return { status: "NO_MATCH", reasons, mismatches, missing, usedEquivalence };
  }
  if (missing.length > 0) {
    return { status: "INSUFFICIENT", reasons, mismatches, missing, usedEquivalence };
  }
  return { status: usedEquivalence ? "EQUIVALENT" : "EXACT", reasons, mismatches, missing, usedEquivalence };
}
