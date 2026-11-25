import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { timeAgo, truncate } from "@/lib/format";
import { ENQUIRY_STATUS_LABELS, label } from "@/lib/constants";
import { queueStats, workerLiveness } from "@/lib/workflow/jobs";
import { getMonthlyUsage } from "@/lib/usage";
import { getOrgLimits, aiBudgetStatus } from "@/lib/limits";
import { ownerOperationsBoard } from "@/lib/orders/dashboard";
import { Badge, Card, CardHeader, DataTable, EmptyState, PageHeader, Td, Th, statusTone } from "@/components/ui";
import { AlertTriangle, BadgeCheck, Boxes, Inbox, MessageSquare, Radar } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const user = await requireUser();

  const [needsReview, pendingSourcingApprovals, clarificationItems, quoteResponses, recentEnquiries, recentSessions, pendingQuoteRequests, pendingQuoteApprovals, shortLines, overdueResponses, queue, worker] =
    await Promise.all([
      db.enquiry.count({ where: { status: "NEEDS_REVIEW" } }),
      db.approval.count({ where: { status: "PENDING", type: "SOURCING" } }),
      db.enquiryItem.count({ where: { reviewStatus: "NEEDS_CLARIFICATION" } }),
      db.supplierQuote.count({ where: { status: "RESPONDED" } }),
      db.enquiry.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
        include: {
          items: { select: { id: true, inventoryStatus: true, sourcingStatus: true } },
          Message: { select: { receivedAt: true } },
        },
      }),
      db.searchSession.findMany({
        orderBy: { startedAt: "desc" },
        take: 5,
        include: { enquiryItem: { select: { description: true, enquiryId: true } } },
      }),
      db.supplierQuote.findMany({
        where: { status: { in: ["AWAITING_APPROVAL", "SENT"] } },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { supplier: { select: { name: true } }, enquiryItem: { select: { description: true } } },
      }),
      db.approval.count({ where: { status: "PENDING", type: "CUSTOMER_QUOTATION" } }),
      db.enquiryItem.count({ where: { sourcingStatus: { in: ["NOT_STARTED", "QUEUED", "SEARCHING", "NO_RESULTS"] }, quantityToSource: { gt: 0 } } }),
      db.supplierQuote.count({
        where: { status: "SENT", sentAt: { lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } },
      }),
      queueStats(),
      workerLiveness(),
    ]);

  const orderBoard = user.role === "OWNER" ? await ownerOperationsBoard() : null;

  const attention = [
    {
      count: needsReview,
      title: "enquiries need your review",
      detail: "The system is not fully sure what was requested.",
      href: "/enquiries?status=NEEDS_REVIEW",
      icon: AlertTriangle,
    },
    {
      count: pendingSourcingApprovals,
      title: "sourcing results await your approval",
      detail: "Supplier options are ready to compare.",
      href: "/approvals",
      icon: BadgeCheck,
    },
    {
      count: clarificationItems,
      title: "product lines need missing details",
      detail: "Suppliers cannot be searched reliably yet.",
      href: "/enquiries?filter=clarify",
      icon: Inbox,
    },
    {
      count: quoteResponses,
      title: "supplier quotations have arrived",
      detail: "Prices submitted by suppliers are ready to compare.",
      href: "/sourcing?tab=responses",
      icon: MessageSquare,
    },
    {
      count: shortLines,
      title: "lines are short and need sourcing",
      detail: "Stock does not cover these lines yet.",
      href: "/sourcing",
      icon: Boxes,
    },
    {
      count: overdueResponses,
      title: "supplier replies are overdue",
      detail: "Requests sent more than 3 days ago with no answer.",
      href: "/sourcing?tab=responses",
      icon: MessageSquare,
    },
    {
      count: pendingQuoteApprovals,
      title: "customer quotations need your approval",
      detail: "A separate decision from approving the supplier.",
      href: "/approvals",
      icon: BadgeCheck,
    },
  ].filter((item) => item.count > 0);

  const [usage, limits, sentQuotes] = await Promise.all([
    getMonthlyUsage(),
    getOrgLimits(),
    db.customerQuotation.findMany({
      where: { sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      take: 100,
      select: { sentAt: true, enquiry: { select: { createdAt: true } } },
    }),
  ]);
  const budget = await aiBudgetStatus(limits);

  const quoteDurationsDays = sentQuotes
    .map((q) => (q.sentAt && q.enquiry?.createdAt ? (q.sentAt.getTime() - q.enquiry.createdAt.getTime()) / 86_400_000 : null))
    .filter((v): v is number => v != null && v >= 0)
    .sort((a, b) => a - b);
  const medianTimeToQuoteDays =
    quoteDurationsDays.length === 0
      ? null
      : quoteDurationsDays.length % 2 === 1
        ? quoteDurationsDays[Math.floor(quoteDurationsDays.length / 2)]
        : (quoteDurationsDays[quoteDurationsDays.length / 2 - 1] + quoteDurationsDays[quoteDurationsDays.length / 2]) / 2;

  const receivedByEnquiry = new Map<string, Date | undefined>(
    recentEnquiries.map((enquiry) => [enquiry.id, enquiry.Message?.receivedAt] as const),
  );

  const activeItems = recentEnquiries.reduce(
    (sum, enquiry) => sum + enquiry.items.filter((item) => item.sourcingStatus !== "NOT_REQUIRED").length,
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`}
        title={`Good day, ${user.name.split(" ")[0]}`}
        description="Here is what needs your attention today. Numbers are live from your enquiries, inventory and sourcing."
      />

      <section aria-labelledby="attention-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="attention-heading" className="text-sm font-semibold text-ink">
            Needs your attention
          </h2>
          <span className="text-[11px] text-muted">Live from the database</span>
        </div>
        <Card>
          {attention.length === 0 ? (
            <EmptyState
              icon={<BadgeCheck size={18} aria-hidden />}
              title="Nothing is waiting for you"
              description="New enquiries and sourcing results will appear here as they arrive."
            />
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.title}>
                    <Link
                      href={item.href}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated"
                    >
                      <span className="rounded-full border border-warn/30 bg-warn/10 p-1.5 text-warn">
                        <Icon size={14} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 text-sm text-ink">
                        <span className="font-semibold tabular">{item.count}</span> {item.title}
                        <span className="block text-xs text-muted">{item.detail}</span>
                      </span>
                      <span className="text-xs text-accent">Review</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <section aria-labelledby="metrics-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="metrics-heading" className="text-sm font-semibold text-ink">This month</h2>
          <span className="text-[11px] text-muted">Live from your records</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [
              "Enquiries received",
              usage.enquiriesReceived,
              limits.monthlyEnquiryAllowance > 0 ? `of ${limits.monthlyEnquiryAllowance} allowance` : "no allowance set",
            ],
            [
              "Quotations sent",
              usage.quotationsSent,
              "sent this month",
            ],
            [
              "Median time to quote",
              medianTimeToQuoteDays == null ? "—" : `${medianTimeToQuoteDays.toFixed(1)} days`,
              sentQuotes.length > 0 ? `from ${sentQuotes.length} sent quotation(s)` : "no sent quotations yet",
            ],
            [
              "AI spend",
              budget.spentAed == null ? "Incomplete" : `${budget.spentAed.toFixed(0)} / ${budget.budgetAed.toFixed(0)} AED`,
              budget.warning === "100" ? "budget reached" : budget.warning === "80" ? "80% used" : "within budget",
            ],
          ].map(([label, value, detail]) => (
            <Card key={label} className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
              <p className="mt-2 text-2xl font-semibold tabular text-ink">{value}</p>
              <p className="mt-1 text-[11px] text-muted">{detail}</p>
            </Card>
          ))}
        </div>
      </section>

      {orderBoard ? (
        <section aria-labelledby="operations-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="operations-heading" className="text-sm font-semibold text-ink">
              Commercial operations
            </h2>
            <Link href="/orders" className="text-xs font-medium text-accent hover:underline">
              Open sales orders
            </Link>
          </div>
          <Card>
            <div className="grid gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Confirmed order value</p>
                {orderBoard.money.confirmedOrderValue.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">No open orders</p>
                ) : (
                  orderBoard.money.confirmedOrderValue.map((total) => (
                    <p key={total.currency} className="mt-1 text-lg font-semibold tabular text-ink">
                      {total.currency} {total.amount}
                    </p>
                  ))
                )}
                <p className="mt-1 text-[11px] text-muted">{orderBoard.overview.openSalesOrders} open sales orders</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Customer receivables</p>
                {orderBoard.money.receivables.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">Nothing outstanding</p>
                ) : (
                  orderBoard.money.receivables.map((total) => (
                    <p key={total.currency} className="mt-1 text-lg font-semibold tabular text-ink">
                      {total.currency} {total.amount}
                    </p>
                  ))
                )}
                <p className="mt-1 text-[11px] text-muted">{orderBoard.overview.settledDeals} settled deals</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Supplier payables</p>
                {orderBoard.money.payables.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">No open supplier bills</p>
                ) : (
                  orderBoard.money.payables.map((total) => (
                    <p key={total.currency} className="mt-1 text-lg font-semibold tabular text-ink">
                      {total.currency} {total.amount}
                    </p>
                  ))
                )}
                <p className="mt-1 text-[11px] text-muted">{orderBoard.overview.openSupplierPos} supplier POs open</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Order flow</p>
                <p className="mt-1 text-sm text-ink">
                  <span className="font-semibold tabular">{orderBoard.overview.ordersInProcurement}</span> in procurement
                </p>
                <p className="text-sm text-ink">
                  <span className="font-semibold tabular">{orderBoard.overview.ordersInFulfilment}</span> in fulfilment
                </p>
                <p className="mt-1 text-[11px] text-muted">{orderBoard.overview.quotationsOutstanding} quotations outstanding</p>
              </div>
            </div>
            {orderBoard.attention.length > 0 ? (
              <ul className="divide-y divide-line border-t border-line">
                {orderBoard.attention.slice(0, 6).map((entry) => (
                  <li key={entry.code}>
                    <Link href={entry.href} className="flex items-center justify-between gap-3 px-4 py-2 text-[12px] hover:bg-elevated/60">
                      <span className="text-soft">
                        <span className="mr-2 inline-flex min-w-5 justify-center rounded-full bg-warn/10 px-1.5 py-0.5 text-[11px] font-semibold text-warn tabular">
                          {entry.count}
                        </span>
                        {entry.title}
                      </span>
                      <span className="text-accent">Review</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Recent enquiries"
              description="The latest customer requests and where each one stands."
              action={
                <Link href="/enquiries" className="text-xs font-medium text-accent hover:underline">
                  All enquiries
                </Link>
              }
            />
            {recentEnquiries.length === 0 ? (
              <EmptyState
                icon={<Inbox size={18} aria-hidden />}
                title="No enquiries yet"
                description="Connect WhatsApp or email, or add a request manually. New enquiries will appear here."
              />
            ) : (
              <DataTable minWidth={640}>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>Received</Th>
                    <Th align="right">Products</Th>
                    <Th>Stage</Th>
                    <Th>Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentEnquiries.map((enquiry) => {
                    const requiresReview = enquiry.status === "NEEDS_REVIEW";
                    const awaiting = enquiry.items.some((item) => item.sourcingStatus === "AWAITING_APPROVAL");
                    const received = receivedByEnquiry.get(enquiry.id) ?? enquiry.createdAt;
                    return (
                      <tr key={enquiry.id} className="hover:bg-elevated/60">
                        <Td>
                          <Link href={`/enquiries/${enquiry.id}`} className="font-medium text-ink hover:text-accent">
                            {enquiry.customerName || enquiry.customerPhone || "Unknown customer"}
                          </Link>
                          <span className="mt-0.5 block text-[11px] text-muted">
                            {enquiry.publicRef}
                            {enquiry.isDemo ? " · sample" : ""} · {enquiry.channel.toLowerCase()}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-xs text-soft">{timeAgo(received)}</span>
                        </Td>
                        <Td align="right">
                          <span className="tabular text-sm">{enquiry.items.length}</span>
                        </Td>
                        <Td>
                          <Badge tone={statusTone(enquiry.status)} dot>
                            {label(ENQUIRY_STATUS_LABELS, enquiry.status)}
                          </Badge>
                        </Td>
                        <Td>
                          <span className="text-xs text-soft">
                            {requiresReview ? "Check the request" : awaiting ? "Approve supplier" : "—"}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Sourcing activity" description="Recent supplier searches." />
            {recentSessions.length === 0 ? (
              <EmptyState
                icon={<Radar size={18} aria-hidden />}
                title="No supplier searches yet"
                description="Searches start automatically for products that are not in stock."
              />
            ) : (
              <ul className="divide-y divide-line">
                {recentSessions.map((session) => {
                  const summary = parseJson<{ suppliers?: number; results?: number; rankableOffers?: number }>(
                    session.summaryJson,
                    {},
                  );
                  return (
                    <li key={session.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[13px] font-medium text-ink">
                          {truncate(session.enquiryItem.description, 60)}
                        </p>
                        <Badge tone={statusTone(session.status)}>{session.status.toLowerCase()}</Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-muted">
                        {summary.suppliers ?? 0} supplier{(summary.suppliers ?? 0) === 1 ? "" : "s"} ·{" "}
                        {summary.results ?? 0} result{(summary.results ?? 0) === 1 ? "" : "s"} ·{" "}
                        {timeAgo(session.startedAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Supplier quotations" description="Requests waiting for a reply." />
            {pendingQuoteRequests.length === 0 ? (
              <EmptyState
                icon={<MessageSquare size={18} aria-hidden />}
                title="No open supplier requests"
                description="Ask for supplier quotations from any sourcing result."
              />
            ) : (
              <ul className="divide-y divide-line">
                {pendingQuoteRequests.map((quote) => (
                  <li key={quote.id} className="px-4 py-3">
                    <p className="text-[13px] font-medium text-ink">{quote.supplier.name}</p>
                    <p className="text-[11px] text-muted">
                      {truncate(quote.enquiryItem?.description ?? "Request", 50)} ·{" "}
                      {quote.status === "SENT" ? `sent ${timeAgo(quote.sentAt)}` : "awaiting your approval to send"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-ink">Products being sourced</p>
                <p className="text-[11px] text-muted">Across recent enquiries</p>
              </div>
              <span className="flex items-center gap-1.5 text-2xl font-semibold tabular text-ink">
                <Boxes size={16} aria-hidden className="text-accent" />
                {activeItems}
              </span>
            </div>
            <p className="border-t border-line px-4 py-2.5 text-[11px] text-muted">
              Stock is checked before any supplier is contacted. Products are only bought after you approve a supplier.
            </p>
          </Card>

          <Card>
            <CardHeader title="System status" description="Verified now, not a decorative indicator." />
            <ul className="divide-y divide-line text-xs">
              <li className="flex items-center justify-between px-4 py-2.5">
                <span className="text-soft">Background worker</span>
                {worker.status === "HEALTHY" ? (
                  <Badge tone="ok">Active</Badge>
                ) : worker.status === "STALE" ? (
                  <Badge tone="warn">Not responding</Badge>
                ) : (
                  <Badge tone="neutral">Unknown</Badge>
                )}
              </li>
              <li className="flex items-center justify-between px-4 py-2.5">
                <span className="text-soft">Jobs waiting / running</span>
                <span className="tabular text-ink">{queue.queued} / {queue.processing}</span>
              </li>
              <li className="flex items-center justify-between px-4 py-2.5">
                <span className="text-soft">Failed jobs</span>
                <Link href="/activity" className={queue.failed > 0 ? "tabular text-danger hover:underline" : "tabular text-ink"}>
                  {queue.failed}
                </Link>
              </li>
            </ul>
            {worker.status !== "HEALTHY" ? (
              <p className="border-t border-line px-4 py-2.5 text-[11px] text-warn">
                Queued work will not move until <code className="rounded bg-elevated px-1">npm run worker</code> is running.
              </p>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
