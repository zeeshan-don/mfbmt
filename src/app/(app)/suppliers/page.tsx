import Link from "next/link";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { parseStringArray } from "@/lib/json";
import { timeAgo } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, inputClass, statusTone } from "@/components/ui";
import { Building2 } from "lucide-react";
import { createSupplierAction, importSuppliersAction } from "@/app/actions/suppliers";

export const dynamic = "force-dynamic";

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; saved?: string; error?: string; imported?: string; skipped?: string }>;
}) {
  const user =  await requirePermission("suppliers.view");
  const params = await searchParams;
  const query = params.q?.trim();
  const isOwner = user.role === "OWNER";

  const suppliers = await db.supplier.findMany({
    where: query
      ? { OR: [{ name: { contains: query } }, { city: { contains: query } }, { country: { contains: query } }, { email: { contains: query } }] }
      : undefined,
    orderBy: { name: "asc" },
    take: 200,
    include: {
      _count: { select: { products: true, offers: true, quotes: true } },
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Suppliers"
        description="The suppliers your company knows about. Saved suppliers are searched first for every shortage."
      />

      {params.error ? <Notice tone="danger" title="Could not save">{params.error}</Notice> : null}
      {params.saved ? <Notice tone="ok">Supplier saved.</Notice> : null}
      {params.imported ? (
        <Notice tone="ok">
          {params.imported} supplier(s) imported. {params.skipped ? `${params.skipped} row(s) skipped (duplicates or missing names).` : ""}
          Imported suppliers are marked unverified until you confirm their details.
        </Notice>
      ) : null}

      <form action="/suppliers" className="flex items-center gap-2">
        <label htmlFor="q" className="sr-only">Search suppliers</label>
        <input id="q" name="q" defaultValue={query} placeholder="Name, city, country or email" className={`${inputClass} sm:w-72`} />
        <Button size="sm">Search</Button>
      </form>

      <Card>
        <CardHeader title="Supplier directory" description={`${suppliers.length} supplier(s)${query ? " matching your search" : ""}.`} />
        {suppliers.length === 0 ? (
          <EmptyState
            icon={<Building2 size={18} aria-hidden />}
            title={query ? "No suppliers match" : "No suppliers saved yet"}
            description={
              query
                ? "Try another name or city."
                : "Add the suppliers you already work with. Their recorded prices appear first in sourcing, and you can request quotations from here."
            }
          />
        ) : (
          <DataTable minWidth={940}>
            <thead>
              <tr>
                <Th>Supplier</Th>
                <Th>Location</Th>
                <Th>Contact</Th>
                <Th>Categories</Th>
                <Th align="right">Records</Th>
                <Th>Status</Th>
                <Th>Last verified</Th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-elevated/60">
                  <Td>
                    <Link href={`/suppliers/${supplier.id}`} className="font-medium text-ink hover:text-accent">
                      {supplier.name}
                    </Link>
                    {supplier.website ? (
                      <a href={supplier.website} target="_blank" rel="noreferrer nofollow" className="mt-0.5 block text-[11px] text-accent hover:underline">
                        {supplier.website.replace(/^https?:\/\//, "").slice(0, 40)}
                      </a>
                    ) : null}
                  </Td>
                  <Td><span className="text-xs text-soft">{[supplier.city, supplier.country].filter(Boolean).join(", ") || "—"}</span></Td>
                  <Td>
                    <span className="text-xs text-soft">{supplier.email ?? supplier.phone ?? "—"}</span>
                    {supplier.whatsapp ? <span className="block text-[11px] text-muted">WhatsApp {supplier.whatsapp}</span> : null}
                  </Td>
                  <Td><span className="text-[11px] text-soft">{parseStringArray(supplier.categories).slice(0, 3).join(", ") || "—"}</span></Td>
                  <Td align="right">
                    <span className="text-xs tabular text-soft">
                      {supplier._count.products} prices · {supplier._count.quotes} requests
                    </span>
                  </Td>
                  <Td><Badge tone={statusTone(supplier.status)}>{supplier.status.toLowerCase()}</Badge></Td>
                  <Td><span className="text-xs text-soft">{supplier.lastVerifiedAt ? timeAgo(supplier.lastVerifiedAt) : "Never"}</span></Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {isOwner ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Add a supplier" description="Only suppliers you record can receive quotation requests." />
            <details>
              <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-accent hover:underline">Add supplier</summary>
              <form action={createSupplierAction} className="grid gap-3 border-t border-line px-4 py-4 sm:grid-cols-2">
                <label className="block text-xs text-soft">Name *<input name="name" required className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Website<input name="website" className={`${inputClass} mt-1`} placeholder="https://" /></label>
                <label className="block text-xs text-soft">Country<input name="country" defaultValue="UAE" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">City<input name="city" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Contact person<input name="contactPerson" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Email<input name="email" type="email" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Phone<input name="phone" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">WhatsApp<input name="whatsapp" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft sm:col-span-2">Categories (comma separated)<input name="categories" className={`${inputClass} mt-1`} placeholder="Pipe Fittings, Valves" /></label>
                <label className="block text-xs text-soft sm:col-span-2">Notes<textarea name="notes" rows={2} className={`${inputClass} mt-1 h-auto py-2`} /></label>
                <div className="sm:col-span-2"><Button size="sm" variant="primary">Save supplier</Button></div>
              </form>
            </details>
          </Card>

          <Card>
            <CardHeader title="Import suppliers" description="Excel or CSV with a supplier name column." />
            <form action={importSuppliersAction} className="space-y-3 px-4 py-4">
              <input
                type="file"
                name="file"
                accept=".xlsx,.csv"
                required
                className="block w-full cursor-pointer rounded-control border border-line bg-bg px-3 py-2 text-sm text-soft file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs file:text-ink"
              />
              <p className="text-[11px] text-muted">
                Recognized columns: supplier/company name, email, phone, WhatsApp, country, city, website, categories.
                Duplicates by name or email are skipped.
              </p>
              <Button size="sm">Import suppliers</Button>
            </form>
          </Card>
        </div>
      ) : null}

      <p className="text-[11px] text-muted">
        Supplier reliability is shown only from your company&apos;s own records — quotations requested, replies received and prices confirmed.
        No public ratings are invented. <Link href="/settings" className="text-accent hover:underline">Manage contact exclusions</Link>
      </p>
    </div>
  );
}
