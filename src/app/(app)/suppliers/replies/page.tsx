import Link from "next/link";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDateTime, formatMoney, truncate } from "@/lib/format";
import { MATCH_STATUS_LABELS, label } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader, statusTone } from "@/components/ui";
import { assignSupplierReplyAction, dismissSupplierReplyAction } from "@/app/actions/supplierReplies";

export const dynamic = "force-dynamic";

type ExtractedTerms = {
  unitPrice?: number | null;
  currency?: string | null;
  moq?: number | null;
  leadTimeDays?: number | null;
  shippingCost?: number | null;
  taxes?: number | null;
  otherCharges?: number | null;
  paymentTerms?: string | null;
  validityDays?: number | null;
  missingCommercial?: string[];
  description?: string | null;
};

type Correlation = {
  method?: string;
  reasons?: string[];
  possible?: Array<{ quoteId: string; confidence: number; method: string }>;
};

/**
 * Owner review for supplier email replies that could not be auto-matched.
 * Nothing is deleted; an ambiguous reply is either assigned to the correct RFQ
 * or explicitly dismissed. Offers remain unverified until the owner reviews
 * them on the sourcing screen.
 */
export default async function SupplierRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;

  const replies = await db.supplierEmailReply.findMany({
    where: { reviewStatus: "PENDING" },
    orderBy: { receivedAt: "desc" },
    take: 50,
    include: {
      supplier: { select: { name: true, email: true } },
      supplierQuote: { select: { id: true } },
    },
  });

  const possibleQuoteIds = [
    ...new Set(
      replies.flatMap((reply) =>
        parseJson<Correlation>(reply.correlationJson, {}).possible?.map((entry) => entry.quoteId) ?? [],
      ),
    ),
  ];
  const possibleQuotes = possibleQuoteIds.length
    ? await db.supplierQuote.findMany({
        where: { id: { in: possibleQuoteIds } },
        select: {
          id: true,
          subject: true,
          status: true,
          supplierId: true,
          enquiryItem: {
            select: { description: true, enquiry: { select: { publicRef: true } } },
          },
        },
      })
    : [];
  const quoteById = new Map(possibleQuotes.map((quote) => [quote.id, quote]));

  const supplierIds = [...new Set(replies.map((reply) => reply.supplierId).filter((id): id is string => Boolean(id)))];
  const openQuotes = supplierIds.length
    ? await db.supplierQuote.findMany({
        where: { supplierId: { in: supplierIds }, status: { in: ["SENT", "REQUESTED", "AWAITING_APPROVAL", "RESPONDED"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          supplierId: true,
          subject: true,
          status: true,
          enquiryItem: { select: { description: true, enquiry: { select: { publicRef: true } } } },
        },
        take: 100,
      })
    : [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Supplier communication"
        title="Supplier email replies"
        description="Replies from known suppliers are matched to the RFQ they answer. Ambiguous replies wait here for your decision; they are never attached silently."
        actions={
          <Link href="/suppliers" className="text-xs text-accent hover:underline">
            Back to suppliers
          </Link>
        }
      />

      {flags.error ? (
        <Notice tone="danger" title="Could not complete that action">
          {flags.error}
        </Notice>
      ) : null}
      {flags.saved ? <Notice tone="ok">Supplier reply updated.</Notice> : null}

      <Notice tone="info" title="Offers from email stay unverified">
        Extracted prices are drafts attached to the supplier RFQ. Confirm the supplier offer and the specification before it
        can be used in a customer quotation.
      </Notice>

      {replies.length === 0 ? (
        <Card>
          <EmptyState
            title="No supplier replies need review"
            description="Matched replies and their draft offers appear on the related enquiry and sourcing screens."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {replies.map((reply) => {
            const terms = parseJson<ExtractedTerms>(reply.extractedJson, {});
            const correlation = parseJson<Correlation>(reply.correlationJson, {});
            const candidates = (correlation.possible ?? [])
              .map((entry) => ({ entry, quote: quoteById.get(entry.quoteId) }))
              .filter((item) => item.quote);
            const supplierQuotes = openQuotes.filter((quote) => quote.supplierId === reply.supplierId);

            return (
              <Card key={reply.id}>
                <CardHeader
                  title={reply.subject || "(no subject)"}
                  description={`${reply.supplier?.name ?? reply.fromAddress} · ${reply.fromAddress} · ${formatDateTime(reply.receivedAt)}`}
                  action={
                    <Badge tone={reply.matchingStatus === "MATCHED" ? "ok" : "warn"}>
                      {reply.matchingStatus.replaceAll("_", " ").toLowerCase()}
                    </Badge>
                  }
                />
                <div className="space-y-3 px-4 py-3">
                  <p className="whitespace-pre-wrap break-words text-xs text-soft">
                    {truncate(reply.bodySummary ?? "", 600)}
                  </p>

                  <div className="grid gap-2 sm:grid-cols-4">
                    {[
                      ["Unit price", terms.unitPrice != null ? formatMoney(terms.unitPrice, terms.currency ?? "AED") : "unknown"],
                      ["MOQ", terms.moq != null ? String(terms.moq) : "unknown"],
                      ["Lead time", terms.leadTimeDays != null ? `${terms.leadTimeDays} days` : "unknown"],
                      ["Shipping", terms.shippingCost != null ? formatMoney(terms.shippingCost, terms.currency ?? "AED") : "unknown"],
                      ["Taxes", terms.taxes != null ? formatMoney(terms.taxes, terms.currency ?? "AED") : "unknown"],
                      ["Other charges", terms.otherCharges != null ? formatMoney(terms.otherCharges, terms.currency ?? "AED") : "unknown"],
                      ["Payment terms", terms.paymentTerms ?? "unknown"],
                      ["Validity", terms.validityDays != null ? `${terms.validityDays} days` : "unknown"],
                    ].map(([labelText, value]) => (
                      <div key={labelText} className="rounded-control border border-line px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted">{labelText}</p>
                        <p className="text-xs text-ink">{value}</p>
                      </div>
                    ))}
                  </div>

                  {terms.missingCommercial && terms.missingCommercial.length > 0 ? (
                    <p className="text-[11px] text-warn">
                      Not stated by the supplier: {terms.missingCommercial.join(", ")}. These remain unknown, not zero.
                    </p>
                  ) : null}

                  {correlation.reasons && correlation.reasons.length > 0 ? (
                    <p className="text-[11px] text-muted">{correlation.reasons.join(" ")}</p>
                  ) : null}

                  {candidates.length > 0 ? (
                    <div className="space-y-2 rounded-control border border-line bg-elevated/40 p-2">
                      <p className="text-[11px] font-medium text-soft">Possible RFQs</p>
                      {candidates.map(({ entry, quote }) => (
                        <form key={entry.quoteId} action={assignSupplierReplyAction} className="flex flex-wrap items-center justify-between gap-2">
                          <input type="hidden" name="replyId" value={reply.id} />
                          <input type="hidden" name="supplierQuoteId" value={entry.quoteId} />
                          <div className="min-w-0">
                            <p className="truncate text-xs text-ink">
                              {quote?.enquiryItem?.enquiry.publicRef ?? "RFQ"} · {quote?.enquiryItem?.description ?? quote?.subject ?? entry.quoteId}
                            </p>
                            <p className="text-[10px] text-muted">
                              {Math.round(entry.confidence * 100)}% · {entry.method.replaceAll("_", " ")}
                            </p>
                          </div>
                          <Button size="sm" variant="primary">
                            Match this RFQ
                          </Button>
                        </form>
                      ))}
                    </div>
                  ) : null}

                  {candidates.length === 0 && supplierQuotes.length > 0 ? (
                    <form action={assignSupplierReplyAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="replyId" value={reply.id} />
                      <label className="min-w-0 flex-1 text-[11px] text-soft">
                        Match to an outstanding RFQ
                        <select name="supplierQuoteId" className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-2 text-xs text-ink" required>
                          <option value="">Choose an RFQ</option>
                          {supplierQuotes.map((quote) => (
                            <option key={quote.id} value={quote.id}>
                              {quote.enquiryItem?.enquiry.publicRef ?? "RFQ"} · {quote.enquiryItem?.description ?? quote.subject ?? quote.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button size="sm" variant="primary">
                        Match
                      </Button>
                    </form>
                  ) : null}

                  {reply.supplierQuoteId ? (
                    <p className="text-[11px] text-muted">
                      Already attached to an RFQ. Open the sourcing screen to review the draft offer.
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                    <form action={dismissSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <input type="hidden" name="reviewStatus" value="REVIEWED" />
                      <Button size="sm">Mark reviewed</Button>
                    </form>
                    <form action={dismissSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <input type="hidden" name="reviewStatus" value="DISMISSED" />
                      <Button size="sm" variant="ghost">
                        Dismiss
                      </Button>
                    </form>
                    <span className="text-[10px] text-muted">
                      Attachments: {parseJson<Array<{ filename: string }>>(reply.attachmentsJson, []).length}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
