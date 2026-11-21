import { db } from "../db";
import { parseJson, stringifyJson } from "../json";
import { parseFastenerSpecJson } from "../fasteners/spec";
import {
  industrialSpecFromFields,
  parseIndustrialSpecJson,
} from "../catalog/industrialSpec";
import {
  availableQuantity,
  isStockStale,
  matchProduct,
  stockSplit,
  type EquivalenceRule,
  type MatchResult,
} from "./matching";

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

/**
 * Inventory states are deliberately distinct:
 *   NOT_CONFIGURED — no catalogue/stock has ever been loaded. This is NOT "zero stock".
 *   NONE           — inventory is configured and this item is not available.
 *   AVAILABLE      — confirmed enough stock.
 *   PARTIAL        — confirmed some stock, the rest must be sourced.
 *   CLARIFY        — the specification is incomplete, so stock must not be promised.
 */
export type InventoryStatus = "AVAILABLE" | "PARTIAL" | "NONE" | "CLARIFY" | "NOT_CONFIGURED";

export type InventoryCheckOutcome = {
  status: InventoryStatus;
  fromStock: number;
  toSource: number;
  matchedProductId: string | null;
  matchStatus: MatchResult["status"] | null;
  stale: boolean;
  note: string | null;
  candidates: Array<{ sku: string; name: string; match: MatchResult; available: number; stale: boolean }>;
};

export async function loadEquivalences(): Promise<Array<EquivalenceRule & { reason: string | null }>> {
  const rows = await db.materialEquivalence.findMany({ where: { isActive: true } });
  return rows.map((row) => ({
    requestedMaterial: row.requestedMaterial,
    offeredMaterial: row.offeredMaterial,
    requestedGrade: row.requestedGrade,
    offeredGrade: row.offeredGrade,
    reason: row.reason,
  }));
}

async function inventoryConfigured(): Promise<{ configured: boolean; sourcingFirst: boolean }> {
  const [products, stocks, org] = await Promise.all([
    db.product.count(),
    db.inventoryStock.count(),
    db.organization.findFirst({ select: { inventoryMode: true, inventoryConfiguredAt: true } }),
  ]);
  const sourcingFirst = org?.inventoryMode === "SOURCING_FIRST";
  const configured = (products > 0 && stocks > 0) || Boolean(org?.inventoryConfiguredAt) || sourcingFirst;
  return { configured, sourcingFirst };
}

/**
 * Checks your company's stock for one enquiry item. Only an exact (or explicitly
 * approved equivalent) match with a current stock record may fulfil stock;
 * anything weaker is reported and left to the owner.
 */
export async function checkInventoryForItem(itemId: string): Promise<InventoryCheckOutcome> {
  const item = await db.enquiryItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Enquiry item not found");

  const missing = parseJson<string[]>(item.missingFields, []);
  if (missing.length > 0 || !(item.quantity > 0)) {
    const provisionalTokens = searchTokens(item.description);
    const provisional = provisionalTokens.length
      ? await db.product.findMany({
          where: {
            OR: provisionalTokens.flatMap((token) => [{ name: { contains: token, mode: "insensitive" } }, { sku: { contains: token, mode: "insensitive" } }]),
          },
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
      matchStatus: null,
      stale: false,
      note: withStock
        ? `${item.clarificationQuestion ?? "This item needs more details."} ${withStock.available} ${item.unit} of ${withStock.sku} may be in stock, but it is not counted until the specification is confirmed.`
        : (item.clarificationQuestion ?? "This item needs more details before stock can be checked."),
      candidates: [],
    };
  }

  const { configured, sourcingFirst } = await inventoryConfigured();
  if (!configured) {
    return {
      status: "NOT_CONFIGURED",
      fromStock: 0,
      toSource: item.quantity,
      matchedProductId: null,
      matchStatus: null,
      stale: false,
      note: "No inventory has been imported, so your company's stock is unknown — this does not mean the item is out of stock. Import your stock file in Settings, or confirm that your company works sourcing-first.",
      candidates: [],
    };
  }

  const tokens = searchTokens(item.description);
  const orFilters = tokens.flatMap((token) => [
    { name: { contains: token, mode: "insensitive" as const } },
    { sku: { contains: token, mode: "insensitive" as const } },
    { category: { contains: token, mode: "insensitive" as const } },
  ]);
  const products = await db.product.findMany({
    where: orFilters.length > 0 ? { OR: orFilters } : {},
    include: { stocks: true },
    take: 200,
  });

  const equivalences = await loadEquivalences();

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
          fastenerSpec: parseFastenerSpecJson(item.fastenerSpecJson),
          industrialSpec: parseIndustrialSpecJson(item.industrialSpecJson),
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
          fastenerSpec: parseFastenerSpecJson(product.fastenerSpecJson),
          industrialSpec:
            parseIndustrialSpecJson(product.industrialSpecJson) ??
            industrialSpecFromFields(product.category, {
              description: product.name,
              size: product.size,
              material: product.material,
              grade: product.grade,
              pressureRating: product.pressureRating,
              schedule: product.schedule,
              standard: product.standard,
              brand: product.brand,
              otherSpecs: parseJson<Record<string, string>>(product.specs, {}),
            }),
          otherSpecs: parseJson<Record<string, string>>(product.specs, {}),
        },
        { equivalences },
      );
      const available = product.stocks.reduce(
        (sum, stock) => sum + availableQuantity(stock.quantityOnHand, stock.quantityReserved),
        0,
      );
      const stale =
        product.stocks.length === 0 ||
        product.stocks.some((stock) => isStockStale(stock.lastUpdatedAt));
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
      stale: entry.stale,
    }));

  const usable = scored.find(
    (entry) => (entry.match.status === "EXACT" || entry.match.status === "EQUIVALENT") && !entry.stale,
  );
  const staleMatch = scored.find(
    (entry) => (entry.match.status === "EXACT" || entry.match.status === "EQUIVALENT") && entry.stale,
  );

  if (!usable) {
    if (staleMatch) {
      return {
        status: "NONE",
        fromStock: 0,
        toSource: item.quantity,
        matchedProductId: staleMatch.product.id,
        matchStatus: staleMatch.match.status,
        stale: true,
        note: `${staleMatch.product.sku} matches the request, but its stock record is older than 30 days. Confirm the physical quantity before promising stock, so nothing was counted.`,
        candidates,
      };
    }
    const possible = candidates.find(
      (candidate) => candidate.match.status === "POSSIBLE" || candidate.match.status === "INSUFFICIENT",
    );
    const rejected = scored.find((entry) => entry.match.status === "NO_MATCH");
    return {
      status: "NONE",
      fromStock: 0,
      toSource: item.quantity,
      matchedProductId: null,
      matchStatus: null,
      stale: false,
      note: sourcingFirst
        ? "The company is configured to source first, so nothing was taken from stock for this item."
        : possible
          ? `No exact stock match. ${possible.sku} looks similar but does not fully match the requested specification, so it was not used.`
          : rejected
            ? `A similar stock item (${rejected.product.sku}) does not match the requested specification and was not used. ${rejected.match.mismatches.slice(0, 2).join("; ")}`
            : "No matching product was found in your company's inventory.",
      candidates,
    };
  }

  const split = stockSplit(item.quantity, sourcingFirst ? 0 : usable.available);

  if (split.toSource === item.quantity && item.quantity > 0) {
    return {
      status: "NONE",
      fromStock: 0,
      toSource: item.quantity,
      matchedProductId: usable.product.id,
      matchStatus: usable.match.status,
      stale: false,
      note:
        usable.available <= 0
          ? `${usable.product.sku} matches the request and your company's stock is confirmed at zero.`
          : sourcingFirst
            ? "The company is configured to source first, so nothing was taken from stock for this item."
            : null,
      candidates,
    };
  }

  return {
    status: split.toSource === 0 ? "AVAILABLE" : "PARTIAL",
    fromStock: split.fromStock,
    toSource: split.toSource,
    matchedProductId: usable.product.id,
    matchStatus: usable.match.status,
    stale: false,
    note:
      usable.match.status === "EQUIVALENT"
        ? `Stock is an owner-approved equivalent: ${usable.match.reasons.filter((reason) => /approved substitution/i.test(reason)).join(" ")}`
        : null,
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
      quantityToSource: outcome.status === "CLARIFY" ? existing.quantity : outcome.toSource,
      matchedProductId: outcome.matchedProductId,
      inventoryCheckedAt: new Date(),
      stockIsStale: outcome.stale,
      stockMatchStatus: outcome.matchStatus,
      matchedStockJson: stringifyJson({
        candidates: outcome.candidates.map((candidate) => ({
          sku: candidate.sku,
          name: candidate.name,
          available: candidate.available,
          stale: candidate.stale,
          status: candidate.match.status,
          reasons: candidate.match.reasons,
          mismatches: candidate.match.mismatches,
        })),
        note: outcome.note,
      }),
      sourcingStatus:
        outcome.toSource > 0 || outcome.status === "CLARIFY" || outcome.status === "NOT_CONFIGURED"
          ? "NOT_STARTED"
          : "NOT_REQUIRED",
    },
  });
  return { outcome, item };
}
