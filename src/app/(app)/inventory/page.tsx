import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isStockStale } from "@/lib/inventory/matching";
import { timeAgo } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, inputClass, statusTone } from "@/components/ui";
import { Boxes, Upload } from "lucide-react";
import { adjustStockAction, createProductAction } from "@/app/actions/inventory";

export const dynamic = "force-dynamic";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    saved?: string;
    error?: string;
    imported?: string;
    created?: string;
    updated?: string;
    skipped?: string;
    errors?: string;
    firstError?: string;
  }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const query = params.q?.trim();

  const products = await db.product.findMany({
    where: query
      ? {
          OR: [
            { name: { contains: query } },
            { sku: { contains: query } },
            { category: { contains: query } },
          ],
        }
      : undefined,
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { stocks: { include: { location: true } } },
  });

  const productCount = await db.product.count();
  const stale = products.filter((product) => product.stocks.length === 0 || product.stocks.some((stock) => isStockStale(stock.lastUpdatedAt)));
  const availableTotal = products.reduce(
    (sum, product) =>
      sum + product.stocks.reduce((inner, stock) => inner + Math.max(0, stock.quantityOnHand - stock.quantityReserved), 0),
    0,
  );

  const isOwner = user.role === "OWNER";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        description="What MFBMT has on hand. Stock is checked before any supplier is contacted."
        actions={
          isOwner ? (
            <ButtonLink href="/inventory/import" variant="primary">
              <Upload size={14} aria-hidden /> Import spreadsheet
            </ButtonLink>
          ) : null
        }
      />

      {params.error ? <Notice tone="danger" title="Could not save">{params.error}</Notice> : null}
      {params.saved ? <Notice tone="ok">Inventory updated.</Notice> : null}
      {params.imported ? (
        <Notice tone={params.errors ? "warn" : "ok"} title="Import finished">
          {params.created} new product(s) and {params.updated} updated, {params.skipped} row(s) skipped.
          {params.errors ? ` ${params.errors} row(s) had problems. ${params.firstError ?? ""}` : ""}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">Products recorded</p>
          <p className="text-xl font-semibold tabular text-ink">{productCount}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">Available units (shown products)</p>
          <p className="text-xl font-semibold tabular text-ink">{availableTotal.toLocaleString("en-AE")}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">With old stock updates</p>
          <p className="text-xl font-semibold tabular text-ink">{stale.length}</p>
          <p className="text-[11px] text-muted">Older than 30 days is flagged during sourcing.</p>
        </Card>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <form action="/inventory" className="flex items-center gap-2">
          <label htmlFor="q" className="sr-only">Search inventory</label>
          <input id="q" name="q" defaultValue={query} placeholder="Product code, name or category" className={`${inputClass} sm:w-72`} />
          <Button size="sm">Search</Button>
        </form>
        <p className="text-[11px] text-muted">Available = quantity on hand − reserved quantity.</p>
      </div>

      <Card>
        <CardHeader
          title="Stock"
          description="One row per product. Stock older than 30 days is marked so you never promise stock you have not verified."
          action={
            <ButtonLink href="/inventory/import" size="sm">
              Import
            </ButtonLink>
          }
        />
        {products.length === 0 ? (
          <EmptyState
            icon={<Boxes size={18} aria-hidden />}
            title={query ? "No products match that search" : "Your inventory has not been imported"}
            description={
              query
                ? "Try a different product code or name."
                : "Import your stock spreadsheet or add a product by hand. Until then every request will be treated as needing external sourcing."
            }
            action={isOwner ? <ButtonLink href="/inventory/import" variant="primary">Import inventory</ButtonLink> : undefined}
          />
        ) : (
          <DataTable minWidth={980}>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Product</Th>
                <Th>Specification</Th>
                <Th align="right">Available</Th>
                <Th>Location</Th>
                <Th>Updated</Th>
                {isOwner ? <Th>Change</Th> : null}
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const onHand = product.stocks.reduce((sum, stock) => sum + stock.quantityOnHand, 0);
                const reserved = product.stocks.reduce((sum, stock) => sum + stock.quantityReserved, 0);
                const available = Math.max(0, onHand - reserved);
                const lastUpdated = product.stocks.reduce<Date | null>(
                  (latest, stock) => (!latest || stock.lastUpdatedAt > latest ? stock.lastUpdatedAt : latest),
                  null,
                );
                const isOld = isStockStale(lastUpdated);
                return (
                  <tr key={product.id} className="hover:bg-elevated/60">
                    <Td><span className="font-mono text-xs text-soft">{product.sku}</span></Td>
                    <Td>
                      <span className="text-sm text-ink">{product.name}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {product.category}
                        {product.isDemo ? " · sample" : ""}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-[11px] text-soft">
                        {[product.size, product.material, product.grade, product.pressureRating, product.schedule, product.standard]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </span>
                    </Td>
                    <Td align="right">
                      <span className="font-medium tabular">{available.toLocaleString("en-AE")}</span>
                      <span className="block text-[11px] text-muted">{product.unit}</span>
                    </Td>
                    <Td><span className="text-xs text-soft">{product.stocks.map((s) => s.location.code).join(", ") || "—"}</span></Td>
                    <Td>
                      <span className="text-xs text-soft">{lastUpdated ? timeAgo(lastUpdated) : "Never"}</span>
                      {isOld ? <span className="mt-0.5 block"><Badge tone="warn">May be out of date</Badge></span> : null}
                    </Td>
                    {isOwner ? (
                      <Td>
                        <details>
                          <summary className="cursor-pointer text-xs text-accent">Update</summary>
                          <form action={adjustStockAction} className="mt-2 flex items-center gap-1">
                            <input type="hidden" name="productId" value={product.id} />
                            <input
                              name="delta"
                              placeholder="+10 or -2"
                              className={`${inputClass} h-8 w-24 tabular`}
                              aria-label={`Stock change for ${product.name}`}
                              required
                            />
                            <Button size="sm">Save</Button>
                          </form>
                        </details>
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>

      {isOwner ? (
        <Card>
          <CardHeader title="Add a product by hand" description="Creates the product and its opening stock in the main warehouse." />
          <details>
            <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-accent hover:underline">
              Add product
            </summary>
            <form action={createProductAction} className="grid gap-3 border-t border-line px-4 py-4 sm:grid-cols-3">
              <label className="block text-xs text-soft">Product code *<input name="sku" required className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Product name *<input name="name" required className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">
                Category
                <select name="category" className={`${inputClass} mt-1`} defaultValue="Pipe Fittings">
                  {["Industrial Fasteners", "Pipe Fittings", "Valves", "Flanges", "Gaskets", "Hoses & Couplings", "Stainless Steel Fittings", "Mild Steel Fittings", "PVC / PPR / HDPE", "Tools & General Supplies", "Other Industrial Supplies"].map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-soft">Size<input name="size" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Material<input name="material" className={`${inputClass} mt-1`} placeholder="SS316" /></label>
              <label className="block text-xs text-soft">Grade<input name="grade" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Pressure rating<input name="pressureRating" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Brand<input name="brand" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Unit<input name="unit" defaultValue="pcs" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Opening quantity<input name="quantity" defaultValue="0" className={`${inputClass} mt-1 tabular`} /></label>
              <div className="sm:col-span-3"><Button size="sm" variant="primary">Save product</Button></div>
            </form>
          </details>
        </Card>
      ) : null}

      <p className="text-[11px] text-muted">
        Stock data is only what MFBMT has recorded. The system never assumes a product is available because its code exists.
      </p>
    </div>
  );
}
