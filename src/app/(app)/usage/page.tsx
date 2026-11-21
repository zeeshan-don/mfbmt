import { requireOwner } from "@/lib/auth";
import { getMonthlyUsage } from "@/lib/usage";
import { getOrgLimits, aiBudgetStatus, enquiryAllowanceStatus } from "@/lib/limits";
import { Badge, Card, CardHeader, PageHeader, Notice } from "@/components/ui";
import { formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

function money(value: number | null, currency = "AED") {
  return value == null ? "Incomplete — no FX rate" : formatMoney(value, currency);
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireOwner();
  const { month } = await searchParams;
  const [usage, limits, budget, allowance] = await Promise.all([
    getMonthlyUsage(month),
    getOrgLimits(),
    aiBudgetStatus(),
    enquiryAllowanceStatus(),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage and cost evidence"
        description="The monthly record for the invoice conversation. Tokens and search counts are recorded by deterministic code."
      />
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="block text-xs text-soft">
          Month
          <input type="month" name="month" defaultValue={usage.month} className="mt-1 rounded-control border border-line bg-surface px-2.5 py-2 text-sm text-ink" />
        </label>
        <button className="h-9 rounded-control border border-line bg-surface px-3 text-xs text-ink hover:bg-elevated">Show month</button>
        <a className="h-9 rounded-control border border-line bg-surface px-3 pt-2 text-xs text-ink hover:bg-elevated" href={`/api/usage/export?month=${usage.month}&format=csv`}>Export CSV</a>
        <a className="h-9 rounded-control border border-line bg-surface px-3 pt-2 text-xs text-ink hover:bg-elevated" href={`/api/usage/export?month=${usage.month}&format=pdf`}>Export PDF</a>
      </form>

      {budget.warning !== "NONE" ? (
        <Notice tone={budget.warning === "100" ? "danger" : "warn"} title={budget.warning === "100" ? "Monthly AI budget reached" : "80% of monthly AI budget used"}>
          {budget.warning === "100"
            ? "AI extraction has stopped spending. The built-in parser is used and affected enquiries are flagged for review."
            : "Review the remaining budget before the end of the month."}
        </Notice>
      ) : null}
      {allowance.warning !== "NONE" ? (
        <Notice tone={allowance.warning === "100" ? "danger" : "warn"} title={allowance.warning === "100" ? "Monthly enquiry allowance reached" : "80% of enquiry allowance used"}>
          {allowance.used} of {allowance.allowance} enquiries recorded this month. Intake is not silently dropped; review the allowance in Settings.
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Enquiries received", usage.enquiriesReceived],
          ["Supplier RFQs created", usage.rfqsCreated],
          ["Quotations sent", usage.quotationsSent],
          ["Search queries", usage.searchQueries],
          ["AI calls", usage.aiCalls],
          ["Input tokens", usage.aiInputTokens.toLocaleString("en-GB")],
          ["Output tokens", usage.aiOutputTokens.toLocaleString("en-GB")],
          ["AI cost", money(usage.aiCostAed)],
        ].map(([label, value]) => (
          <Card key={label} className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular text-ink">{value}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="How this is calculated" description="Every number below is queryable from the organization's own records." />
        <div className="grid gap-3 px-4 py-4 text-xs text-soft sm:grid-cols-2">
          <p>AI cost: provider token counts × configured per-million rates, stored at the time of each call.</p>
          <p>FX: {usage.fxRate ? `1 USD = ${usage.fxRate.toFixed(6)} AED, recorded with the rate source.` : "No USD/AED rate is available, so the AED total is marked incomplete."}</p>
          <p>AI budget: {money(budget.spentAed)} of {money(budget.budgetAed)} used.</p>
          <p>Enquiry allowance: {allowance.used} of {allowance.allowance} used. Limits: {limits.maxItemsPerEnquiry} items/enquiry, {limits.maxSearchQueriesPerItem} searches/item, web search {limits.webSearchEnabled ? "on" : "off"}.</p>
        </div>
      </Card>
      <p className="text-[11px] text-muted">
        <Badge tone="neutral">Evidence</Badge> This page is generated from the current organization only. Switch organizations and the records disappear.
      </p>
    </div>
  );
}
