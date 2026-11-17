import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { MATCH_STATUS_LABELS, SOURCING_STATUS_LABELS, label } from "@/lib/constants";
import { formatMoney, timeAgo, truncate } from "@/lib/format";
import { Badge, ButtonLink, Card, CardHeader, DataTable, EmptyState, PageHeader, Td, Th, statusTone } from "@/components/ui";
import { MessageSquare, Radar } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SourcingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireUser();
  const { tab } = await searchParams;

  const [items, responses] = await Promise.all([
    db.enquiryItem.findMany({
      where: { OR: [{ quantityToSource: { gt: 0 } }, { offers: { some: {} } }] },
      orderBy: { updatedAt: "desc" },
      take: 40,
      include: {
        enquiry: { select: { id: true, publicRef: true, customerName: true, currency: true } },
        offers: true,
        searchSessions: { orderBy: { startedAt: "desc" }, take: 1 },
      },
    }),
    db.supplierQuote.findMany({
      where: { status: { in: ["RESPONDED", "SENT", "AWAITING_APPROVAL"] } },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        supplier: true,
        enquiryItem: { include: { enquiry: { select: { id: true, publicRef: true } } } },
        items: true,
      },
    }),
  ]);

  if (tab === "responses") {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Supplier quotations"
          description="Requests sent to suppliers and the prices they returned."
          actions={<ButtonLink href="/sourcing" size="sm">Back to sourcing</ButtonLink>}
        />
        <Card>
          <CardHeader title="Quotation requests" description="Only approved messages are sent." />
          {responses.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={18} aria-hidden />}
              title="No supplier quotations yet"
              description="Open a sourcing result and ask a supplier for a price. Their response appears here and in the comparison."
            />
          ) : (
            <DataTable minWidth={760}>
              <thead>
                <tr>
                  <Th>Supplier</Th>
                  <Th>Product</Th>
                  <Th>Request status</Th>
                  <Th align="right">Price</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {responses.map((quote) => {
                  const line = quote.items[0];
                  return (
                    <tr key={quote.id} className="hover:bg-elevated/60">
                      <Td>
                        <span className="font-medium text-ink">{quote.supplier.name}</span>
                        <span className="mt-0.5 block text-[11px] text-muted">{quote.supplier.email ?? quote.supplier.phone ?? "No contact recorded"}</span>
                      </Td>
                      <Td>
                        <Link href={`/sourcing/${quote.enquiryItemId}`} className="text-ink hover:text-accent">
                          {truncate(quote.enquiryItem?.description ?? line?.description ?? "—", 60)}
                        </Link>
                        <span className="mt-0.5 block text-[11px] text-muted">{quote.enquiryItem?.enquiry.publicRef}</span>
                      </Td>
                      <Td>
                        <Badge tone={statusTone(quote.status)} dot>
                          {quote.status === "AWAITING_APPROVAL"
                            ? "Waiting for your approval"
                            : quote.status === "SENT"
                              ? "Sent — no reply yet"
                              : quote.status.toLowerCase()}
                        </Badge>
                      </Td>
                      <Td align="right">
                        {line?.unitPrice != null
                          ? formatMoney(line.unitPrice, line.currency ?? "AED")
                          : "—"}
                        {line?.moq != null ? <span className="block text-[11px] text-muted">MOQ {line.moq}</span> : null}
                      </Td>
                      <Td>
                        <span className="text-xs text-soft">{timeAgo(quote.respondedAt ?? quote.sentAt ?? quote.createdAt)}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sourcing"
        description="Products that are not fully covered by stock, and what each supplier search found."
        actions={<ButtonLink href="/sourcing?tab=responses">Supplier quotations</ButtonLink>}
      />

      <Card>
        <CardHeader title="Products being sourced" description="Open a line to compare supplier offers by total estimated cost." />
        {items.length === 0 ? (
          <EmptyState
            icon={<Radar size={18} aria-hidden />}
            title="Nothing needs sourcing"
            description="When a customer requests a product that is not in stock, the search results appear here."
          />
        ) : (
          <DataTable minWidth={900}>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Customer</Th>
                <Th align="right">To buy</Th>
                <Th align="right">Options</Th>
                <Th align="right">Best eligible total</Th>
                <Th>Status</Th>
                <Th>Last checked</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const eligible = item.offers
                  .filter((offer) => offer.isEligible)
                  .map((offer) => {
                    const snapshot = parseJson<{ landed?: { total?: number | null }; evaluation?: { rank?: number | null } }>(
                      offer.landedCostJson,
                      {},
                    );
                    return { total: snapshot.landed?.total ?? null, rank: snapshot.evaluation?.rank ?? 999 };
                  })
                  .sort((a, b) => a.rank - b.rank);
                const best = eligible[0];
                const exact = item.offers.filter((offer) => offer.matchStatus === "EXACT").length;
                return (
                  <tr key={item.id} className="hover:bg-elevated/60">
                    <Td>
                      <Link href={`/sourcing/${item.id}`} className="font-medium text-ink hover:text-accent">
                        {truncate(item.description, 60)}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {[item.size, item.material, item.grade, item.pressureRating].filter(Boolean).join(" · ") || "No specification"}
                      </span>
                    </Td>
                    <Td>
                      <Link href={`/enquiries/${item.enquiry.id}`} className="text-xs text-soft hover:text-accent">
                        {item.enquiry.customerName ?? item.enquiry.publicRef}
                      </Link>
                    </Td>
                    <Td align="right">{item.quantityToSource} {item.unit}</Td>
                    <Td align="right">
                      {item.offers.length}
                      {exact > 0 ? <span className="block text-[11px] text-ok">{exact} exact</span> : null}
                    </Td>
                    <Td align="right">
                      {best?.total != null ? formatMoney(best.total, "AED") : <span className="text-muted">—</span>}
                    </Td>
                    <Td>
                      <Badge tone={statusTone(item.sourcingStatus)} dot>
                        {label(SOURCING_STATUS_LABELS, item.sourcingStatus)}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="text-xs text-soft">
                        {item.searchSessions[0] ? timeAgo(item.searchSessions[0].startedAt) : "Not searched"}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>

      <p className="text-[11px] text-muted">
        Results always state which sources were searched. MFBMT never claims to search the whole market and never presents a public listing as a confirmed supplier quotation.
      </p>
    </div>
  );
}
