import { db } from "../db";

export type PriceMemoryEntry = {
  source: "OFFER" | "QUOTE" | "CUSTOMER";
  supplier: string | null;
  description: string;
  unitPrice: number | null;
  currency: string;
  unit: string;
  quotedAt: Date;
  reference: string | null;
  href: string | null;
};

function searchTokens(description: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "inch", "size", "pcs", "piece", "pieces", "type", "class"]);
  return [...new Set(
    description
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((token) => token.length >= 4 && !stop.has(token)),
  )]
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
}

/**
 * Prior recorded prices for a similar description. This is history, not a
 * current supplier quote; the UI labels it with its source and date.
 */
export async function priceMemoryForDescription(description: string, limit = 6): Promise<PriceMemoryEntry[]> {
  const tokens = searchTokens(description);
  if (tokens.length === 0) return [];

  const [offers, quoteItems, customerItems] = await Promise.all([
    db.supplierOffer.findMany({
      where: {
        OR: tokens.map((token) => ({ productTitle: { contains: token, mode: "insensitive" as const } })),
        unitPrice: { not: null },
      },
      orderBy: { quotedAt: "desc" },
      take: limit,
      include: { supplier: { select: { name: true } } },
    }),
    db.supplierQuoteItem.findMany({
      where: {
        OR: tokens.map((token) => ({ description: { contains: token, mode: "insensitive" as const } })),
        unitPrice: { not: null },
      },
      orderBy: { id: "desc" },
      take: limit,
    }),
    db.customerQuotationItem.findMany({
      where: {
        OR: tokens.map((token) => ({ description: { contains: token, mode: "insensitive" as const } })),
        unitPrice: { not: null },
      },
      orderBy: { id: "desc" },
      take: limit,
    }),
  ]);

  const [quotes, quotations] = await Promise.all([
    quoteItems.length
      ? db.supplierQuote.findMany({
          where: { id: { in: [...new Set(quoteItems.map((item) => item.quoteId))] } },
          include: { supplier: { select: { name: true } } },
        })
      : [],
    customerItems.length
      ? db.customerQuotation.findMany({
          where: { id: { in: [...new Set(customerItems.map((item) => item.quotationId))] } },
        })
      : [],
  ]);
  const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
  const quotationById = new Map(quotations.map((quotation) => [quotation.id, quotation]));

  return [
    ...offers.map((offer) => ({
      source: "OFFER" as const,
      supplier: offer.supplier?.name ?? offer.supplierName,
      description: offer.productTitle,
      unitPrice: offer.unitPrice,
      currency: offer.currency ?? "AED",
      unit: "unit",
      quotedAt: offer.quotedAt ?? offer.createdAt,
      reference: offer.quoteRef,
      href: offer.enquiryItemId ? `/sourcing/${offer.enquiryItemId}` : null,
    })),
    ...quoteItems.flatMap((item) => {
      const quote = quoteById.get(item.quoteId);
      if (!quote) return [];
      return [{
        source: "QUOTE" as const,
        supplier: quote.supplier.name,
        description: item.description,
        unitPrice: item.unitPrice,
        currency: item.currency ?? "AED",
        unit: item.unit,
        quotedAt: quote.createdAt,
        reference: quote.correlationToken,
        href: quote.enquiryItemId ? `/sourcing/${quote.enquiryItemId}` : null,
      }];
    }),
    ...customerItems.flatMap((item) => {
      const quotation = quotationById.get(item.quotationId);
      if (!quotation) return [];
      return [{
        source: "CUSTOMER" as const,
        supplier: quotation.customerName,
        description: item.description,
        unitPrice: item.unitPrice,
        currency: "AED",
        unit: item.unit,
        quotedAt: quotation.createdAt,
        reference: quotation.quoteNumber,
        href: item.enquiryItemId ? `/enquiries/${item.enquiryItemId}` : null,
      }];
    }),
  ]
    .sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime())
    .slice(0, limit);
}
