import { db } from "../../db";
import type { AdapterContext, AdapterResult, SearchAdapter, SourcingCandidate } from "../types";
import { searchTokens } from "../../inventory/check";

/**
 * your company's own supplier directory and previously recorded supplier products.
 * This source needs no external access and always runs.
 */
export const internalSupplierAdapter: SearchAdapter = {
  key: "INTERNAL_SUPPLIERS",
  label: "your supplier records",
  available: () => true,
  async search(queries: string[], context: AdapterContext): Promise<AdapterResult> {
    const tokens = [...new Set(queries.flatMap((query) => searchTokens(query)))].slice(0, 10);
    const where = tokens.length
      ? {
          OR: tokens.flatMap((token) => [
            { title: { contains: token } },
            { description: { contains: token } },
            { sku: { contains: token } },
          ]),
        }
      : undefined;

    const rows = await db.supplierProduct.findMany({
      where,
      include: { supplier: true },
      take: context.request.quantity > 0 ? 40 : 20,
    });

    const candidates: SourcingCandidate[] = rows
      .filter((row) => row.supplier.status !== "BLOCKED")
      .map((row) => ({
        adapter: internalSupplierAdapter.key,
        supplierId: row.supplierId,
        supplierName: row.supplier.name,
        title: row.title,
        snippet: row.description,
        sourceUrl: row.sourceUrl,
        priceText: row.unitPrice != null ? `${row.currency ?? ""} ${row.unitPrice}` : null,
        unitPrice: row.unitPrice ?? null,
        currency: row.currency ?? null,
        moq: row.moq ?? null,
        availability: row.availability ?? null,
        evidence: {
          sku: row.sku,
          specs: row.specs,
          lastSeenAt: row.lastSeenAt.toISOString(),
          supplierCountry: row.supplier.country,
          contactEmail: row.supplier.email,
          contactPhone: row.supplier.phone,
        },
        retrievedAt: row.lastSeenAt,
        isDemo: row.isDemo,
      }));

    return {
      adapter: internalSupplierAdapter.key,
      label: internalSupplierAdapter.label,
      status: "OK",
      queries: queries.map((query) => ({
        query,
        status: "OK" as const,
        resultCount: candidates.length,
      })),
      candidates,
      note: rows.length === 0 ? "No matching supplier products recorded yet." : undefined,
    };
  },
};
