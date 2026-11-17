export type PricingRuleLike = {
  id: string;
  scope: string;
  category: string | null;
  type: string;
  value: number;
  priority: number;
  isActive: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Category rule first, then the most specific active global rule. */
export function resolvePricingRule(rules: PricingRuleLike[], category: string | null | undefined): PricingRuleLike | null {
  const active = rules.filter((rule) => rule.isActive);
  if (category) {
    const byCategory = active
      .filter((rule) => rule.scope === "CATEGORY" && rule.category?.toLowerCase() === category.toLowerCase())
      .sort((a, b) => a.priority - b.priority);
    if (byCategory[0]) return byCategory[0];
  }
  const global = active.filter((rule) => rule.scope === "GLOBAL").sort((a, b) => a.priority - b.priority);
  return global[0] ?? null;
}

export function sellingPriceFromCost(
  cost: number | null,
  rule: PricingRuleLike | null,
  manualPrice?: number | null,
): number | null {
  if (manualPrice != null && Number.isFinite(manualPrice) && manualPrice >= 0) return round2(manualPrice);
  if (cost == null || !Number.isFinite(cost)) return null;
  if (!rule) return null;
  if (rule.type === "PERCENT_MARKUP") return round2(cost * (1 + rule.value / 100));
  if (rule.type === "FIXED_MARKUP") return round2(cost + rule.value);
  return null; // MANUAL rules require an explicit price
}

export function marginPct(cost: number | null, price: number | null): number | null {
  if (cost == null || price == null || price <= 0) return null;
  return Math.round(((price - cost) / price) * 1000) / 10;
}
