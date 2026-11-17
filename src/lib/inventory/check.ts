import { db } from "../db";
import { parseJson, stringifyJson } from "../json";
import { availableQuantity, isStockStale, matchProduct, stockSplit, type MatchResult } from "./matching";

const STOPWORDS = new Set([
  "and", "the", "for", "with", "pcs", "nos", "inch", "each", "qty", "need", "please",
  "required", "require", "supply", "new", "type", "size",
]);

export function searchTokens(description: string): string[] {
  return [...new Set(
    description
      .toLowerCase()
      .split(/[^a-z0-9/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )].slice(0, 8);
}

export type InventoryCheckOutcome = {
  status: "AVAILABLE" | "PARTIAL" | "NONE" | "CLARIFY";
  fromStock: number;
  toSource: number;
  matchedProductId: string | null;
  stale: boolean;
  note: string | null;
  candidates: Array<{ sku: string; name: string; match: MatchResult; available: number }>;
};

/**
 * Checks MFBMT stock for one enquiry item. Only an exact (or explicitly
 * approved equivalent) match may fulfil stock; anything weaker is reported and
 * left to the owner.
 */
export async function checkInventoryForItem(itemId: string): Promise<InventoryCheckOutcome> {
  const item = await db.enquiryItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Enquiry item not found");

  const missing = parseJson<string[]>(item.missingFields, []);
  if (missing.length > 0 || !(item.quantity > 0)) {
    // Stock may exist, but an incomplete specification must never be presented
    // as confirmed availability. We show it only as a provisional note.
    const provisionalTokens = searchTokens(item.description);
    const provisional = provisionalTokens.length
      ? await db.product.findMany({
          where: { OR: provisionalTokens.flatMap((token) => [{ name: { contains: token } }, { sku: { contains: token } }]) },
          include: { stocks: true },
          take: 10,
        })
      : [];
    const withStock = provisional
      .map((product) => ({
        sku: product.sku,
        name: product.name,
        available: product.stocks.reduce(
          (sum, stock) => sum + availableQuantity(stock.quantityOnHand, stock.quantityReserved),
          0,
        ),
      }))
      .filter((entry) => entry.available > 0)
      .sort((a, b) => b.available - a.available)[0];

    return {
      status: "CLARIFY",
      fromStock: 0,
      toSource: 0,
      matchedProductId: null,
      stale: false,
      note: withStock
        ? `${item.clarificationQuestion ?? "This item needs more details."} ${withStock.available} ${item.unit} of ${withStock.sku} may be in stock, but it is not counted until the specification is confirmed.`
        : item.clarificationQuestion ?? "This item needs more details before stock can be checked.",
      candidates: [],
    };
  }

  const tokens = searchTokens(item.description);
  const orFilters = tokens.flatMap((token) => [
    { name: { contains: token } },
    { sku: { contains: token } },
    { category: { contains: token } },
  ]);
  const products = await db.product.findMany({
    where: orFilters.length > 0 ? { OR: orFilters } : {},
    include: { stocks: true },
    take: 120,
  });

  const scored = products
    .map((product) => {
      const match = matchProduct(
        {
          description: item.description,
          category: item.category,
          brand: item.brand,
          size: item.size,
          material: item.material,
          grade: item.grade,
          pressureRating: item.pressureRating,
          schedule: item.schedule,
          standard: item.standard,
        },
        {
          description: product.name,
          category: product.category,
          brand: product.brand,
          size: product.size,
          material: product.material,
          grade: product.grade,
          pressureRating: product.pressureRating,
          schedule: product.schedule,
          standard: product.standard,
        },
      );
      const available = product.stocks.reduce(
        (sum, stock) => sum + availableQuantity(stock.quantityOnHand, stock.quantityReserved),
        0,
      );
      const stale = product.stocks.length === 0 || product.stocks.some((s) => isStockStale(s.lastUpdatedAt));
      return { product, match, available, stale };
    })
    .sort((a, b) => {
      const rank = { EXACT: 0, EQUIVALENT: 1, POSSIBLE: 2, INSUFFICIENT: 3, NO_MATCH: 4 };
      const diff = rank[a.match.status] - rank[b.match.status];
      return diff !== 0 ? diff : b.match.score - a.match.score;
    });

  const candidates = scored
    .filter((entry) => entry.match.status !== "NO_MATCH")
    .slice(0, 5)
    .map((entry) => ({
      sku: entry.product.sku,
      name: entry.product.name,
      match: entry.match,
      available: entry.available,
    }));

  const usable = scored.find((entry) => entry.match.status === "EXACT" || entry.match.status === "EQUIVALENT");

  if (!usable) {
    const possible = candidates.find((c) => c.match.status === "POSSIBLE" || c.match.status === "INSUFFICIENT");
    const rejected = scored.find((entry) => entry.match.status === "NO_MATCH");
    return {
      status: "NONE",
      fromStock: 0,
      toSource: item.quantity,
      matchedProductId: null,
      stale: false,
      note: possible
        ? `No exact stock match. ${possible.sku} looks similar but does not fully match the requested specification, so it was not used.`
        : rejected
          ? `A similar stock item (${rejected.product.sku}) does not match the requested specification and was not used.`
          : null,
      candidates,
    };
  }

  const split = stockSplit(item.quantity, usable.available);
  if (usable.available <= 0) {
    return {
      status: "NONE",
      fromStock: 0,
      toSource: item.quantity,
      matchedProductId: usable.product.id,
      stale: usable.stale,
      note: usable.stale ? "The last stock update for this product is old. Confirm quantity before promising stock." : null,
      candidates,
    };
  }

  return {
    status: split.toSource === 0 ? "AVAILABLE" : "PARTIAL",
    fromStock: split.fromStock,
    toSource: split.toSource,
    matchedProductId: usable.product.id,
    stale: usable.stale,
    note: usable.stale ? "The last stock update for this product is old. Confirm quantity before promising stock." : null,
    candidates,
  };
}

/** Persists an inventory check result onto the enquiry item. */
export async function applyInventoryCheck(itemId: string) {
  const existing = await db.enquiryItem.findUnique({ where: { id: itemId }, select: { quantity: true } });
  if (!existing) throw new Error("Enquiry item not found");
  const outcome = await checkInventoryForItem(itemId);
  const item = await db.enquiryItem.update({
    where: { id: itemId },
    data: {
      inventoryStatus: outcome.status,
      quantityFromStock: outcome.fromStock,
      // An unconfirmed specification still shows the quantity that will need sourcing.
      quantityToSource: outcome.status === "CLARIFY" ? existing.quantity : outcome.toSource,
      matchedProductId: outcome.matchedProductId,
      inventoryCheckedAt: new Date(),
      stockIsStale: outcome.stale,
      matchedStockJson: stringifyJson({
        candidates: outcome.candidates,
        note: outcome.note,
      }),
      sourcingStatus: outcome.toSource > 0 || outcome.status === "CLARIFY" ? "NOT_STARTED" : "NOT_REQUIRED",
    },
  });
  return { outcome, item };
}
