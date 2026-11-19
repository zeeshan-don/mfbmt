import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { supplierReliability } from "@/lib/suppliers/reliability";
import { parseStringArray } from "@/lib/json";
import { formatDate, formatMoney, timeAgo, truncate } from "@/lib/format";
import { OFFER_STATUS_LABELS, label } from "@/lib/constants";
import { Badge, Button, ButtonLink, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, inputClass, statusTone } from "@/components/ui";
import { addSupplierProductAction, updateSupplierAction } from "@/app/actions/suppliers";

export const dynamic = "force-dynamic";

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await requirePermission("suppliers.view");
  const { id } = await params;
  const flags = await searchParams;

  const supplier = await db.supplier.findUnique({
    where: { id },
    include: {
      contacts: true,
      products: { orderBy: { lastSeenAt: "desc" }, take: 50 },
      quotes: { orderBy: { createdAt: "desc" }, take: 20, include: { items: true } },
      offers: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { enquiryItem: { include: { enquiry: { select: { id: true, publicRef: true } } } } },
      },
    },
  });
  if (!supplier) notFound();
  const reliability = await supplierReliability(supplier.id);
  const isOwner = user.role === "OWNER";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={[supplier.city, supplier.country].filter(Boolean).join(", ") || "Supplier"}
        title={supplier.name}
        description={parseStringArray(supplier.categories).join(" · ") || "No categories recorded"}
        actions={
          <>
            <ButtonLink href="/suppliers" variant="ghost" size="sm">All suppliers</ButtonLink>
            <Badge tone={statusTone(supplier.status)}>{supplier.status.toLowerCase()}</Badge>
          </>
        }
      />

      {flags.error ? <Notice tone="danger" title="Could not save">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Supplier updated.</Notice> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Recorded reliability"
              description="Built only from your company's records. No public ratings are invented."
            />
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-4">
              <div>
                <p className="text-[11px] text-muted">Quotation requests</p>
                <p className="text-lg font-semibold tabular text-ink">{reliability.quotesRequested}</p>
                <p className="text-[11px] text-muted">{reliability.quotesSent} sent</p>
              </div>
              <div>
                <p className="text-[11px] text-muted">Replies received</p>
                <p className="text-lg font-semibold tabular text-ink">{reliability.quotesAnswered}</p>
                <p className="text-[11px] text-muted">
                  {reliability.responseRate != null ? `${reliability.responseRate}% response rate` : "No sent requests yet"}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted">Average reply time</p>
                <p className="text-lg font-semibold tabular text-ink">
                  {reliability.averageResponseDays != null ? `${reliability.averageResponseDays}d` : "—"}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted">Prices confirmed</p>
                <p className="text-lg font-semibold tabular text-ink">{reliability.priceConfirmedOffers}</p>
                <p className="text-[11px] text-muted">{reliability.offersRecorded} offers recorded</p>
              </div>
            </div>
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              {reliability.hasHistory
                ? `Last interaction ${timeAgo(reliability.lastInteraction)}. ${reliability.basis}.`
                : "No quotations, prices or orders recorded yet. Reliability will appear as you use this supplier."}
            </p>
          </Card>

          <Card>
            <CardHeader title="Recorded prices" description="These prices appear first when sourcing similar products." />
            {supplier.products.length === 0 ? (
              <EmptyState
                icon={<Badge tone="neutral">No prices</Badge>}
                title="No supplier prices recorded"
                description="Add a price from a supplier email or catalogue. It will be shown as an internal record, with its date."
              />
            ) : (
              <DataTable minWidth={720}>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th align="right">Price</Th>
                    <Th align="right">MOQ</Th>
                    <Th>Availability</Th>
                    <Th>Recorded</Th>
                  </tr>
                </thead>
                <tbody>
                  {supplier.products.map((product) => (
                    <tr key={product.id}>
                      <Td>
                        <span className="text-sm text-ink">{product.title}</span>
                        {product.sourceUrl ? (
                          <a href={product.sourceUrl} target="_blank" rel="noreferrer nofollow" className="mt-0.5 block text-[11px] text-accent hover:underline">
                            source
                          </a>
                        ) : null}
                      </Td>
                      <Td align="right">{product.unitPrice != null ? formatMoney(product.unitPrice, product.currency ?? "AED") : "—"}</Td>
                      <Td align="right">{product.moq ?? "—"}</Td>
                      <Td><span className="text-xs text-soft">{product.availability ?? "—"}</span></Td>
                      <Td><span className="text-xs text-muted">{formatDate(product.lastSeenAt)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            <details className="border-t border-line">
              <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-accent hover:underline">
                Record a price
              </summary>
              <form action={addSupplierProductAction} className="grid gap-3 border-t border-line px-4 py-4 sm:grid-cols-3">
                <input type="hidden" name="supplierId" value={supplier.id} />
                <label className="block text-xs text-soft sm:col-span-2">Product description *<input name="title" required className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Supplier item code<input name="sku" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Price<input name="unitPrice" inputMode="decimal" className={`${inputClass} mt-1 tabular`} /></label>
                <label className="block text-xs text-soft">Currency<input name="currency" defaultValue="AED" maxLength={3} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">MOQ<input name="moq" inputMode="decimal" className={`${inputClass} mt-1 tabular`} /></label>
                <label className="block text-xs text-soft">Availability<input name="availability" className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft sm:col-span-2">Source link<input name="sourceUrl" className={`${inputClass} mt-1`} placeholder="https://" /></label>
                <div className="sm:col-span-3"><Button size="sm">Save price</Button></div>
              </form>
            </details>
          </Card>

          <Card>
            <CardHeader title="Offers in active enquiries" description="Every price keeps the date it was received." />
            {supplier.offers.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No offers from this supplier yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {supplier.offers.map((offer) => (
                  <li key={offer.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <p className="text-xs text-ink">{truncate(offer.productTitle, 70)}</p>
                      <p className="text-[11px] text-muted">
                        {offer.enquiryItem?.enquiry.publicRef ?? "—"} · quoted {formatDate(offer.quotedAt)} · {label(OFFER_STATUS_LABELS, offer.status)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs tabular text-ink">{offer.unitPrice != null ? formatMoney(offer.unitPrice, offer.currency ?? "AED") : "No price"}</p>
                      {offer.enquiryItem ? (
                        <Link href={`/sourcing/${offer.enquiryItemId}`} className="text-[11px] text-accent hover:underline">compare</Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Supplier details" />
            <div className="space-y-3 px-4 py-3">
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-2"><dt className="text-muted">Contact</dt><dd className="text-ink">{supplier.contactPerson ?? "—"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">Email</dt><dd className="break-all text-right text-ink">{supplier.email ?? "—"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">Phone</dt><dd className="text-ink">{supplier.phone ?? "—"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">WhatsApp</dt><dd className="text-ink">{supplier.whatsapp ?? "—"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">Last verified</dt><dd className="text-ink">{supplier.lastVerifiedAt ? formatDate(supplier.lastVerifiedAt) : "Never"}</dd></div>
              </dl>
              {supplier.notes ? <p className="rounded-card border border-line bg-bg p-2 text-[11px] text-soft">{supplier.notes}</p> : null}
            </div>
          </Card>

          {isOwner ? (
            <Card>
              <CardHeader title="Edit supplier" />
              <form action={updateSupplierAction} className="space-y-2 px-4 py-3">
                <input type="hidden" name="supplierId" value={supplier.id} />
                <label className="block text-xs text-soft">Name<input name="name" defaultValue={supplier.name} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Website<input name="website" defaultValue={supplier.website ?? ""} className={`${inputClass} mt-1`} /></label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-soft">Country<input name="country" defaultValue={supplier.country ?? ""} className={`${inputClass} mt-1`} /></label>
                  <label className="block text-xs text-soft">City<input name="city" defaultValue={supplier.city ?? ""} className={`${inputClass} mt-1`} /></label>
                </div>
                <label className="block text-xs text-soft">Contact person<input name="contactPerson" defaultValue={supplier.contactPerson ?? ""} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Email<input name="email" defaultValue={supplier.email ?? ""} className={`${inputClass} mt-1`} /></label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-soft">Phone<input name="phone" defaultValue={supplier.phone ?? ""} className={`${inputClass} mt-1`} /></label>
                  <label className="block text-xs text-soft">WhatsApp<input name="whatsapp" defaultValue={supplier.whatsapp ?? ""} className={`${inputClass} mt-1`} /></label>
                </div>
                <label className="block text-xs text-soft">
                  Status
                  <select name="status" defaultValue={supplier.status} className={`${inputClass} mt-1`}>
                    <option value="ACTIVE">Active</option>
                    <option value="UNVERIFIED">Unverified</option>
                    <option value="PAUSED">Paused</option>
                    <option value="BLOCKED">Blocked (never used)</option>
                  </select>
                </label>
                <label className="block text-xs text-soft">Notes<textarea name="notes" defaultValue={supplier.notes ?? ""} rows={2} className={`${inputClass} mt-1 h-auto py-2`} /></label>
                <Button size="sm" variant="primary">Save changes</Button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
