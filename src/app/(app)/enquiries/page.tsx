import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { ENQUIRY_STATUS_LABELS, SOURCING_STATUS_LABELS, label } from "@/lib/constants";
import { timeAgo, truncate } from "@/lib/format";
import { Badge, Card, DataTable, EmptyState, PageHeader, Td, Th, statusTone, inputClass, ButtonLink } from "@/components/ui";
import { Inbox, Search } from "lucide-react";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "NEEDS_REVIEW", label: "Needs review" },
  { key: "SOURCING", label: "Sourcing" },
  { key: "AWAITING_APPROVAL", label: "Awaiting approval" },
  { key: "QUOTED", label: "Quoted" },
];

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; filter?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const status = params.status && params.status !== "all" ? params.status : undefined;
  const query = params.q?.trim();

  const enquiries = await db.enquiry.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(params.filter === "clarify" ? { items: { some: { reviewStatus: "NEEDS_CLARIFICATION" } } } : {}),
      ...(query
        ? {
            OR: [
              { customerName: { contains: query } },
              { customerPhone: { contains: query } },
              { publicRef: { contains: query } },
              { rawText: { contains: query } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 60,
    include: {
      items: { select: { id: true, description: true, inventoryStatus: true, sourcingStatus: true, missingFields: true } },
      quotations: { select: { id: true, status: true, quoteNumber: true }, orderBy: { version: "desc" }, take: 1 },
    },
  });

  const lastMessages = await db.message.findMany({
    where: { enquiryId: { in: enquiries.map((enquiry) => enquiry.id) } },
    select: { enquiryId: true, receivedAt: true },
    orderBy: { receivedAt: "desc" },
  });
  const receivedByEnquiry = new Map<string, Date>();
  for (const message of lastMessages) {
    if (message.enquiryId && !receivedByEnquiry.has(message.enquiryId)) {
      receivedByEnquiry.set(message.enquiryId, message.receivedAt);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Enquiries"
        description="Every customer request received from WhatsApp, email or added by hand."
        actions={<ButtonLink href="/enquiries/new" variant="primary">Add a request</ButtonLink>}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex flex-wrap gap-1" aria-label="Filter enquiries">
          {FILTERS.map((filter) => (
            <Link
              key={filter.key}
              href={filter.key === "all" ? "/enquiries" : `/enquiries?status=${filter.key}`}
              className={`rounded-control border px-2.5 py-1.5 text-xs transition-colors ${
                (filter.key === "all" && !status) || status === filter.key
                  ? "border-accent/40 bg-accent/10 font-medium text-accent"
                  : "border-line bg-surface text-soft hover:bg-elevated hover:text-ink"
              }`}
            >
              {filter.label}
            </Link>
          ))}
        </nav>
        <form className="flex items-center gap-2" action="/enquiries">
          <label htmlFor="q" className="sr-only">
            Search enquiries
          </label>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" aria-hidden />
            <input id="q" name="q" defaultValue={query} placeholder="Customer, reference or text" className={`${inputClass} pl-8 sm:w-64`} />
          </div>
          <button className="h-9 rounded-control border border-line bg-surface px-3 text-sm text-ink hover:bg-elevated">
            Search
          </button>
        </form>
      </div>

      <Card>
        {enquiries.length === 0 ? (
          <EmptyState
            icon={<Inbox size={18} aria-hidden />}
            title={query || status ? "No enquiries match this view" : "No enquiries yet"}
            description={
              query || status
                ? "Try clearing the filter or searching for a different customer."
                : "Connect WhatsApp or email in Settings, or add a request manually. Every new request will appear here with its products and sourcing progress."
            }
            action={<ButtonLink href="/settings/integrations">Connect a channel</ButtonLink>}
          />
        ) : (
          <DataTable minWidth={860}>
            <thead>
              <tr>
                <Th>Customer / reference</Th>
                <Th>Received</Th>
                <Th align="right">Products</Th>
                <Th>Stock position</Th>
                <Th>Stage</Th>
                <Th>Quotation</Th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((enquiry) => {
                const missing = enquiry.items.filter((item) => parseJson<string[]>(item.missingFields, []).length > 0).length;
                const inStock = enquiry.items.filter((item) => item.inventoryStatus === "AVAILABLE").length;
                const partial = enquiry.items.filter((item) => item.inventoryStatus === "PARTIAL").length;
                const sourcing = enquiry.items.filter((item) => item.sourcingStatus !== "NOT_REQUIRED").length;
                const quotation = enquiry.quotations[0];
                return (
                  <tr key={enquiry.id} className="hover:bg-elevated/60">
                    <Td>
                      <Link href={`/enquiries/${enquiry.id}`} className="font-medium text-ink hover:text-accent">
                        {enquiry.customerName || enquiry.customerPhone || "Unknown customer"}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {enquiry.publicRef} · {enquiry.channel.toLowerCase()}
                        {enquiry.isDemo ? " · sample" : ""}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-xs text-soft">{timeAgo(receivedByEnquiry.get(enquiry.id) ?? enquiry.createdAt)}</span>
                    </Td>
                    <Td align="right">
                      <span className="tabular">{enquiry.items.length}</span>
                      <span className="block text-[11px] text-muted">
                        {missing > 0 ? `${missing} need details` : `${sourcing} to source`}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {inStock > 0 ? <Badge tone="ok">{inStock} in stock</Badge> : null}
                        {partial > 0 ? <Badge tone="warn">{partial} partial</Badge> : null}
                        {enquiry.items.length - inStock - partial > 0 ? (
                          <Badge tone="neutral">{enquiry.items.length - inStock - partial} missing</Badge>
                        ) : null}
                        {enquiry.items.length === 0 ? <span className="text-xs text-muted">Not read yet</span> : null}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(enquiry.status)} dot>
                        {label(ENQUIRY_STATUS_LABELS, enquiry.status)}
                      </Badge>
                      {enquiry.items.some((item) => item.sourcingStatus === "SEARCHING") ? (
                        <span className="mt-1 block text-[11px] text-muted">
                          {label(SOURCING_STATUS_LABELS, "SEARCHING")}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {quotation ? (
                        <Link href={`/quotations/${quotation.id}`} className="text-xs text-accent hover:underline">
                          {quotation.quoteNumber} · {quotation.status.toLowerCase()}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>

      <p className="text-[11px] text-muted">
        Showing {enquiries.length} enquir{enquiries.length === 1 ? "y" : "ies"}.{" "}
        {enquiries[0] ? `Latest: ${truncate(enquiries[0].rawText, 80)}` : ""}
      </p>
    </div>
  );
}
