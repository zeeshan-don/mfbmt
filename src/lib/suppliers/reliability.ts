import { db } from "../db";

/**
 * Reliability is built only from evidence MFBMT actually recorded.
 * No invented star ratings; when there is no history we say so.
 */
export async function supplierReliability(supplierId: string) {
  const [quotes, offers, completedDeals] = await Promise.all([
    db.supplierQuote.findMany({
      where: { supplierId },
      select: { status: true, createdAt: true, respondedAt: true, sentAt: true },
    }),
    db.supplierOffer.findMany({
      where: { supplierId },
      select: { verificationStatus: true, status: true, quotedAt: true },
    }),
    db.supplierOffer.count({ where: { supplierId, status: "PRICE_CONFIRMED" } }),
  ]);

  const sent = quotes.filter((quote) => quote.sentAt);
  const answered = quotes.filter((quote) => quote.respondedAt);
  const responseDays = answered
    .filter((quote) => quote.sentAt)
    .map((quote) => (quote.respondedAt!.getTime() - quote.sentAt!.getTime()) / (1000 * 60 * 60 * 24));
  const averageResponseDays =
    responseDays.length > 0 ? Math.round((responseDays.reduce((a, b) => a + b, 0) / responseDays.length) * 10) / 10 : null;

  const lastInteraction = [...quotes.map((q) => q.respondedAt ?? q.sentAt ?? q.createdAt), ...offers.map((o) => o.quotedAt)]
    .filter(Boolean)
    .sort((a, b) => (b as Date).getTime() - (a as Date).getTime())[0] as Date | undefined;

  const verifiedPrices = offers.filter((offer) => offer.verificationStatus === "VERIFIED").length;

  return {
    hasHistory: quotes.length > 0 || offers.length > 0,
    quotesRequested: quotes.length,
    quotesSent: sent.length,
    quotesAnswered: answered.length,
    responseRate: sent.length > 0 ? Math.round((answered.length / sent.length) * 100) : null,
    averageResponseDays,
    offersRecorded: offers.length,
    verifiedPrices,
    priceConfirmedOffers: completedDeals,
    lastInteraction: lastInteraction ?? null,
    basis: "Recorded by MFBMT only",
  };
}
