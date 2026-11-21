import type { Supplier } from "@prisma/client";

export type SupplierRankInput = Pick<
  Supplier,
  "id" | "name" | "status" | "doNotContact" | "categories" | "country" | "bouncedAt"
> & {
  responseRate?: number | null;
  averageResponseDays?: number | null;
  verifiedPrices?: number;
  lastQuotedAt?: Date | null;
};

export type RankedSupplier<T extends SupplierRankInput> = {
  supplier: T;
  score: number;
  reasons: string[];
};

function categoriesOf(supplier: SupplierRankInput): string[] {
  try {
    const parsed = JSON.parse(supplier.categories || "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Ranking uses only recorded facts: category overlap, contactability and the
 * company's own response history. It never invents a public rating.
 */
export function rankSuppliersForRequest<T extends SupplierRankInput>(
  suppliers: T[],
  requestedCategory: string | null | undefined,
  requestedCountry?: string | null,
): RankedSupplier<T>[] {
  const requested = requestedCategory?.trim().toLowerCase() ?? "";
  return suppliers
    .map((supplier) => {
      let score = 0;
      const reasons: string[] = [];
      if (supplier.doNotContact || supplier.bouncedAt || supplier.status === "BLOCKED") {
        return { supplier, score: -1000, reasons: ["do not contact"] };
      }
      if (supplier.status === "ACTIVE") {
        score += 20;
        reasons.push("active supplier");
      } else if (supplier.status === "UNVERIFIED") {
        score += 5;
      }
      if (requested && categoriesOf(supplier).some((category) => category.trim().toLowerCase() === requested)) {
        score += 40;
        reasons.push(`recorded category ${requestedCategory}`);
      }
      if (requestedCountry && supplier.country?.trim().toLowerCase() === requestedCountry.trim().toLowerCase()) {
        score += 10;
        reasons.push("same country");
      }
      if (supplier.responseRate != null) {
        score += Math.min(20, Math.max(0, supplier.responseRate) / 5);
        if (supplier.responseRate > 0) reasons.push(`${supplier.responseRate}% reply rate`);
      }
      if (supplier.averageResponseDays != null) {
        score += Math.max(0, 10 - supplier.averageResponseDays);
      }
      if (supplier.verifiedPrices) {
        score += Math.min(15, supplier.verifiedPrices * 3);
        reasons.push(`${supplier.verifiedPrices} confirmed price(s)`);
      }
      if (supplier.lastQuotedAt && Date.now() - supplier.lastQuotedAt.getTime() < 365 * 24 * 60 * 60 * 1000) {
        score += 5;
      }
      return { supplier, score: Math.round(score * 10) / 10, reasons };
    })
    .sort((a, b) => b.score - a.score || a.supplier.name.localeCompare(b.supplier.name));
}
