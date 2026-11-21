import { db } from "../db";
import { stringifyJson, parseJson } from "../json";
import { finalizeItems } from "../ai/extract";
import { inferCategoryFromDescription } from "../catalog/categories";
import { normalizeUnit, parseQuantity } from "../catalog/normalize";
import {
  industrialClarificationQuestion,
  industrialSpecFromFields,
  parseIndustrialSpecJson,
} from "../catalog/industrialSpec";
import {
  isFastenerCategory,
  normalizeFinishValue,
  normalizeThreadSeriesValue,
  parseFastenerSpec,
  parseFastenerSpecJson,
  type FastenerSpec,
} from "../fasteners/spec";

/**
 * Applies an owner correction to a product line and recomputes what is still
 * missing. The original extraction snapshot is never overwritten.
 */
export async function updateEnquiryItemValues(input: {
  itemId: string;
  values: {
    description?: string;
    quantity?: number | null;
    unit?: string;
    category?: string | null;
    brand?: string | null;
    size?: string | null;
    material?: string | null;
    grade?: string | null;
    pressureRating?: string | null;
    schedule?: string | null;
    standard?: string | null;
    /** Explicit structured fastener values entered/corrected by the owner. */
    fastenerSpec?: Partial<FastenerSpec> | null;
    /** Owner-entered OGS industrial attributes, keyed by schema attribute. */
    industrialAttributes?: Record<string, string | null> | null;
  };
  /** Set when the owner has reviewed and confirmed the line. */
  confirm?: boolean;
}) {
  const existing = await db.enquiryItem.findUnique({ where: { id: input.itemId } });
  if (!existing) throw new Error("Product line not found");

  const merged = {
    description: (input.values.description ?? existing.description).trim(),
    quantity: input.values.quantity !== undefined ? input.values.quantity : existing.quantity,
    unit: normalizeUnit(input.values.unit ?? existing.unit),
    category:
      input.values.category ?? existing.category ?? inferCategoryFromDescription(existing.description)?.name ?? null,
    brand: input.values.brand !== undefined ? input.values.brand : existing.brand,
    size: input.values.size !== undefined ? input.values.size : existing.size,
    material: input.values.material !== undefined ? input.values.material : existing.material,
    grade: input.values.grade !== undefined ? input.values.grade : existing.grade,
    pressureRating:
      input.values.pressureRating !== undefined ? input.values.pressureRating : existing.pressureRating,
    schedule: input.values.schedule !== undefined ? input.values.schedule : existing.schedule,
    standard: input.values.standard !== undefined ? input.values.standard : existing.standard,
    missingFields: [] as string[],
    confidence: parseJson<Record<string, number>>(existing.confidence, {}),
    sourceRef: existing.sourceRef,
    fastenerSpec:
      parseFastenerSpecJson(existing.fastenerSpecJson) ??
      (isFastenerCategory(existing.category)
        ? parseFastenerSpec({
            description: (input.values.description ?? existing.description).trim(),
            size: input.values.size !== undefined ? input.values.size : existing.size,
            material: input.values.material !== undefined ? input.values.material : existing.material,
            grade: input.values.grade !== undefined ? input.values.grade : existing.grade,
            standard: input.values.standard !== undefined ? input.values.standard : existing.standard,
          })
        : null),
  };

  // An owner correction is authoritative for the fields supplied; unfilled fields
  // keep the structured values the line already had.
  if (input.values.fastenerSpec) {
    const parsed = parseFastenerSpec({
      description: merged.description,
      size: merged.size,
      material: merged.material,
      grade: merged.grade,
      standard: merged.standard,
    });
    const supplied = Object.fromEntries(
      Object.entries(input.values.fastenerSpec).filter(([, value]) => value != null && value !== ""),
    ) as Partial<FastenerSpec>;
    if (supplied.finish) supplied.finish = normalizeFinishValue(supplied.finish) as never;
    if (supplied.threadSeries) supplied.threadSeries = normalizeThreadSeriesValue(supplied.threadSeries) as never;
    merged.fastenerSpec = { ...(merged.fastenerSpec ?? parsed), ...supplied, version: parsed.version };
  } else if (merged.fastenerSpec && !existing.fastenerSpecJson) {
    // A correction to description/size/material can complete a fastener line.
    merged.fastenerSpec = parseFastenerSpec({
      description: merged.description,
      size: merged.size,
      material: merged.material,
      grade: merged.grade,
      standard: merged.standard,
    });
  }

  const [finalized] = finalizeItems([{ ...merged, fastenerSpec: merged.fastenerSpec ?? undefined }]);
  const missing = [...(finalized?.missingFields ?? [])];
  const spec = finalized?.fastenerSpec ?? merged.fastenerSpec ?? null;

  // OGS lines keep their versioned industrial specification through owner
  // corrections. Only stated values are recorded; clearing a field makes it
  // missing again instead of silently retaining a stale value.
  const existingIndustrial = parseIndustrialSpecJson(existing.industrialSpecJson);
  let industrialSpec = existingIndustrial;
  if (existingIndustrial) {
    industrialSpec = industrialSpecFromFields(
      existingIndustrial.category,
      {
        description: merged.description,
        size: merged.size,
        material: merged.material,
        grade: merged.grade,
        pressureRating: merged.pressureRating,
        schedule: merged.schedule,
        standard: merged.standard,
        brand: merged.brand,
        quantity: merged.quantity,
        unit: merged.unit,
        otherSpecs: Object.fromEntries(
          Object.entries({
            ...existingIndustrial.attributes,
            ...(input.values.industrialAttributes ?? {}),
          }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
        ),
      },
      { source: input.values.industrialAttributes || input.confirm ? "MANUAL" : "EXTRACTED" },
    );
    for (const label of industrialSpec?.missingRequired ?? []) {
      if (!missing.some((entry) => entry.toLowerCase() === label.toLowerCase())) missing.push(label);
    }
  }

  const updated = await db.enquiryItem.update({
    where: { id: existing.id },
    data: {
      description: merged.description,
      quantity: merged.quantity ?? 0,
      unit: merged.unit,
      category: merged.category,
      brand: merged.brand,
      size: finalized?.size ?? merged.size,
      material: finalized?.material ?? merged.material,
      grade: finalized?.grade ?? merged.grade,
      pressureRating: finalized?.pressureRating ?? merged.pressureRating,
      schedule: finalized?.schedule ?? merged.schedule,
      standard: finalized?.standard ?? merged.standard,
      missingFields: stringifyJson(missing),
      clarificationQuestion:
        industrialSpec && missing.length > 0
          ? industrialClarificationQuestion(industrialSpec, merged.description) ?? finalized?.clarificationQuestion ?? null
          : finalized?.clarificationQuestion ?? null,
      reviewStatus: missing.length > 0 ? "NEEDS_CLARIFICATION" : "CONFIRMED",
      industrialSpecJson: industrialSpec ? stringifyJson(industrialSpec) : null,
      fastenerSpecJson: spec ? stringifyJson(spec) : null,
      fastenerType: spec?.type ?? null,
      diameter: spec?.diameter ?? null,
      threadSeries: spec?.threadSeries ?? null,
      pitchMm: spec?.pitchMm ?? null,
      lengthMm: spec?.lengthMm ?? null,
      propertyClass: spec?.propertyClass ?? null,
      finish: spec?.finish ?? null,
      specSource:
        input.values.fastenerSpec || input.values.industrialAttributes || input.confirm
          ? "MANUAL"
          : existing.specSource,
      specConfirmedAt: input.confirm ? new Date() : existing.specConfirmedAt,
    },
  });

  return { item: updated, missing };
}

/** Converts a stored "quantity" field from the form, accepting "10 pcs" too. */
export function parseQuantityInput(raw: string): { quantity: number | null; unit: string | null } {
  const direct = Number(raw.replace(",", "").trim());
  if (Number.isFinite(direct) && raw.trim() !== "" && /^\d+(?:[.,]\d+)?$/.test(raw.trim())) {
    return { quantity: direct, unit: null };
  }
  return parseQuantity(raw);
}
