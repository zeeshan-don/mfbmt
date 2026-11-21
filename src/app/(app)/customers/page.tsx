import Link from "next/link";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, inputClass } from "@/components/ui";
import { createCustomerAction } from "@/app/actions/customers";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ error?: string; q?: string }> }) {
  const user = await requirePermission("quotations.view");
  const params = await searchParams;
  const q = params.q?.trim();
  const customers = await db.customer.findMany({
    where: q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] } : undefined,
    orderBy: { name: "asc" },
    take: 250,
    include: { _count: { select: { enquiries: true, quotations: true } } },
  });

  return (
    <div className="space-y-5">
      <PageHeader title="Customers" description="Companies and contacts linked to their enquiries and quotation history." />
      {params.error ? <Notice tone="danger" title="Could not save">{params.error}</Notice> : null}

      <form action="/customers" className="flex items-center gap-2">
        <label htmlFor="q" className="sr-only">Search customers</label>
        <input id="q" name="q" defaultValue={q} placeholder="Name, email or phone" className={`${inputClass} sm:w-72`} />
        <Button size="sm">Search</Button>
      </form>

      <Card>
        <CardHeader title="Customer master" description={`${customers.length} customer(s).`} />
        {customers.length === 0 ? (
          <EmptyState title="No customers yet" description="Customers are created automatically when the first quotation is prepared, or add one below." />
        ) : (
          <DataTable minWidth={720}>
            <thead><tr><Th>Customer</Th><Th>Contact</Th><Th>Tier</Th><Th align="right">Enquiries</Th><Th align="right">Quotations</Th><Th>Added</Th></tr></thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} className="hover:bg-elevated/60">
                  <Td><Link href={`/customers/${customer.id}`} className="font-medium text-ink hover:text-accent">{customer.name}</Link></Td>
                  <Td><span className="text-xs text-soft">{[customer.email, customer.phone].filter(Boolean).join(" · ") || "—"}</span></Td>
                  <Td><Badge tone={customer.tier === "STRATEGIC" ? "accent" : customer.tier === "STANDARD" ? "neutral" : "ok"}>{customer.tier.toLowerCase()}</Badge></Td>
                  <Td align="right"><span className="tabular text-xs text-soft">{customer._count.enquiries}</span></Td>
                  <Td align="right"><span className="tabular text-xs text-soft">{customer._count.quotations}</span></Td>
                  <Td><span className="text-xs text-muted">{formatDate(customer.createdAt)}</span></Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {user.role === "OWNER" ? (
        <Card>
          <CardHeader title="Add a customer" />
          <form action={createCustomerAction} className="grid gap-3 px-4 py-4 sm:grid-cols-3">
            <label className="block text-xs text-soft">Company / customer name *<input name="name" required className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Email<input name="email" type="email" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Phone<input name="phone" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">TRN / tax number<input name="taxNumber" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Country<input name="country" defaultValue="UAE" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Tier
              <select name="tier" defaultValue="STANDARD" className={`${inputClass} mt-1`}>
                <option value="STANDARD">Standard</option><option value="SILVER">Silver</option><option value="GOLD">Gold</option><option value="STRATEGIC">Strategic</option>
              </select>
            </label>
            <label className="block text-xs text-soft">Primary contact<input name="contactName" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Contact role<input name="contactRole" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Contact email<input name="contactEmail" type="email" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft">Contact phone<input name="contactPhone" className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-soft sm:col-span-2">Notes<input name="notes" className={`${inputClass} mt-1`} /></label>
            <div className="sm:col-span-3"><Button size="sm" variant="primary">Save customer</Button></div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
