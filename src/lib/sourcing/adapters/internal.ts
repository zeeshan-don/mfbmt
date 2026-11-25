import { db } from "../../db";
import type { AdapterContext, AdapterResult, SearchAdapter, SourcingCandidate } from "../types";
import { searchTokens } from "../../inventory/check";

/**
 * The company's own supplier directory and previously recorded supplier
 * products. This source needs no external access and always runs.
 *
 * A zero result is reported precisely: no products recorded at all is a
 * different situation from recorded products that do not match this request.
 * The query is tenant-scoped by the database client, so another organization's
 * directory can never be read.
 */
export const internalSupplierAdapter: SearchAdapter = {
  key: "INTERNAL_SUPPLIERS",
  label: "Your supplier records",
  available: () => true,
  async search(queries: string[], context: AdapterContext): Promise<AdapterResult> {
    const noise = new Set(["supplier", "suppliers", "uae", "with", "from", "the"]);
    const tokens = [
      ...new Set(
        queries
          .flatMap((query) => searchTokens(query))
          .filter((token) => !noise.has(token)),
      ),
    ].slice(0, 12);

    const where = {
      ...(tokens.length
        ? {
            OR: tokens.flatMap((token) => [
              { title: { contains: token, mode: "insensitive" as const } },
              { description: { contains: token, mode: "insensitive" as const } },
              { sku: { contains: token, mode: "insensitive" as const } },
            ]),
          }
        : {}),
      supplier: { status: { not: "BLOCKED" } },
    };

    const [totalRecorded, rows] = await Promise.all([
      db.supplierProduct.count(),
      db.supplierProduct.findMany({
        where,
        include: { supplier: true },
        orderBy: { lastSeenAt: "desc" },
        take: context.request.quantity > 0 ? 40 : 20,
      }),
    ]);

    const candidates: SourcingCandidate[] = rows.map((row) => ({
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
        matchSource: "SUPPLIER_DIRECTORY",
      },
      retrievedAt: row.lastSeenAt,
      isDemo: row.isDemo,
    }));

    const note =
      totalRecorded === 0
        ? "No supplier products are recorded in your directory yet. Add supplier products, or rely on public web search."
        : rows.length === 0
          ? `${totalRecorded} recorded supplier product${totalRecorded === 1 ? "" : "s"}, but none matches this specification.`
          : `${rows.length} recorded supplier product${rows.length === 1 ? "" : "s"} matched the search words; the specification match is checked below.`;

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
      note,
    };
  },
};
