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
  eligible: boolean;
  rankable: boolean;
  reasons: string[];
  blockers: string[];
};

export type RankInput = {
  requiredQuantity: number;
  requiredBy?: Date | null;
  now?: Date;
};

/** Eligibility is decided before ranking. The cheapest offer is only meaningful among eligible offers. */
export function evaluateOffer(offer: RankableOffer, input: RankInput): Evaluation {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const now = input.now ?? new Date();

  if (offer.matchStatus === "EXACT") reasons.push("Specification matches the request exactly.");
  else if (offer.matchStatus === "EQUIVALENT") reasons.push("Specification is an approved equivalent.");
  else if (offer.matchStatus === "POSSIBLE") blockers.push("Specification is only a possible match and must be verified.");
  else if (offer.matchStatus === "INSUFFICIENT") blockers.push("Not enough specification information to treat this as a match.");
  else blockers.push("This offer does not match the requested specification.");

  if (offer.supplierStatus === "BLOCKED") blockers.push("Supplier is blocked.");
  if (offer.unitPrice == null) blockers.push("No price is published or confirmed.");
  if (offer.moq != null && offer.moq > input.requiredQuantity) {
    blockers.push(`Minimum order is ${offer.moq}, but only ${input.requiredQuantity} is needed.`);
  }
  if (offer.quantityAvailable != null && offer.quantityAvailable < input.requiredQuantity) {
    blockers.push(`Only ${offer.quantityAvailable} available, ${input.requiredQuantity} needed.`);
  }
  if (offer.validityDate && offer.validityDate.getTime() < now.getTime()) {
    blockers.push("This quotation has expired.");
  }
  if (input.requiredBy && offer.leadTimeDays != null) {
    const daysAvailable = Math.floor((input.requiredBy.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (offer.leadTimeDays > daysAvailable) {
      blockers.push(`Lead time of ${offer.leadTimeDays} days is later than the requested delivery date.`);
    }
  }
  if (offer.landed.missing.length > 0) {
    reasons.push(`Cost is incomplete: ${offer.landed.missing.join(", ").toLowerCase()} not known.`);
  }

  const eligible = blockers.length === 0;
  return {
    eligible,
    rankable: eligible && offer.landed.complete,
    reasons,
    blockers,
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
  const evaluated = offers.map((offer) => ({ offer, evaluation: evaluateOffer(offer, input), rank: null as number | null }));

  const complete = evaluated
    .filter((entry) => entry.evaluation.rankable && entry.offer.landed.total != null)
    .sort((a, b) => (a.offer.landed.total ?? 0) - (b.offer.landed.total ?? 0));

  complete.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const incompleteEligible = evaluated
    .filter((entry) => entry.evaluation.eligible && !entry.evaluation.rankable)
    .sort((a, b) => (a.offer.unitPrice ?? Number.MAX_SAFE_INTEGER) - (b.offer.unitPrice ?? Number.MAX_SAFE_INTEGER));

  const ineligible = evaluated
    .filter((entry) => !entry.evaluation.eligible)
    .sort((a, b) => (a.offer.unitPrice ?? Number.MAX_SAFE_INTEGER) - (b.offer.unitPrice ?? Number.MAX_SAFE_INTEGER));

  return [...complete, ...incompleteEligible, ...ineligible];
}
