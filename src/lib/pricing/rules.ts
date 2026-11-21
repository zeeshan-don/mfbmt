export type PricingRuleLike = {
  id: string;
  scope: string;
  category: string | null;
  customerTier?: string | null;
  type: string;
  value: number;
  priority: number;
  isActive: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Category rule first, then a matching customer-tier rule, then the most
 * specific active global rule. A tier-specific rule wins over a generic rule
 * with the same priority.
 */
export function resolvePricingRule(
  rules: PricingRuleLike[],
  category: string | null | undefined,
  customerTier?: string | null,
): PricingRuleLike | null {
  const tier = customerTier?.trim().toUpperCase() || null;
  const active = rules.filter((rule) => rule.isActive && (!rule.customerTier || rule.customerTier === tier));
  const rank = (rule: PricingRuleLike) => (rule.customerTier ? 0 : 1) * 1000 + rule.priority;
  if (category) {
    const byCategory = active
      .filter((rule) => rule.scope === "CATEGORY" && rule.category?.toLowerCase() === category.toLowerCase())
      .sort((a, b) => rank(a) - rank(b));
    if (byCategory[0]) return byCategory[0];
  }
  const global = active.filter((rule) => rule.scope === "GLOBAL").sort((a, b) => rank(a) - rank(b));
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
