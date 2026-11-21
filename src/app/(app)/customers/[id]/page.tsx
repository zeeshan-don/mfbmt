import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, inputClass, statusTone } from "@/components/ui";
import { updateCustomerAction } from "@/app/actions/customers";

export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await requirePermission("quotations.view");
  const { id } = await params;
  const flags = await searchParams;
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      contacts: { orderBy: { isPrimary: "desc" } },
      enquiries: { orderBy: { createdAt: "desc" }, take: 30 },
      quotations: { orderBy: { createdAt: "desc" }, take: 30, include: { items: true } },
    },
  });
  if (!customer) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={[customer.country, customer.tier].filter(Boolean).join(" · ")}
        title={customer.name}
        description={[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details recorded"}
        actions={<Link href="/customers" className="text-xs text-accent hover:underline">All customers</Link>}
      />
      {flags.error ? <Notice tone="danger" title="Could not save">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Customer updated.</Notice> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Quotation history" description="Every version, linked to this customer." />
            {customer.quotations.length === 0 ? <p className="px-4 py-5 text-sm text-muted">No quotations yet.</p> : (
              <ul className="divide-y divide-line">
                {customer.quotations.map((quotation) => (
                  <li key={quotation.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <Link href={`/quotations/${quotation.id}`} className="text-xs font-medium text-accent hover:underline">{quotation.quoteNumber} · v{quotation.version}</Link>
                      <p className="text-[11px] text-muted">{formatDate(quotation.createdAt)} · {quotation.items.length} line(s)</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular text-xs text-ink">{formatMoney(quotation.total, quotation.currency)}</span>
                      <Badge tone={statusTone(quotation.status)}>{quotation.outcome?.toLowerCase() ?? quotation.status.toLowerCase()}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Enquiries" />
            {customer.enquiries.length === 0 ? <p className="px-4 py-5 text-sm text-muted">No enquiries linked yet.</p> : (
              <ul className="divide-y divide-line">
                {customer.enquiries.map((enquiry) => (
                  <li key={enquiry.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <Link href={`/enquiries/${enquiry.id}`} className="text-xs text-accent hover:underline">{enquiry.publicRef}</Link>
                    <span className="text-[11px] text-muted">{formatDate(enquiry.createdAt)} · {enquiry.status.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Contacts" />
            {customer.contacts.length === 0 ? <p className="px-4 py-4 text-xs text-muted">No named contacts.</p> : (
              <ul className="divide-y divide-line">
                {customer.contacts.map((contact) => (
                  <li key={contact.id} className="px-4 py-2.5">
                    <p className="text-xs text-ink">{contact.name}{contact.isPrimary ? " · primary" : ""}</p>
                    <p className="text-[11px] text-muted">{[contact.role, contact.email, contact.phone].filter(Boolean).join(" · ") || "—"}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {user.role === "OWNER" ? (
            <Card>
              <CardHeader title="Edit customer" />
              <form action={updateCustomerAction} className="space-y-2 px-4 py-3">
                <input type="hidden" name="customerId" value={customer.id} />
                <label className="block text-xs text-soft">Name<input name="name" defaultValue={customer.name} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Email<input name="email" defaultValue={customer.email ?? ""} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Phone<input name="phone" defaultValue={customer.phone ?? ""} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">TRN<input name="taxNumber" defaultValue={customer.taxNumber ?? ""} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Country<input name="country" defaultValue={customer.country ?? ""} className={`${inputClass} mt-1`} /></label>
                <label className="block text-xs text-soft">Tier
                  <select name="tier" defaultValue={customer.tier} className={`${inputClass} mt-1`}>
                    <option value="STANDARD">Standard</option><option value="SILVER">Silver</option><option value="GOLD">Gold</option><option value="STRATEGIC">Strategic</option>
                  </select>
                </label>
                <label className="block text-xs text-soft">Notes<textarea name="notes" rows={2} defaultValue={customer.notes ?? ""} className={`${inputClass} mt-1 h-auto py-2`} /></label>
                <Button size="sm" variant="primary">Save changes</Button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
