import { inferCategoryFromDescription, type CategoryRule } from "../catalog/categories";
import {
  compareFastenerSpecs,
  isFastenerCategory,
  parseFastenerSpec,
  type FastenerSpec,
} from "../fasteners/spec";
import {
  normalizeGrade,
  normalizeMaterial,
  normalizePressure,
  normalizeSchedule,
  normalizeSize,
  sizeToMm,
} from "../catalog/normalize";

export type MatchStatus = "EXACT" | "EQUIVALENT" | "POSSIBLE" | "INSUFFICIENT" | "NO_MATCH";

export type SpecFields = {
  description: string;
  category?: string | null;
  brand?: string | null;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
  /** Structured fastener specification. Required for the Industrial Fasteners category. */
  fastenerSpec?: FastenerSpec | null;
};

/** An owner-approved substitution such as SS316 → SS316L. */
export type EquivalenceRule = {
  requestedMaterial: string;
  offeredMaterial: string;
  requestedGrade: string;
  offeredGrade: string;
};

export type MatchResult = {
  status: MatchStatus;
  score: number;
  reasons: string[];
  mismatches: string[];
  missing: string[];
  /** True when the match only holds because an owner-approved equivalence exists. */
  usedEquivalence: boolean;
};

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function sizeKey(value: string | null | undefined): string | number | null {
  if (!value) return null;
  const mm = sizeToMm(value);
  if (mm != null) return mm;
  return normalizeSize(value) ?? norm(value);
}

export type MaterialComparison = {
  compatible: boolean;
  /** Same material, or an explicitly approved substitution. */
  equivalent: boolean;
  reason: string | null;
};

/**
 * Materials are only interchangeable when they are the same material or an owner
 * has approved the substitution. SS316 and SS316L differ in carbon content and
 * are never silently treated as the same product.
 */
export function materialsCompatible(
  requested: string,
  offered: string,
  rules: EquivalenceRule[] = [],
  requestedGrade?: string | null,
  offeredGrade?: string | null,
): MaterialComparison {
  const a = normalizeMaterial(requested);
  const b = normalizeMaterial(offered);
  if (!a || !b) {
    return { compatible: false, equivalent: false, reason: "A material is missing on one side." };
  }
  if (a === b) {
    const gradeA = normalizeGrade(requestedGrade ?? null);
    const gradeB = normalizeGrade(offeredGrade ?? null);
    if (gradeA && gradeB && gradeA !== gradeB) {
      return {
        compatible: false,
        equivalent: false,
        reason: `Grade differs: requested ${gradeA}, offered ${gradeB}`,
      };
    }
    return { compatible: true, equivalent: false, reason: null };
  }

  const approved = findEquivalence(a, b, requestedGrade, offeredGrade, rules);
  if (approved) {
    return {
      compatible: true,
      equivalent: true,
      reason: approved.reason
        ? `Approved substitution ${a} → ${b}: ${approved.reason}`
        : `Approved substitution ${a} → ${b}`,
    };
  }
  return {
    compatible: false,
    equivalent: false,
    reason: `${a} is not ${b}. A substitution must be approved by the owner before it can be used.`,
  };
}

export function findEquivalence(
  requestedMaterial: string,
  offeredMaterial: string,
  requestedGrade: string | null | undefined,
  offeredGrade: string | null | undefined,
  rules: Array<EquivalenceRule & { reason?: string | null }>,
): (EquivalenceRule & { reason?: string | null }) | null {
  const a = normalizeMaterial(requestedMaterial);
  const b = normalizeMaterial(offeredMaterial);
  const gradeA = normalizeGrade(requestedGrade ?? null) ?? "";
  const gradeB = normalizeGrade(offeredGrade ?? null) ?? "";
  const materialOnly = rules.filter((rule) => {
    const ruleRequested = normalizeMaterial(rule.requestedMaterial);
    const ruleOffered = normalizeMaterial(rule.offeredMaterial);
    return ruleRequested === a && ruleOffered === b;
  });
  const exact = materialOnly.find(
    (rule) =>
      (rule.requestedGrade || "") === (gradeA || "") && (rule.offeredGrade || "") === (gradeB || ""),
  );
  if (exact) return exact;
  // A rule recorded without grades applies to any grade of those materials.
  return materialOnly.find((rule) => !rule.requestedGrade && !rule.offeredGrade) ?? null;
}

/**
 * Compares a requested product against a candidate (stock item or supplier offer).
 * Technical attributes outrank textual similarity: an SS304 fitting never matches
 * a requested SS316 fitting, and an unknown pressure rating is "not enough info",
 * never an exact match.
 */
export function matchProduct(
  requested: SpecFields,
  candidate: SpecFields & {
    equivalentApproved?: boolean;
    categoryRule?: CategoryRule | null;
  },
  options: { strictStandard?: boolean; equivalences?: EquivalenceRule[] } = {},
): MatchResult {
  const reasons: string[] = [];
  const mismatches: string[] = [];
  const missing: string[] = [];
  let usedEquivalence = false;

  const category =
    candidate.categoryRule ??
    inferCategoryFromDescription(requested.description) ??
    (requested.category ? inferCategoryFromDescription(requested.category) : null);

  const reqCategory = category?.name ?? requested.category ?? null;
  const candCategory =
    (candidate.category ? (inferCategoryFromDescription(candidate.category)?.name ?? candidate.category) : null) ??
    inferCategoryFromDescription(candidate.description)?.name ??
    null;

  // Fasteners are compared deterministically on their structured specification.
  // A generic text score can never turn a wrong pitch, grade or finish into a match.
  // Only a fastener *request* switches to the deterministic fastener matcher. A
  // non-fastener request compared with a fastener listing falls through to the
  // generic path, which reports the category conflict as NO_MATCH.
  const requestedFastener =
    isFastenerCategory(reqCategory) ||
    Boolean(requested.fastenerSpec && requested.fastenerSpec.type);
  if (requestedFastener) {
    const reqSpec =
      requested.fastenerSpec ??
      parseFastenerSpec({
        description: requested.description,
        size: requested.size,
        material: requested.material,
        grade: requested.grade,
        standard: requested.standard,
      });
    const candSpec =
      candidate.fastenerSpec ??
      parseFastenerSpec({
        description: candidate.description,
        size: candidate.size,
        material: candidate.material,
        grade: candidate.grade,
        standard: candidate.standard,
      });
    const comparison = compareFastenerSpecs(reqSpec, candSpec, { equivalences: options.equivalences });
    const score = Math.max(0, 1 - comparison.mismatches.length * 0.25 - comparison.missing.length * 0.2);
    return {
      status: comparison.status,
      score,
      reasons: comparison.reasons,
      mismatches: comparison.mismatches,
      missing: comparison.missing,
      usedEquivalence: comparison.usedEquivalence,
    };
  }

  if (reqCategory && candCategory && reqCategory !== candCategory) {
    mismatches.push(`Different product type (${candCategory} instead of ${reqCategory})`);
  }

  const categoryRequired = new Set(category?.required ?? []);
  const sizeCompare = (a: string, b: string) => {
    const ka = sizeKey(a);
    const kb = sizeKey(b);
    return ka != null && kb != null && ka === kb;
  };
  const strictEq = (a: string, b: string) => norm(a) === norm(b);
  const pressureCompare = (a: string, b: string) => normalizePressure(a) === normalizePressure(b);

  type Check = {
    label: string;
    requested: string | null | undefined;
    candidate: string | null | undefined;
    equal: boolean;
    required: boolean;
    note?: string | null;
  };

  const checks: Check[] = [];

  if (requested.size || categoryRequired.has("size")) {
    checks.push({
      label: "Size",
      requested: requested.size,
      candidate: candidate.size,
      equal: Boolean(requested.size && candidate.size && sizeCompare(requested.size, candidate.size)),
      required: true,
    });
  }

  let materialNote: string | null = null;
  let materialEqual = false;
  let materialEquivalent = false;
  if (requested.material || categoryRequired.has("material")) {
    if (requested.material && candidate.material) {
      const comparison = materialsCompatible(
        requested.material,
        candidate.material,
        options.equivalences ?? [],
        requested.grade,
        candidate.grade,
      );
      materialEqual = comparison.compatible;
      materialEquivalent = comparison.equivalent;
      materialNote = comparison.reason;
      if (comparison.compatible && comparison.equivalent) usedEquivalence = true;
    }
    checks.push({
      label: "Material",
      requested: requested.material,
      candidate: candidate.material,
      equal: materialEqual,
      required: true,
      note: materialNote,
    });
  }

  if (requested.grade || categoryRequired.has("grade")) {
    checks.push({
      label: "Grade",
      requested: requested.grade,
      candidate: candidate.grade,
      equal: Boolean(
        requested.grade &&
          candidate.grade &&
          normalizeGrade(requested.grade) === normalizeGrade(candidate.grade),
      ),
      required: true,
    });
  }
  if (requested.pressureRating || categoryRequired.has("pressureRating")) {
    checks.push({
      label: "Pressure rating",
      requested: requested.pressureRating,
      candidate: candidate.pressureRating,
      equal: Boolean(
        requested.pressureRating &&
          candidate.pressureRating &&
          pressureCompare(requested.pressureRating, candidate.pressureRating),
      ),
      required: true,
    });
  }
  if (requested.schedule) {
    checks.push({
      label: "Schedule",
      requested: requested.schedule,
      candidate: candidate.schedule,
      equal: Boolean(
        requested.schedule &&
          candidate.schedule &&
          normalizeSchedule(requested.schedule) === normalizeSchedule(candidate.schedule),
      ),
      required: false,
    });
  }
  if (requested.standard && options.strictStandard) {
    checks.push({
      label: "Standard",
      requested: requested.standard,
      candidate: candidate.standard,
      equal: Boolean(requested.standard && candidate.standard && strictEq(requested.standard, candidate.standard)),
      required: true,
    });
  }
  if (requested.brand) {
    checks.push({
      label: "Brand",
      requested: requested.brand,
      candidate: candidate.brand,
      equal: Boolean(requested.brand && candidate.brand && strictEq(requested.brand, candidate.brand)),
      required: true,
    });
  }

  let matched = 0;
  let requiredMissing = 0;
  for (const check of checks) {
    if (!check.requested) continue;
    if (!check.candidate) {
      missing.push(check.label);
      if (check.required) requiredMissing += 1;
      continue;
    }
    if (check.equal) {
      matched += 1;
      reasons.push(
        check.note && check.note.length > 0
          ? `${check.label}: ${check.note}`
          : `${check.label} matches (${check.candidate})`,
      );
    } else {
      mismatches.push(
        check.note && check.note.length > 0
          ? `${check.label}: ${check.note}`
          : `${check.label} differs: requested ${check.requested}, offered ${check.candidate}`,
      );
    }
  }

  const reqTokens = new Set(
    requested.description.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
  );
  const candText = `${candidate.description} ${candidate.category ?? ""}`.toLowerCase();
  const overlap = [...reqTokens].filter((token) => candText.includes(token)).length;
  const similarity = reqTokens.size === 0 ? 0 : overlap / reqTokens.size;

  const score = Math.min(
    1,
    (matched / Math.max(1, checks.filter((c) => c.requested).length)) * 0.7 + similarity * 0.3,
  );

  if (mismatches.length > 0) {
    return { status: "NO_MATCH", score, reasons, mismatches, missing, usedEquivalence };
  }
  if (requiredMissing > 0) {
    reasons.push("Some requested specifications are missing from this product.");
    return { status: "INSUFFICIENT", score, reasons, mismatches, missing, usedEquivalence };
  }
  if (checks.filter((c) => c.requested).length > 0 && matched === 0) {
    return { status: "INSUFFICIENT", score, reasons, mismatches, missing, usedEquivalence };
  }
  if (similarity < 0.34) {
    return {
      status: "NO_MATCH",
      score,
      reasons,
      mismatches: ["The product description does not describe the same item"],
      missing,
      usedEquivalence,
    };
  }
  if (missing.length > 0) {
    return { status: "POSSIBLE", score, reasons, mismatches, missing, usedEquivalence };
  }
  if (usedEquivalence || (candidate.equivalentApproved && materialEquivalent)) {
    return { status: "EQUIVALENT", score, reasons, mismatches, missing, usedEquivalence: true };
  }
  return { status: "EXACT", score, reasons, mismatches, missing, usedEquivalence: false };
}

/** Available stock = on hand - reserved. Never negative. */
export function availableQuantity(onHand: number, reserved: number): number {
  return Math.max(0, (Number.isFinite(onHand) ? onHand : 0) - (Number.isFinite(reserved) ? reserved : 0));
}

/** Splits a requirement: only the genuine shortage is sourced. */
export function stockSplit(requested: number, available: number): { fromStock: number; toSource: number } {
  const safeRequested = Math.max(0, requested || 0);
  const safeAvailable = Math.max(0, available || 0);
  const fromStock = Math.min(safeRequested, safeAvailable);
  return { fromStock, toSource: Math.max(0, safeRequested - fromStock) };
}

export const STALE_STOCK_DAYS = 30;

export function isStockStale(lastUpdatedAt: Date | null | undefined, now = new Date()): boolean {
  if (!lastUpdatedAt) return true;
  const diffDays = (now.getTime() - lastUpdatedAt.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > STALE_STOCK_DAYS;
}
