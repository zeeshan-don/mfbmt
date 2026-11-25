import {
  inferCategoryFromDescription,
  type AttributeKey,
} from "../../catalog/categories";
import {
  normalizeGrade,
  normalizeMaterial,
  normalizePressure,
  normalizeSchedule,
  normalizeSize,
  sizeToMm,
} from "../../catalog/normalize";
import {
  parseIndustrialSpecJson,
  requiredAttributes,
  resolveIndustrialCategory,
} from "../../catalog/industrialSpec";
import { parseFastenerSpecJson } from "../../fasteners/spec";
import type {
  ResearchAttributeMatch,
  ResearchEvidenceClaim,
  ResearchEvidenceClaim as EvidenceClaim,
  ResearchProductUnderstanding,
  ResearchQualification,
} from "../../validation/research";
import { ResearchQualificationSchema } from "../../validation/research";

export type ResearchEvidenceRecord = EvidenceClaim & { id: string };

type QualificationItem = {
  description: string;
  category: string | null;
  brand: string | null;
  size: string | null;
  material: string | null;
  grade: string | null;
  pressureRating: string | null;
  schedule: string | null;
  standard: string | null;
  industrialSpecJson: string | null;
  fastenerSpecJson: string | null;
  missingFields?: string;
};

type EquivalenceRule = {
  requestedMaterial: string;
  offeredMaterial: string;
  requestedGrade: string;
  offeredGrade: string;
  reason?: string | null;
};

const STRONG_SOURCES = new Set(["PAGE", "PDF", "SPREADSHEET", "OCR", "VISION", "INTERNAL"]);

function strong(claim: ResearchEvidenceClaim): boolean {
  return STRONG_SOURCES.has(claim.sourceType) && ["SUPPORTED", "INDIRECT"].includes(claim.verificationStatus);
}

function normal(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function comparable(field: string, requested: string, offered: string): boolean {
  const a = requested.trim();
  const b = offered.trim();
  if (!a || !b) return false;
  switch (field) {
    case "material":
      return normalizeMaterial(a) === normalizeMaterial(b);
    case "grade":
      return normalizeGrade(a) === normalizeGrade(b);
    case "size":
      return (sizeToMm(a) ?? normalizeSize(a)) === (sizeToMm(b) ?? normalizeSize(b));
    case "pressureRating":
      return normalizePressure(a) === normalizePressure(b);
    case "schedule":
      return normalizeSchedule(a) === normalizeSchedule(b);
    case "standard":
      // A standard is never treated as equivalent by similarity. Matching the
      // same designation is evidence; a different one is a conflict.
      return normal(a) === normal(b);
    case "connection":
    case "finish":
    case "brand":
      return normal(a) === normal(b);
    default:
      return normal(a) === normal(b);
  }
}

function labelFor(field: string): string {
  const labels: Record<string, string> = {
    material: "Material",
    grade: "Grade",
    size: "Size",
    pressureRating: "Pressure rating",
    schedule: "Schedule",
    standard: "Standard",
    brand: "Brand",
    connection: "Connection type",
    finish: "Finish",
    productFamily: "Product family",
    productName: "Product name",
    certification: "Certification",
  };
  return labels[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

type RequestedAttribute = {
  field: string;
  label: string;
  value: string;
  critical: boolean;
};

function requestedAttributes(item: QualificationItem): RequestedAttribute[] {
  const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
  const resolved = industrial ? resolveIndustrialCategory(industrial.category) : inferCategoryFromDescription(`${item.description} ${item.category ?? ""}`)?.name;
  const required = new Set(
    resolved
      ? requiredAttributes(resolved).map((attribute) => attribute.key)
      : (inferCategoryFromDescription(`${item.description} ${item.category ?? ""}`)?.required ?? []),
  );
  const attrs: RequestedAttribute[] = [];
  const push = (field: string, value: string | null | undefined, critical: boolean, force = false) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed && !force) return;
    if (attrs.some((entry) => entry.field === field)) return;
    attrs.push({ field, label: labelFor(field), value: trimmed, critical });
  };

  const industrialAttributes = industrial?.attributes ?? {};
  const industrialMap: Record<string, string> = {
    material: industrialAttributes.material ?? item.material ?? "",
    bodyMaterial: industrialAttributes.bodyMaterial ?? item.material ?? "",
    trimMaterial: industrialAttributes.trimMaterial ?? "",
    grade: industrialAttributes.grade ?? item.grade ?? "",
    size: industrialAttributes.size ?? industrialAttributes.nominalSize ?? item.size ?? "",
    nominalSize: industrialAttributes.nominalSize ?? industrialAttributes.size ?? item.size ?? "",
    pressureRating: industrialAttributes.pressureRating ?? item.pressureRating ?? "",
    pressureClass: industrialAttributes.pressureClass ?? item.pressureRating ?? "",
    schedule: industrialAttributes.schedule ?? item.schedule ?? "",
    standard: industrialAttributes.standard ?? item.standard ?? "",
    brand: industrialAttributes.manufacturer ?? item.brand ?? "",
    manufacturer: industrialAttributes.manufacturer ?? item.brand ?? "",
    connection: industrialAttributes.connection ?? industrialAttributes.endConnection ?? "",
    endConnection: industrialAttributes.endConnection ?? "",
    finish: industrialAttributes.finish ?? industrialAttributes.coating ?? "",
    coating: industrialAttributes.coating ?? "",
  };

  if (industrial) {
    for (const attribute of requiredAttributes(resolved)) {
      // A required attribute that is absent from the RFQ is an unknown, not a
      // match. It must stay visible so this candidate can never become EXACT.
      push(
        attribute.key,
        industrialMap[attribute.key] ?? industrialAttributes[attribute.key],
        true,
        true,
      );
    }
    // Other explicitly present attributes are optional comparisons, never
    // fabricated. They can create a conflict only when the supplier publishes a
    // different value for the same field.
    for (const [key, value] of Object.entries(industrialAttributes)) {
      if (required.has(key)) continue;
      push(key, value, false);
    }
  } else {
    const fastener = parseFastenerSpecJson(item.fastenerSpecJson);
    if (fastener) {
      push("material", fastener.material ?? item.material, required.has("material"));
      push("grade", fastener.propertyClass ?? item.grade, required.has("grade"));
      push("size", fastener.diameter ?? item.size, true);
      push("standard", fastener.standard ?? item.standard, Boolean(item.standard));
      push("finish", fastener.finish, Boolean(fastener.finish));
      push("brand", item.brand, Boolean(item.brand));
    } else {
      push("material", item.material, required.has("material") || Boolean(item.material));
      push("grade", item.grade, required.has("grade") || Boolean(item.grade));
      push("size", item.size, required.has("size") || Boolean(item.size));
      push("pressureRating", item.pressureRating, required.has("pressureRating") || Boolean(item.pressureRating));
      push("schedule", item.schedule, required.has("schedule") || Boolean(item.schedule));
      push("standard", item.standard, required.has("standard") || Boolean(item.standard));
      push("brand", item.brand, required.has("brand") || Boolean(item.brand));
    }
  }

  // A type variant is represented by the product-family evidence itself. It is
  // deliberately not compared as an exact string: "Fittings" and "elbow" are a
  // family relationship, not proof of an exact product. The technical
  // attributes above decide whether the result can be EXACT.
  const genericRequired: Record<string, string | null | undefined> = {
    size: item.size,
    material: item.material,
    grade: item.grade,
    pressureRating: item.pressureRating,
    schedule: item.schedule,
    standard: item.standard,
    brand: item.brand,
  };
  for (const key of required) {
    if (key === "typeVariant" || !(key in genericRequired)) continue;
    if (attrs.some((entry) => entry.field === key)) continue;
    push(key, genericRequired[key], true, true);
  }
  return attrs;
}

/**
 * Deterministic technical qualification for a supplier candidate.
 *
 * It never promotes a shared product name, a category page, a snippet, or an
 * unknown attribute to EXACT. A known conflict is NO_MATCH even when every other
 * attribute and the commercial relevance look strong.
 */
export function qualifySupplierCandidate(input: {
  item: QualificationItem;
  understanding: ResearchProductUnderstanding;
  evidence: ResearchEvidenceRecord[];
  hasFamilyEvidence?: boolean;
  equivalences?: EquivalenceRule[];
}): ResearchQualification {
  const allEvidence = input.evidence;
  const usable = allEvidence.filter(strong);
  const requested = requestedAttributes(input.item);
  const matching: ResearchAttributeMatch[] = [];
  const missing: ResearchAttributeMatch[] = [];
  const conflicting: ResearchAttributeMatch[] = [];
  let usedApprovedEquivalence = false;

  const claimFor = (field: string): ResearchEvidenceRecord | undefined => {
    const aliases: Record<string, string[]> = {
      material: ["material", "bodyMaterial", "trimMaterial"],
      bodyMaterial: ["bodyMaterial", "material"],
      trimMaterial: ["trimMaterial"],
      size: ["size", "nominalSize", "diameter"],
      nominalSize: ["nominalSize", "size"],
      pressureRating: ["pressureRating", "pressureClass"],
      pressureClass: ["pressureClass", "pressureRating"],
      schedule: ["schedule", "wallThickness"],
      standard: ["standard", "manufacturingStandard"],
      brand: ["brand", "manufacturer"],
      manufacturer: ["manufacturer", "brand"],
      connection: ["connection", "connectionType", "endConnection"],
      endConnection: ["endConnection", "connection", "connectionType"],
      finish: ["finish", "coating"],
      fittingType: ["productFamily", "productCategory", "productName"],
      valveType: ["productFamily", "productCategory", "productName"],
      flangeType: ["productFamily", "productCategory", "productName"],
      gasketType: ["productFamily", "productCategory", "productName"],
      kitType: ["productFamily", "productCategory", "productName"],
      productFamily: ["productFamily", "productCategory", "productName"],
      productName: ["productName", "productFamily", "productCategory"],
    };
    const fields = aliases[field] ?? [field];
    return usable.find((entry) => fields.includes(entry.field) && Boolean(entry.value));
  };

  const familyTerms = [
    input.understanding.productFamily,
    ...input.understanding.commonTerminology,
  ].filter((term): term is string => Boolean(term));
  const familyEvidence =
    input.hasFamilyEvidence === true ||
    usable.some((entry) => {
      if (!["productFamily", "productCategory", "productName"].includes(entry.field)) return false;
      const value = `${entry.value ?? ""} ${entry.excerpt ?? ""}`.toLowerCase();
      return familyTerms.some((term) => value.includes(term.toLowerCase()));
    });

  for (const attribute of requested) {
    if (!attribute.value) {
      missing.push({
        field: attribute.field,
        label: attribute.label,
        requested: null,
        offered: null,
      });
      continue;
    }
    const match = attribute.field === "productFamily" ? undefined : claimFor(attribute.field);
    if (!match || !match.value) {
      missing.push({
        field: attribute.field,
        label: attribute.label,
        requested: attribute.value,
        offered: null,
      });
      continue;
    }

    const exchange = (equivalences: EquivalenceRule[] = []) =>
      equivalences.find(
        (rule) =>
          normalizeMaterial(rule.requestedMaterial) === normalizeMaterial(attribute.value) &&
          normalizeMaterial(rule.offeredMaterial) === normalizeMaterial(match.value ?? "") &&
          (!rule.requestedGrade || normalizeGrade(rule.requestedGrade) === normalizeGrade(claimFor("grade")?.value ?? "")) &&
          (!rule.offeredGrade || normalizeGrade(rule.offeredGrade) === normalizeGrade(claimFor("grade")?.value ?? "")),
      );

    const approved =
      attribute.field === "material" || attribute.field === "bodyMaterial"
        ? exchange(input.equivalences)
        : undefined;

    if (comparable(attribute.field, attribute.value, match.value)) {
      matching.push({
        field: attribute.field,
        label: attribute.label,
        requested: attribute.value,
        offered: match.value,
        evidenceId: match.id,
        sourceUrl: match.sourceUrl,
      });
      continue;
    }

    if (approved) {
      usedApprovedEquivalence = true;
      matching.push({
        field: attribute.field,
        label: attribute.label,
        requested: attribute.value,
        offered: match.value,
        evidenceId: match.id,
        sourceUrl: match.sourceUrl,
      });
      continue;
    }

    conflicting.push({
      field: attribute.field,
      label: attribute.label,
      requested: attribute.value,
      offered: match.value,
      evidenceId: match.id,
      sourceUrl: match.sourceUrl,
    });
  }

  // A product-family claim alone is not proof of a specific product.
  const familyMatch = usable.find((entry) => ["productFamily", "productCategory", "productName"].includes(entry.field));

  if (conflicting.length > 0) {
    return ResearchQualificationSchema.parse({
      status: "NO_MATCH",
      matchingAttributes: matching,
      missingAttributes: missing,
      conflictingAttributes: conflicting,
      evidenceIds: uniqueIds([...matching, ...conflicting]),
      explanation:
        `A published attribute conflicts with the request: ${conflicting
          .map((entry) => `${entry.label} requested ${entry.requested}, published ${entry.offered}`)
          .join("; ")}.`,
      confidence: 0.95,
      usedApprovedEquivalence,
    });
  }

  const criticalMissing = missing.filter((entry) => requested.find((attribute) => attribute.field === entry.field)?.critical);
  const optionalMissing = missing.filter((entry) => !requested.find((attribute) => attribute.field === entry.field)?.critical);

  if (matching.length === 0) {
    const status = familyEvidence ? "POSSIBLE" : "UNVERIFIED";
    return ResearchQualificationSchema.parse({
      status,
      matchingAttributes: [],
      missingAttributes: missing,
      conflictingAttributes: [],
      evidenceIds: familyMatch ? [familyMatch.id] : [],
      explanation: familyEvidence
        ? "The company or page is relevant to the product family, but it does not publish a comparable technical attribute for the requested item."
        : "There is not enough published technical evidence to assess this supplier.",
      confidence: familyEvidence ? 0.35 : 0.1,
      usedApprovedEquivalence,
    });
  }

  if (!familyEvidence) {
    // Technical attributes alone can describe a pipe, a fitting or an unrelated
    // product from the same manufacturer. Without evidence that this is the
    // requested product family, the strongest defensible status is POSSIBLE.
    return ResearchQualificationSchema.parse({
      status: "POSSIBLE",
      matchingAttributes: matching,
      missingAttributes: [
        ...missing,
        {
          field: "productFamily",
          label: "Product family",
          requested: input.understanding.productFamily,
          offered: null,
        },
      ],
      conflictingAttributes: [],
      evidenceIds: uniqueIds(matching),
      explanation:
        "The published technical values look comparable, but the product family was not confirmed on the evidence. It is not treated as an exact match.",
      confidence: 0.55,
      usedApprovedEquivalence,
    });
  }

  if (criticalMissing.length > 0) {
    return ResearchQualificationSchema.parse({
      status: familyEvidence || matching.length > 0 ? "POSSIBLE" : "UNVERIFIED",
      matchingAttributes: matching,
      missingAttributes: missing,
      conflictingAttributes: [],
      evidenceIds: uniqueIds(matching),
      explanation: `Some required attributes are not published: ${criticalMissing.map((entry) => entry.label).join(", ")}. Unknown is not a match.`,
      confidence: Math.min(0.7, 0.35 + matching.length * 0.1),
      usedApprovedEquivalence,
    });
  }

  if (optionalMissing.length > 0) {
    return ResearchQualificationSchema.parse({
      status: "COMPATIBLE",
      matchingAttributes: matching,
      missingAttributes: optionalMissing,
      conflictingAttributes: [],
      evidenceIds: uniqueIds(matching),
      explanation: `All required attributes are supported, but ${optionalMissing.map((entry) => entry.label).join(", ")} is not published. Confirm it before treating this as exact.`,
      confidence: 0.8,
      usedApprovedEquivalence,
    });
  }

  if (usedApprovedEquivalence) {
    return ResearchQualificationSchema.parse({
      status: "COMPATIBLE",
      matchingAttributes: matching,
      missingAttributes: [],
      conflictingAttributes: [],
      evidenceIds: uniqueIds(matching),
      explanation: `The evidence matches through an owner-approved substitution: ${matching
        .map((entry) => `${entry.label} ${entry.offered}`)
        .join(", ")}. It is not an exact manufacturer/specification match.`,
      confidence: 0.8,
      usedApprovedEquivalence: true,
    });
  }

  return ResearchQualificationSchema.parse({
    status: "EXACT",
    matchingAttributes: matching,
    missingAttributes: [],
    conflictingAttributes: [],
    evidenceIds: uniqueIds(matching),
    explanation: `Every required comparable attribute is supported by published evidence: ${matching
      .map((entry) => `${entry.label} ${entry.offered}`)
      .join(", ")}.`,
    confidence: 0.95,
    usedApprovedEquivalence,
  });
}

function uniqueIds(entries: ResearchAttributeMatch[]): string[] {
  return [...new Set(entries.map((entry) => entry.evidenceId).filter((id): id is string => Boolean(id)))];
}

/** Alias used by callers that prefer a verb-first name. */
export const qualifySupplierEvidence = qualifySupplierCandidate;

export function requestedFieldKeys(item: QualificationItem): Array<{ field: string; key: AttributeKey | string; critical: boolean }> {
  return requestedAttributes(item).map((entry) => ({
    field: entry.field,
    key: entry.field,
    critical: entry.critical,
  }));
}
