import type { LandedCost } from "./landed";

export type RankableOffer = {
  id: string;
  supplierName: string;
  matchStatus: string;
  unitPrice: number | null;
  currency: string | null;
  moq: number | null;
  quantityAvailable: number | null;
  leadTimeDays: number | null;
  validityDate: Date | null;
  supplierStatus?: string | null;
  landed: LandedCost;
};

export type Evaluation = {
  /** Nothing disqualifies this offer from being chosen. */
  eligible: boolean;
  /** Eligible *and* the total cost is complete, so it can be compared. */
  rankable: boolean;
  reasons: string[];
  blockers: string[];
  /** Disclosed overbuy caused by the supplier's MOQ. */
  overbuy: { excessQuantity: number; effectiveQuantity: number } | null;
};

export type RankInput = {
  requiredQuantity: number;
  requiredBy?: Date | null;
  now?: Date;
};

/**
 * Eligibility is decided before ranking. An MOQ above the requested quantity is
 * disclosed with the resulting outlay, not treated as an automatic rejection —
 * the owner decides whether the surplus is acceptable.
 */
export function evaluateOffer(offer: RankableOffer, input: RankInput): Evaluation {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const now = input.now ?? new Date();

  if (offer.matchStatus === "EXACT") reasons.push("Specification matches the request exactly.");
  else if (offer.matchStatus === "EQUIVALENT") reasons.push("Specification is an owner-approved equivalent.");
  else if (offer.matchStatus === "POSSIBLE") blockers.push("Specification is only a possible match and must be verified.");
  else if (offer.matchStatus === "INSUFFICIENT") blockers.push("Not enough specification information to treat this as a match.");
  else blockers.push("This offer does not match the requested specification.");

  if (offer.supplierStatus === "BLOCKED") blockers.push("Supplier is blocked.");
  if (offer.unitPrice == null) blockers.push("No price is published or confirmed.");
  if (!offer.landed.currencyKnown) blockers.push("The offer does not state a currency.");

  if (offer.quantityAvailable != null && offer.quantityAvailable < input.requiredQuantity) {
    blockers.push(`Only ${offer.quantityAvailable} available, ${input.requiredQuantity} needed.`);
  }
  if (offer.validityDate && offer.validityDate.getTime() < now.getTime()) {
    blockers.push("This quotation has expired.");
  }
  if (input.requiredBy) {
    if (offer.leadTimeDays == null) {
      blockers.push("Lead time is not confirmed, so the requested delivery date cannot be met reliably.");
    } else {
      const daysAvailable = Math.floor((input.requiredBy.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (offer.leadTimeDays > daysAvailable) {
        blockers.push(`Lead time of ${offer.leadTimeDays} days is later than the requested delivery date.`);
      }
    }
  }

  const overbuy =
    offer.landed.excessQuantity > 0
      ? {
          excessQuantity: offer.landed.excessQuantity,
          effectiveQuantity: offer.landed.effectiveQuantity,
        }
      : null;

  if (overbuy) {
    reasons.push(
      `Buying ${overbuy.effectiveQuantity} because of the supplier's MOQ; ${overbuy.excessQuantity} would remain in stock.`,
    );
  }

  if (offer.landed.missing.length > 0) {
    reasons.push(`Cost is incomplete: ${offer.landed.missing.join(", ").toLowerCase()} not known.`);
  }

  const eligible = blockers.length === 0;
  return {
    eligible,
    rankable: eligible && offer.landed.complete && offer.landed.total != null,
    reasons,
    blockers,
    overbuy,
  };
}

export type RankedOffer<T extends RankableOffer> = {
  offer: T;
  evaluation: Evaluation;
  rank: number | null;
};

/**
 * Orders eligible offers by comparable total landed cost. Offers with an
 * incomplete cost stay visible but are never presented as the cheapest option.
 */
export function rankOffers<T extends RankableOffer>(offers: T[], input: RankInput): RankedOffer<T>[] {
  const evaluated = offers.map((offer) => ({
    offer,
    evaluation: evaluateOffer(offer, input),
    rank: null as number | null,
  }));

  const complete = evaluated
    .filter((entry) => entry.evaluation.rankable && entry.offer.landed.total != null)
    .sort((a, b) => (a.offer.landed.total ?? 0) - (b.offer.landed.total ?? 0));

  complete.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const incompleteEligible = evaluated
    .filter((entry) => entry.evaluation.eligible && !entry.evaluation.rankable)
    .sort(
      (a, b) =>
        (a.offer.landed.effectiveUnitCost ?? Number.MAX_SAFE_INTEGER) -
        (b.offer.landed.effectiveUnitCost ?? Number.MAX_SAFE_INTEGER),
    );

  const ineligible = evaluated
    .filter((entry) => !entry.evaluation.eligible)
    .sort(
      (a, b) =>
        (a.offer.landed.effectiveUnitCost ?? Number.MAX_SAFE_INTEGER) -
        (b.offer.landed.effectiveUnitCost ?? Number.MAX_SAFE_INTEGER),
    );

  return [...complete, ...incompleteEligible, ...ineligible];
}

/** Highest-consequence summary for the comparison screen and the approval. */
export function summariseRanking<T extends RankableOffer>(ranked: RankedOffer<T>[]) {
  const cheapest = ranked.find((entry) => entry.rank === 1) ?? null;
  const rankable = ranked.filter((entry) => entry.evaluation.rankable);
  const completeButIneligible = ranked.filter((entry) => entry.offer.landed.complete && !entry.evaluation.eligible);
  return {
    cheapest,
    comparableCount: rankable.length,
    incompleteCount: ranked.filter((entry) => !entry.offer.landed.complete).length,
    mismatchCount: ranked.filter((entry) => !entry.evaluation.eligible).length,
    completeButIneligible: completeButIneligible.length,
    noComparableOffer: rankable.length === 0,
  };
}
