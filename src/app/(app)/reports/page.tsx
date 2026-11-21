import Link from "next/link";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export default async function ReportsPage() {
  await requirePermission("quotations.view");
  const quotations = await db.customerQuotation.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      items: { include: { enquiryItem: { select: { category: true } } } },
    },
  });

  const sent = quotations.filter((quotation) => quotation.sentAt);
  const responseDays = sent.map((quotation) => (quotation.sentAt!.getTime() - quotation.createdAt.getTime()) / 86_400_000);
  const decided = quotations.filter((quotation) => quotation.outcome && quotation.outcome !== "NO_RESPONSE");
  const won = quotations.filter((quotation) => quotation.outcome === "WON");
  const conversion = decided.length > 0 ? Math.round((won.length / decided.length) * 100) : null;

  const byCategory = new Map<string, { revenue: number; cost: number; lines: number }>();
  for (const quotation of sent) {
    for (const line of quotation.items) {
      if (line.costPrice == null || line.lineTotal == null) continue;
      const category = line.enquiryItem?.category ?? "Uncategorised";
      const entry = byCategory.get(category) ?? { revenue: 0, cost: 0, lines: 0 };
      entry.revenue += line.lineTotal;
      entry.cost += line.costPrice * line.quantity;
      entry.lines += 1;
      byCategory.set(category, entry);
    }
  }
  const categories = [...byCategory.entries()]
    .map(([category, entry]) => ({
      category,
      ...entry,
      marginPct: entry.revenue > 0 ? ((entry.revenue - entry.cost) / entry.revenue) * 100 : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotation report"
        description="Built only from quotations and outcomes recorded in this workspace. No forecast or invented benchmark."
        actions={<Link href="/enquiries" className="text-xs text-accent hover:underline">Enquiries</Link>}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Card className="px-4 py-3"><p className="text-[11px] text-muted">Quotations</p><p className="text-xl font-semibold tabular text-ink">{quotations.length}</p></Card>
        <Card className="px-4 py-3"><p className="text-[11px] text-muted">Sent</p><p className="text-xl font-semibold tabular text-ink">{sent.length}</p></Card>
        <Card className="px-4 py-3"><p className="text-[11px] text-muted">Median prepare-to-send</p><p className="text-xl font-semibold tabular text-ink">{median(responseDays) != null ? `${median(responseDays)!.toFixed(1)}d` : "—"}</p></Card>
        <Card className="px-4 py-3"><p className="text-[11px] text-muted">Won / decided</p><p className="text-xl font-semibold tabular text-ink">{conversion != null ? `${conversion}%` : "—"}</p><p className="text-[11px] text-muted">{won.length} won of {decided.length} decided</p></Card>
      </div>

      <Card>
        <CardHeader title="Margin by category" description="Only sent quotations with a recorded cost on the line are included." />
        {categories.length === 0 ? (
          <EmptyState title="No costed sent quotations yet" description="Record an outcome and approve supplier costs to build this report." />
        ) : (
          <div className="scroll-x">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 620 }}>
              <thead><tr>
                <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Category</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Lines</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Revenue</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Recorded cost</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Margin</th>
              </tr></thead>
              <tbody>
                {categories.map((entry) => (
                  <tr key={entry.category}>
                    <td className="border-b border-line/70 px-3 py-2 text-ink">{entry.category}</td>
                    <td className="border-b border-line/70 px-3 py-2 text-right tabular text-soft">{entry.lines}</td>
                    <td className="border-b border-line/70 px-3 py-2 text-right tabular text-ink">{formatMoney(entry.revenue)}</td>
                    <td className="border-b border-line/70 px-3 py-2 text-right tabular text-soft">{formatMoney(entry.cost)}</td>
                    <td className="border-b border-line/70 px-3 py-2 text-right tabular text-ink">{entry.marginPct != null ? `${entry.marginPct.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
