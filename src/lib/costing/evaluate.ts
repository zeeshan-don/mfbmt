import { db } from "../db";
import { stringifyJson } from "../json";
import { getRate } from "./fx";
import { computeLandedCost } from "./landed";
import { evaluateOffer, rankOffers, type RankableOffer } from "./ranking";

export type OfferEvaluationSnapshot = {
  rank: number | null;
  eligible: boolean;
  blockers: string[];
  reasons: string[];
};

/**
 * Recomputes comparable cost and eligibility for every offer of an item.
 * The snapshot is stored on the offer so the UI, approvals and audit trail all
 * read the same numbers.
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
    const currency = (offer.currency ?? targetCurrency).toUpperCase();
    if (!rateCache.has(currency)) {
      rateCache.set(currency, await getRate(currency, targetCurrency));
    }
    const rate = rateCache.get(currency) ?? null;
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
      taxEnabled: org?.taxEnabled ?? false,
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
        blockers: entry.evaluation.blockers,
        reasons: entry.evaluation.reasons,
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
          ineligibilityReason:
            entry.evaluation.blockers.length > 0
              ? entry.evaluation.blockers.join(" ")
              : entry.evaluation.eligible && !entry.evaluation.rankable
                ? "Cost information is incomplete."
                : null,
        },
      });
    }),
  );

  const rankableCount = ranked.filter((entry) => entry.evaluation.rankable).length;
  return {
    targetCurrency,
    requiredQuantity,
    ranked,
    hasRankableOffer: rankableCount > 0,
    hasAnyOffer: ranked.length > 0,
  };
}
