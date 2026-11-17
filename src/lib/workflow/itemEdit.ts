import { db } from "../db";
import { stringifyJson, parseJson } from "../json";
import { finalizeItems } from "../ai/extract";
import { inferCategoryFromDescription } from "../catalog/categories";
import { normalizeUnit, parseQuantity } from "../catalog/normalize";

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
  };
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
  };

  const [finalized] = finalizeItems([merged]);
  const missing = finalized?.missingFields ?? [];

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
      clarificationQuestion: finalized?.clarificationQuestion ?? null,
      reviewStatus: missing.length > 0 ? "NEEDS_CLARIFICATION" : "CONFIRMED",
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
