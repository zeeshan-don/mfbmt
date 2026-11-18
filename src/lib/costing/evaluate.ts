import { db } from "../db";
import { stringifyJson } from "../json";
import { getRate } from "./fx";
import { computeLandedCost } from "./landed";
import { rankOffers, summariseRanking, type RankableOffer } from "./ranking";

export type OfferEvaluationSnapshot = {
  rank: number | null;
  eligible: boolean;
  rankable: boolean;
  blockers: string[];
  reasons: string[];
  overbuy: { excessQuantity: number; effectiveQuantity: number } | null;
};

/**
 * Recomputes comparable cost and eligibility for every offer of an item.
 * The snapshot is stored on the offer so the UI, the approval and the audit trail
 * all read the same numbers.
 */
export async function recomputeOffersForItem(enquiryItemId: string) {
  const item = await db.enquiryItem.findUnique({
    where: { id: enquiryItemId },
    include: {
      enquiry: true,
      offers: { include: { supplier: true } },
    },
  });
  if (!item) throw new Error("Enquiry item not found");

  const org = await db.organization.findFirst();
  const targetCurrency = (item.enquiry.currency || org?.defaultCurrency || "AED").toUpperCase();
  const requiredQuantity = item.quantityToSource > 0 ? item.quantityToSource : item.quantity;

  const rateCache = new Map<string, Awaited<ReturnType<typeof getRate>>>();
  const rankables: Array<RankableOffer & { offerId: string }> = [];

  for (const offer of item.offers) {
    // A missing currency is NOT assumed to be the target currency.
    const currency = offer.currency ? offer.currency.toUpperCase() : null;
    let rate: Awaited<ReturnType<typeof getRate>> = null;
    if (currency && currency !== targetCurrency) {
      if (!rateCache.has(currency)) rateCache.set(currency, await getRate(currency, targetCurrency));
      rate = rateCache.get(currency) ?? null;
    }

    const landed = computeLandedCost({
      unitPrice: offer.unitPrice,
      currency,
      quantity: requiredQuantity,
      moq: offer.moq,
      shippingCost: offer.shippingCost,
      otherCharges: offer.otherCharges,
      taxes: offer.taxes,
      fxRate: rate?.rate ?? null,
      fxSource: rate?.source ?? null,
      fxFetchedAt: rate?.fetchedAt ?? null,
      targetCurrency,
      taxEnabled: org?.taxInLandedCost ?? false,
    });

    rankables.push({
      id: offer.id,
      offerId: offer.id,
      supplierName: offer.supplierName,
      matchStatus: offer.matchStatus,
      unitPrice: offer.unitPrice,
      currency,
      moq: offer.moq,
      quantityAvailable: offer.quantityAvailable,
      leadTimeDays: offer.leadTimeDays,
      validityDate: offer.validityDate,
      supplierStatus: offer.supplier?.status ?? null,
      landed,
    });
  }

  const ranked = rankOffers(rankables, {
    requiredQuantity,
    requiredBy: item.enquiry.deliveryDate,
  });

  const byId = new Map(ranked.map((entry) => [entry.offer.id, entry]));

  await Promise.all(
    item.offers.map(async (offer) => {
      const entry = byId.get(offer.id);
      if (!entry) return;
      const snapshot: OfferEvaluationSnapshot = {
        rank: entry.rank,
        eligible: entry.evaluation.eligible,
        rankable: entry.evaluation.rankable,
        blockers: entry.evaluation.blockers,
        reasons: entry.evaluation.reasons,
        overbuy: entry.evaluation.overbuy,
      };
      await db.supplierOffer.update({
        where: { id: offer.id },
        data: {
          landedCostJson: stringifyJson({
            landed: entry.offer.landed,
            evaluation: snapshot,
            requiredQuantity,
            targetCurrency,
          }),
          isEligible: entry.evaluation.eligible,
          procurementQuantity: entry.offer.landed.effectiveQuantity,
          ineligibilityReason:
            entry.evaluation.blockers.length > 0
              ? entry.evaluation.blockers.join(" ")
              : entry.evaluation.eligible && !entry.evaluation.rankable
                ? `Cost information is incomplete: ${entry.offer.landed.missing.join(", ")}.`
                : null,
        },
      });
    }),
  );

  const summary = summariseRanking(ranked);

  return {
    targetCurrency,
    requiredQuantity,
    ranked,
    summary,
    hasRankableOffer: summary.comparableCount > 0,
    hasAnyOffer: ranked.length > 0,
  };
}
