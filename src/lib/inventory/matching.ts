import { inferCategoryFromDescription, type CategoryRule } from "../catalog/categories";
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
};

export type MatchResult = {
  status: MatchStatus;
  score: number;
  reasons: string[];
  mismatches: string[];
  missing: string[];
};

const MATERIAL_EQUIVALENTS: Record<string, string[]> = {
  SS316: ["SS316L"],
  SS304: ["SS304L"],
  MS: ["Carbon Steel"],
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

export function materialsCompatible(requested: string, offered: string): { compatible: boolean; equivalent: boolean } {
  const a = normalizeMaterial(requested);
  const b = normalizeMaterial(offered);
  if (!a || !b) return { compatible: false, equivalent: false };
  if (a === b) return { compatible: true, equivalent: false };
  const family = MATERIAL_EQUIVALENTS[a] ?? [];
  if (family.includes(b)) return { compatible: true, equivalent: false }; // stricter: listed as possible, not exact
  if (a.startsWith("SS") && b.startsWith("SS") && a !== b) return { compatible: false, equivalent: false };
  return { compatible: false, equivalent: false };
}

/**
 * Compares a requested product against a candidate (stock item or supplier offer).
 * Technical attributes outrank textual similarity: an SS304 fitting never matches
 * a requested SS316 fitting, and an unknown pressure rating is "not enough info",
 * never an exact match.
 */
export function matchProduct(
  requested: SpecFields,
  candidate: SpecFields & { equivalentApproved?: boolean; categoryRule?: CategoryRule | null },
  options: { strictStandard?: boolean } = {},
): MatchResult {
  const reasons: string[] = [];
  const mismatches: string[] = [];
  const missing: string[] = [];
  const category =
    candidate.categoryRule ??
    inferCategoryFromDescription(requested.description) ??
    (requested.category ? inferCategoryFromDescription(requested.category) : null);

  const reqCategory = category?.name ?? requested.category ?? null;
  const candCategory =
    (candidate.category ? inferCategoryFromDescription(candidate.category)?.name ?? candidate.category : null) ??
    inferCategoryFromDescription(candidate.description)?.name ??
    null;

  if (reqCategory && candCategory && reqCategory !== candCategory) {
    mismatches.push(`Different product type (${candCategory} instead of ${reqCategory})`);
  }

  const checks: Array<{
    field: keyof SpecFields;
    requested: string | null | undefined;
    candidate: string | null | undefined;
    label: string;
    compare: (a: string, b: string) => boolean;
    required: boolean;
  }> = [];

  const categoryRequired = new Set(category?.required ?? []);
  const sizeCompare = (a: string, b: string) => {
    const ka = sizeKey(a);
    const kb = sizeKey(b);
    return ka != null && kb != null && ka === kb;
  };
  const materialCompare = (a: string, b: string) => materialsCompatible(a, b).compatible;
  const strictEq = (a: string, b: string) => norm(a) === norm(b);
  const pressureCompare = (a: string, b: string) => normalizePressure(a) === normalizePressure(b);

  if (requested.size || categoryRequired.has("size")) {
    checks.push({ field: "size", requested: requested.size, candidate: candidate.size, label: "Size", compare: sizeCompare, required: true });
  }
  if (requested.material || categoryRequired.has("material")) {
    checks.push({
      field: "material",
      requested: requested.material,
      candidate: candidate.material,
      label: "Material",
      compare: materialCompare,
      required: true,
    });
  }
  if (requested.grade || categoryRequired.has("grade")) {
    checks.push({
      field: "grade",
      requested: requested.grade,
      candidate: candidate.grade,
      label: "Grade",
      compare: (a, b) => normalizeGrade(a) === normalizeGrade(b),
      required: true,
    });
  }
  if (requested.pressureRating || categoryRequired.has("pressureRating")) {
    checks.push({
      field: "pressureRating",
      requested: requested.pressureRating,
      candidate: candidate.pressureRating,
      label: "Pressure rating",
      compare: pressureCompare,
      required: true,
    });
  }
  if (requested.schedule) {
    checks.push({
      field: "schedule",
      requested: requested.schedule,
      candidate: candidate.schedule,
      label: "Schedule",
      compare: (a, b) => normalizeSchedule(a) === normalizeSchedule(b),
      required: false,
    });
  }
  if (requested.standard && options.strictStandard) {
    checks.push({
      field: "standard",
      requested: requested.standard,
      candidate: candidate.standard,
      label: "Standard",
      compare: strictEq,
      required: true,
    });
  }
  if (requested.brand) {
    checks.push({
      field: "brand",
      requested: requested.brand,
      candidate: candidate.brand,
      label: "Brand",
      compare: strictEq,
      required: true,
    });
  }

  let matched = 0;
  let requiredMissing = 0;
  for (const check of checks) {
    if (!check.requested) continue; // nothing was requested for this attribute
    if (!check.candidate) {
      missing.push(check.label);
      if (check.required) requiredMissing += 1;
      continue;
    }
    if (check.compare(check.requested, check.candidate)) {
      matched += 1;
      reasons.push(`${check.label} matches (${check.candidate})`);
    } else {
      mismatches.push(`${check.label} differs: requested ${check.requested}, offered ${check.candidate}`);
    }
  }

  // Description similarity gate — avoids matching "hex bolt" to "gate valve".
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
    return { status: "NO_MATCH", score, reasons, mismatches, missing };
  }
  if (requiredMissing > 0) {
    reasons.push("Some requested specifications are missing from this product.");
    return { status: "INSUFFICIENT", score, reasons, mismatches, missing };
  }
  if (checks.filter((c) => c.requested).length > 0 && matched === 0) {
    return { status: "INSUFFICIENT", score, reasons, mismatches, missing };
  }
  if (similarity < 0.34) {
    return {
      status: "NO_MATCH",
      score,
      reasons,
      mismatches: ["The product description does not describe the same item"],
      missing,
    };
  }
  if (missing.length > 0) {
    return { status: "POSSIBLE", score, reasons, mismatches, missing };
  }
  if (candidate.equivalentApproved) {
    return { status: "EQUIVALENT", score, reasons, mismatches, missing };
  }
  return { status: "EXACT", score, reasons, mismatches, missing };
}

/** Available stock = on hand - reserved. Never negative. */
export function availableQuantity(onHand: number, reserved: number): number {
  return Math.max(0, (Number.isFinite(onHand) ? onHand : 0) - (Number.isFinite(reserved) ? reserved : 0));
}

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
