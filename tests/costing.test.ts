import { describe, expect, it } from "vitest";
import { computeLandedCost } from "../src/lib/costing/landed";
import { rankOffers, evaluateOffer, type RankableOffer } from "../src/lib/costing/ranking";
import { resolvePricingRule, sellingPriceFromCost, marginPct } from "../src/lib/pricing/rules";

function landed(overrides: Partial<Parameters<typeof computeLandedCost>[0]> = {}) {
  return computeLandedCost({
    unitPrice: 12,
    currency: "AED",
    quantity: 10,
    moq: null,
    shippingCost: 20,
    otherCharges: 0,
    taxes: 0,
    fxRate: null,
    targetCurrency: "AED",
    taxEnabled: false,
    ...overrides,
  });
}

describe("landed cost", () => {
  it("sums goods, shipping and known charges", () => {
    const cost = landed();
    expect(cost.productCost).toBe(120);
    expect(cost.total).toBe(140);
    expect(cost.complete).toBe(true);
    expect(cost.missing).toHaveLength(0);
  });

  it("uses the MOQ quantity when the supplier imposes a higher minimum", () => {
    const cost = landed({ unitPrice: 10, moq: 50, shippingCost: 25 });
    expect(cost.effectiveQuantity).toBe(50);
    expect(cost.productCost).toBe(500);
    expect(cost.total).toBe(525);
  });

  it("marks an offer with unknown shipping as incomplete instead of guessing", () => {
    const cost = landed({ shippingCost: null });
    expect(cost.complete).toBe(false);
    expect(cost.missing).toContain("Shipping");
    // No total is reported at all: an incomplete estimate is never presented as a cost.
    expect(cost.total).toBeNull();
  });

  it("will not compare currencies without a recorded exchange rate", () => {
    const cost = landed({ currency: "USD", shippingCost: 0, fxRate: null });
    expect(cost.complete).toBe(false);
    expect(cost.missing).toContain("Exchange rate");
    expect(cost.total).toBeNull();
  });

  it("converts using a supplied rate and records it", () => {
    const cost = landed({ currency: "USD", shippingCost: 0, fxRate: 3.6725, fxSource: "test" });
    expect(cost.total).toBeCloseTo(440.7, 1);
    expect(cost.fx?.rate).toBe(3.6725);
  });

  it("adds a tax line only when the supplier states one", () => {
    const withTax = landed({ taxes: 10, taxEnabled: true });
    expect(withTax.total).toBe(150);
    const taxNotCompared = landed({ taxes: null, taxEnabled: false });
    expect(taxNotCompared.complete).toBe(true);
    expect(taxNotCompared.total).toBe(140);
  });

  it("treats an unstated supplier tax as unknown, not as zero, when tax is part of the comparison", () => {
    const unknownTax = landed({ taxes: null, taxEnabled: true });
    expect(unknownTax.complete).toBe(false);
    expect(unknownTax.missing).toContain("Supplier tax");
    expect(unknownTax.total).toBeNull();
  });

  it("discloses MOQ overbuy instead of silently buying the requested quantity", () => {
    const cost = landed({ unitPrice: 10, moq: 50, shippingCost: 25 });
    expect(cost.effectiveQuantity).toBe(50);
    expect(cost.excessQuantity).toBe(40);
    expect(cost.notes.join(" ")).toMatch(/minimum order/i);
  });
});

function offer(overrides: Partial<RankableOffer>): RankableOffer {
  return {
    id: overrides.id ?? "o1",
    supplierName: overrides.supplierName ?? "Supplier",
    matchStatus: overrides.matchStatus ?? "EXACT",
    unitPrice: overrides.unitPrice ?? 12,
    currency: overrides.currency ?? "AED",
    moq: overrides.moq ?? null,
    quantityAvailable: overrides.quantityAvailable ?? null,
    leadTimeDays: overrides.leadTimeDays ?? 3,
    validityDate: overrides.validityDate ?? null,
    supplierStatus: overrides.supplierStatus ?? "ACTIVE",
    landed:
      overrides.landed ??
      computeLandedCost({
        unitPrice: overrides.unitPrice ?? 12,
        currency: "AED",
        quantity: 10,
        moq: overrides.moq ?? null,
        shippingCost: 20,
        otherCharges: 0,
        taxes: 0,
        fxRate: null,
        targetCurrency: "AED",
        taxEnabled: false,
      }),
  };
}

describe("offer eligibility and ranking", () => {
  it("rejects a possible match as ineligible", () => {
    const evaluation = evaluateOffer(offer({ matchStatus: "POSSIBLE" }), { requiredQuantity: 10 });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers.join(" ")).toMatch(/possible match/i);
  });

  it("keeps an MOQ above the requested quantity eligible but discloses the overbuy", () => {
    const evaluation = evaluateOffer(
      offer({ id: "b", unitPrice: 10, moq: 50, landed: landed({ unitPrice: 10, moq: 50, shippingCost: 25 }) }),
      { requiredQuantity: 10 },
    );
    // The brief is explicit: do not auto-reject on MOQ. The owner sees the outlay.
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.overbuy).toEqual({ effectiveQuantity: 50, excessQuantity: 40 });
    expect(evaluation.reasons.join(" ")).toMatch(/minimum|MOQ/i);
  });

  it("rejects an expired quotation", () => {
    const evaluation = evaluateOffer(
      offer({ validityDate: new Date(Date.now() - 24 * 60 * 60 * 1000) }),
      { requiredQuantity: 10 },
    );
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers.join(" ")).toMatch(/expired/i);
  });

  it("rejects an offer that cannot meet the requested delivery date", () => {
    const evaluation = evaluateOffer(offer({ leadTimeDays: 20 }), {
      requiredQuantity: 10,
      requiredBy: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    expect(evaluation.eligible).toBe(false);
  });

  it("ranks the cheapest eligible total first, not the cheapest unit price", () => {
    const cheapWithHighMoq = offer({
      id: "cheap",
      supplierName: "Supplier B",
      unitPrice: 10,
      moq: 50,
      landed: landed({ unitPrice: 10, moq: 50, shippingCost: 25 }),
    });
    const dearerButEligible = offer({
      id: "dearer",
      supplierName: "Supplier A",
      unitPrice: 12,
      landed: landed({ unitPrice: 12, shippingCost: 20 }),
    });
    const ranked = rankOffers([cheapWithHighMoq, dearerButEligible], { requiredQuantity: 10 });
    // 50 × 10 + 25 = 525 outlay vs 10 × 12 + 20 = 140: the cheaper unit price is
    // not the cheaper purchase, and both remain visible and comparable.
    expect(ranked[0].offer.id).toBe("dearer");
    expect(ranked[0].rank).toBe(1);
    expect(ranked.find((entry) => entry.offer.id === "cheap")?.rank).toBe(2);
    expect(ranked.find((entry) => entry.offer.id === "cheap")?.evaluation.overbuy?.excessQuantity).toBe(40);
  });

  it("does not rank an offer whose total cost is incomplete", () => {
    const incomplete = offer({
      id: "incomplete",
      unitPrice: 9,
      landed: landed({ unitPrice: 9, shippingCost: null }),
    });
    const complete = offer({ id: "complete", unitPrice: 12 });
    const ranked = rankOffers([incomplete, complete], { requiredQuantity: 10 });
    expect(ranked[0].offer.id).toBe("complete");
    expect(ranked.find((entry) => entry.offer.id === "incomplete")?.evaluation.rankable).toBe(false);
  });
});

describe("pricing rules", () => {
  it("prefers a category rule over the global rule", () => {
    const rule = resolvePricingRule(
      [
        { id: "g", scope: "GLOBAL", category: null, type: "PERCENT_MARKUP", value: 10, priority: 100, isActive: true },
        { id: "c", scope: "CATEGORY", category: "Valves", type: "PERCENT_MARKUP", value: 25, priority: 10, isActive: true },
      ],
      "Valves",
    );
    expect(rule?.id).toBe("c");
  });

  it("applies percentage and fixed markups", () => {
    const cost = 100;
    expect(sellingPriceFromCost(cost, { id: "1", scope: "GLOBAL", category: null, type: "PERCENT_MARKUP", value: 18, priority: 1, isActive: true })).toBe(118);
    expect(sellingPriceFromCost(cost, { id: "2", scope: "GLOBAL", category: null, type: "FIXED_MARKUP", value: 15, priority: 1, isActive: true })).toBe(115);
  });

  it("requires a manual price when the rule is manual", () => {
    const manual = { id: "m", scope: "GLOBAL", category: null, type: "MANUAL", value: 0, priority: 1, isActive: true };
    expect(sellingPriceFromCost(100, manual)).toBeNull();
    expect(sellingPriceFromCost(100, manual, 150)).toBe(150);
  });

  it("never invents a selling price without a cost", () => {
    expect(sellingPriceFromCost(null, { id: "x", scope: "GLOBAL", category: null, type: "PERCENT_MARKUP", value: 20, priority: 1, isActive: true })).toBeNull();
  });

  it("calculates margin on the selling price", () => {
    expect(marginPct(100, 125)).toBe(20);
  });
});
