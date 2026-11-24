import Link from "next/link";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDateTime, formatMoney, truncate } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui";
import {
  assignSupplierReplyAction,
  confirmSupplierReplyAction,
  correctSupplierReplyFieldsAction,
  dismissSupplierReplyAction,
  linkSupplierReplySupplierAction,
  markSupplierReplyItemIrrelevantAction,
  reprocessSupplierReplyAction,
} from "@/app/actions/supplierReplies";

export const dynamic = "force-dynamic";

type Evidence = {
  source?: string | null;
  locator?: string | null;
  quote?: string | null;
  method?: string | null;
};

type QuotedItem = {
  description?: string | null;
  matched_rfq_item_ref?: string | null;
  price_basis?: "UNIT" | "TOTAL" | "UNKNOWN" | null;
  stated_specifications?: {
    product_type?: string | null;
    material?: string | null;
    grade?: string | null;
    diameter?: string | null;
    length?: string | null;
    pressure_class?: string | null;
    standard?: string | null;
    finish?: string | null;
    other?: Record<string, string> | null;
  } | null;
  unit_price?: number | null;
  total_price?: number | null;
  quantity?: number | null;
  unit_of_measure?: string | null;
  minimum_order_quantity?: number | null;
  lead_time?: string | null;
  lead_time_days?: number | null;
  shipping_cost?: number | null;
  taxes?: number | null;
  validity?: string | null;
  payment_terms?: string | null;
  availability?: string | null;
  notes?: string | null;
  alternative_to?: string | null;
  evidence?: Evidence[];
  irrelevant?: boolean;
};

type AiConflict = {
  field: string;
  deterministic: string | number | null;
  ai: string | number | null;
  source?: string | null;
};

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
  validityText?: string | null;
  description?: string | null;
  missingCommercial?: string[];
  quotedItems?: QuotedItem[];
  conflicts?: AiConflict[];
  clarificationsRequired?: string[];
  aiStatus?: string | null;
  aiError?: string | null;
  aiIntent?: string | null;
  aiConfidence?: number | null;
  provenance?: Record<string, string>;
  review?: { confirmedAt?: string; confirmedBy?: string } | null;
  ownerCorrections?: Record<string, { value: string | number | null; by: string; at: string }>;
};

type Correlation = {
  method?: string;
  confidence?: number;
  reasons?: string[];
  possible?: Array<{ quoteId: string; confidence: number; method: string }>;
  attachmentFailures?: string[];
  documentExtraction?: Array<{ filename: string; status: string; note?: string | null; sourceRefs?: string[] }>;
  offerIds?: string[];
  aiExtraction?: {
    status?: string | null;
    error?: string | null;
    intent?: string | null;
    supplierName?: string | null;
    confidence?: number | null;
    clarificationsRequired?: string[];
    conflicts?: AiConflict[];
    generalTerms?: {
      currency?: string | null;
      validity?: string | null;
      payment_terms?: string | null;
      delivery_terms?: string | null;
      shipping_terms?: string | null;
      tax_terms?: string | null;
    } | null;
    usage?: { inputTokens?: number; outputTokens?: number; model?: string } | null;
  } | null;
};

function readable(value: unknown): string {
  if (value == null || value === "") return "unknown";
  return String(value);
}

function specEntries(item: QuotedItem): Array<[string, string]> {
  const spec = item.stated_specifications;
  if (!spec) return [];
  const entries: Array<[string, string | null | undefined]> = [
    ["Type", spec.product_type],
    ["Material", spec.material],
    ["Grade", spec.grade],
    ["Diameter", spec.diameter],
    ["Length", spec.length],
    ["Pressure class", spec.pressure_class],
    ["Standard", spec.standard],
    ["Finish", spec.finish],
    ...Object.entries(spec.other ?? {}),
  ];
  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([labelText, value]) => [labelText, value]);
}

function AiStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>AI not run</Badge>;
  const tone = status === "OK" ? "ok" : status === "FAILED" ? "danger" : "warn";
  return <Badge tone={tone}>AI {status.replaceAll("_", " ").toLowerCase()}</Badge>;
}

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
        where: {
          supplierId: { in: supplierIds },
          status: { in: ["SENT", "REQUESTED", "AWAITING_APPROVAL", "RESPONDED"] },
        },
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

  // Unknown senders need a supplier picker and, once associated, an RFQ picker.
  const hasUnknownSender = replies.some((reply) => !reply.supplierId);
  const [supplierDirectory, unmatchedQuoteOptions] = hasUnknownSender
    ? await Promise.all([
        db.supplier.findMany({
          where: { status: { not: "BLOCKED" } },
          select: { id: true, name: true, email: true },
          orderBy: { name: "asc" },
          take: 300,
        }),
        db.supplierQuote.findMany({
          where: { status: { in: ["SENT", "REQUESTED", "AWAITING_APPROVAL", "RESPONDED"] } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            supplierId: true,
            subject: true,
            status: true,
            enquiryItem: { select: { description: true, enquiry: { select: { publicRef: true } } } },
          },
          take: 100,
        }),
      ])
    : [[], []];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Supplier communication"
        title="Supplier email replies"
        description="Every supplier quotation is read automatically — body text and attachments. RFQ matching stays deterministic; weak matches and unknown senders wait here for your decision."
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
        AI and document extraction create drafts only. Confirming the extracted values here records that you checked them; the
        supplier offer remains unverified until you approve it on the sourcing screen.
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
            const ai = correlation.aiExtraction ?? null;
            const aiStatus = ai?.status ?? terms.aiStatus ?? null;
            const intent = ai?.intent ?? terms.aiIntent ?? null;
            const aiQuotedItems = (ai as { quotedItems?: QuotedItem[] } | null)?.quotedItems ?? [];
            const quotedItems = terms.quotedItems ?? aiQuotedItems;
            const conflicts = ai?.conflicts ?? terms.conflicts ?? [];
            const clarifications = ai?.clarificationsRequired ?? terms.clarificationsRequired ?? [];
            const general = ai?.generalTerms ?? null;
            const candidates = (correlation.possible ?? [])
              .map((entry) => ({ entry, quote: quoteById.get(entry.quoteId) }))
              .filter((item) => item.quote);
            const supplierQuotes =
              reply.supplierId
                ? openQuotes.filter((quote) => quote.supplierId === reply.supplierId)
                : unmatchedQuoteOptions;

            return (
              <Card key={reply.id}>
                <CardHeader
                  title={reply.subject || "(no subject)"}
                  description={`${reply.supplier?.name ?? reply.fromName ?? "Unknown sender"} · ${reply.fromAddress} · ${formatDateTime(reply.receivedAt)}`}
                  action={
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <Badge tone={reply.matchingStatus === "MATCHED" ? "ok" : "warn"}>
                        {reply.matchingStatus.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                      <AiStatusBadge status={aiStatus} />
                      {intent ? <Badge>{intent.replaceAll("_", " ").toLowerCase()}</Badge> : null}
                      {terms.review?.confirmedAt ? <Badge tone="ok">checked</Badge> : null}
                    </div>
                  }
                />
                <div className="space-y-3 px-4 py-3">
                  <p className="whitespace-pre-wrap break-words text-xs text-soft">
                    {truncate(reply.bodySummary ?? "", 600)}
                  </p>

                  <div className="rounded-control border border-line bg-elevated/40 px-2 py-1.5">
                    <p className="text-[11px] text-soft">
                      <span className="font-medium text-ink">RFQ match:</span>{" "}
                      {reply.matchingStatus === "MATCHED"
                        ? `strong evidence (${correlation.method?.replaceAll("_", " ") ?? "deterministic"})`
                        : reply.matchingStatus === "NEEDS_REVIEW"
                          ? "weak or ambiguous evidence — you must choose the RFQ"
                          : "no deterministic identifier matched"}
                      {typeof correlation.confidence === "number"
                        ? ` · ${Math.round(correlation.confidence * 100)}%`
                        : ""}
                    </p>
                    {correlation.reasons && correlation.reasons.length > 0 ? (
                      <p className="mt-1 text-[11px] text-muted">{correlation.reasons.join(" ")}</p>
                    ) : null}
                  </div>

                  {aiStatus && aiStatus !== "OK" ? (
                    <Notice tone={aiStatus === "FAILED" ? "warn" : "info"} title="AI reading pass not available">
                      {ai?.error ?? terms.aiError ?? "The built-in parser handled this reply. You can reprocess it after fixing the AI configuration."}
                    </Notice>
                  ) : null}

                  <div className="grid gap-2 sm:grid-cols-4">
                    {[
                      ["Unit price", terms.unitPrice != null ? formatMoney(terms.unitPrice, terms.currency ?? "AED") : "unknown"],
                      ["Currency", terms.currency ?? "unknown"],
                      ["MOQ", terms.moq != null ? String(terms.moq) : "unknown"],
                      ["Lead time", terms.leadTimeDays != null ? `${terms.leadTimeDays} days` : "unknown"],
                      ["Shipping", terms.shippingCost != null ? formatMoney(terms.shippingCost, terms.currency ?? "AED") : "unknown"],
                      ["Taxes", terms.taxes != null ? formatMoney(terms.taxes, terms.currency ?? "AED") : "unknown"],
                      ["Other charges", terms.otherCharges != null ? formatMoney(terms.otherCharges, terms.currency ?? "AED") : "unknown"],
                      ["Payment terms", terms.paymentTerms ?? general?.payment_terms ?? "unknown"],
                      ["Validity", terms.validityDays != null ? `${terms.validityDays} days` : terms.validityText ?? general?.validity ?? "unknown"],
                      ["Delivery terms", general?.delivery_terms ?? "unknown"],
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

                  {quotedItems.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium text-soft">
                        Quoted products ({quotedItems.length})
                        {ai?.confidence != null ? ` · AI confidence ${Math.round(ai.confidence * 100)}%` : ""}
                      </p>
                      {quotedItems.map((item, index) => {
                        const price =
                          item.price_basis === "TOTAL" ? item.total_price : item.unit_price ?? item.total_price;
                        const specs = specEntries(item);
                        return (
                          <div
                            key={`${reply.id}-item-${index}`}
                            className={`space-y-1.5 rounded-control border px-2 py-2 ${
                              item.irrelevant ? "border-line opacity-60" : "border-line bg-elevated/20"
                            }`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-ink">{item.description ?? "Unnamed product"}</p>
                                <p className="text-[10px] text-muted">
                                  {item.matched_rfq_item_ref ? `RFQ line ${item.matched_rfq_item_ref} · ` : ""}
                                  {item.alternative_to ? `alternative to ${item.alternative_to} · ` : ""}
                                  {item.irrelevant ? "marked irrelevant" : "included"}
                                </p>
                              </div>
                              <div className="text-right text-xs">
                                <p className="text-ink">
                                  {price != null ? formatMoney(price, terms.currency ?? general?.currency ?? "AED") : "price unknown"}
                                </p>
                                <p className="text-[10px] text-muted">
                                  {item.price_basis === "TOTAL" ? "stated total" : item.price_basis === "UNIT" ? "unit price" : "basis unclear"}
                                </p>
                              </div>
                            </div>
                            <div className="grid gap-1 text-[11px] text-soft sm:grid-cols-4">
                              <span>Qty: {readable(item.quantity)} {item.unit_of_measure ?? ""}</span>
                              <span>MOQ: {readable(item.minimum_order_quantity)}</span>
                              <span>Lead: {item.lead_time_days != null ? `${item.lead_time_days} days` : item.lead_time ?? "unknown"}</span>
                              <span>Validity: {item.validity ?? "unknown"}</span>
                              <span>Availability: {item.availability ?? "unknown"}</span>
                              <span>Payment: {item.payment_terms ?? "unknown"}</span>
                              <span>Shipping: {item.shipping_cost != null ? formatMoney(item.shipping_cost, terms.currency ?? "AED") : "unknown"}</span>
                              <span>Taxes: {item.taxes != null ? formatMoney(item.taxes, terms.currency ?? "AED") : "unknown"}</span>
                            </div>
                            {specs.length > 0 ? (
                              <p className="text-[11px] text-soft">
                                {specs.map(([labelText, value]) => `${labelText}: ${value}`).join(" · ")}
                              </p>
                            ) : null}
                            {item.notes ? <p className="text-[11px] text-muted">{item.notes}</p> : null}
                            {item.evidence && item.evidence.length > 0 ? (
                              <ul className="space-y-0.5 text-[10px] text-muted">
                                {item.evidence.slice(0, 4).map((evidence, evidenceIndex) => (
                                  <li key={`${reply.id}-item-${index}-evidence-${evidenceIndex}`}>
                                    {evidence.source}
                                    {evidence.locator ? ` · ${evidence.locator}` : ""}
                                    {evidence.quote ? `: “${truncate(evidence.quote, 160)}”` : ""}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {!item.irrelevant ? (
                              <form action={markSupplierReplyItemIrrelevantAction}>
                                <input type="hidden" name="replyId" value={reply.id} />
                                <input type="hidden" name="itemIndex" value={index} />
                                <Button size="sm" variant="ghost">
                                  Mark product irrelevant
                                </Button>
                              </form>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {conflicts.length > 0 ? (
                    <Notice tone="warn" title="Conflicting values retained">
                      <ul className="space-y-0.5 text-[11px]">
                        {conflicts.slice(0, 8).map((conflict, index) => (
                          <li key={`${reply.id}-conflict-${index}`}>
                            {conflict.field}: document says {readable(conflict.deterministic)}, AI read {readable(conflict.ai)}. The
                            document value is kept.
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  ) : null}

                  {clarifications.length > 0 ? (
                    <div className="rounded-control border border-line px-2 py-1.5">
                      <p className="text-[11px] font-medium text-warn">Needs clarification</p>
                      <ul className="mt-1 space-y-0.5 text-[11px] text-soft">
                        {clarifications.slice(0, 8).map((entry, index) => (
                          <li key={`${reply.id}-clarification-${index}`}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {correlation.attachmentFailures && correlation.attachmentFailures.length > 0 ? (
                    <Notice tone="warn" title="Some attachments could not be read">
                      <ul className="space-y-0.5 text-[11px]">
                        {correlation.attachmentFailures.slice(0, 6).map((failure, index) => (
                          <li key={`${reply.id}-attachment-failure-${index}`}>{failure}</li>
                        ))}
                      </ul>
                    </Notice>
                  ) : null}

                  {correlation.documentExtraction && correlation.documentExtraction.length > 0 ? (
                    <p className="text-[10px] text-muted">
                      Files read:{" "}
                      {correlation.documentExtraction
                        .map(
                          (document) =>
                            `${document.filename} (${document.status.toLowerCase()}${
                              document.sourceRefs && document.sourceRefs.length > 0 ? ` · ${document.sourceRefs.slice(0, 3).join(", ")}` : ""
                            })`,
                        )
                        .join(" · ")}
                    </p>
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
                        {reply.supplierId ? "Match to an outstanding RFQ" : "Match to an outstanding RFQ (check the supplier first)"}
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

                  {!reply.supplierId ? (
                    <form action={linkSupplierReplySupplierAction} className="flex flex-wrap items-end gap-2 rounded-control border border-line bg-elevated/30 p-2">
                      <input type="hidden" name="replyId" value={reply.id} />
                      <label className="min-w-0 flex-1 text-[11px] text-soft">
                        Unknown sender — link to an existing supplier after checking the identity
                        <select name="supplierId" className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-2 text-xs text-ink" required>
                          <option value="">Choose a supplier</option>
                          {supplierDirectory.map((supplier) => (
                            <option key={supplier.id} value={supplier.id}>
                              {supplier.name}
                              {supplier.email ? ` · ${supplier.email}` : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button size="sm" variant="primary">
                        Link supplier
                      </Button>
                    </form>
                  ) : null}

                  <details className="rounded-control border border-line px-2 py-1.5">
                    <summary className="cursor-pointer text-[11px] font-medium text-soft">
                      Correct an extracted value
                    </summary>
                    <form action={correctSupplierReplyFieldsAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                      <input type="hidden" name="replyId" value={reply.id} />
                      {[
                        ["description", "Description", terms.description ?? ""],
                        ["unitPrice", "Unit price", terms.unitPrice ?? ""],
                        ["currency", "Currency", terms.currency ?? ""],
                        ["moq", "MOQ", terms.moq ?? ""],
                        ["leadTimeDays", "Lead time (days)", terms.leadTimeDays ?? ""],
                        ["shippingCost", "Shipping", terms.shippingCost ?? ""],
                        ["taxes", "Taxes", terms.taxes ?? ""],
                        ["paymentTerms", "Payment terms", terms.paymentTerms ?? ""],
                        ["validityDays", "Validity (days)", terms.validityDays ?? ""],
                      ].map(([name, labelText, value]) => (
                        <label key={name} className="text-[11px] text-soft">
                          {labelText}
                          <input
                            name={String(name)}
                            defaultValue={String(value)}
                            className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-2 text-xs text-ink"
                          />
                        </label>
                      ))}
                      <div className="sm:col-span-3">
                        <Button size="sm">Save corrections</Button>
                        <span className="ml-2 text-[10px] text-muted">Blank clears a value; the offer stays unverified.</span>
                      </div>
                    </form>
                  </details>

                  {reply.supplierQuoteId ? (
                    <p className="text-[11px] text-muted">
                      Already attached to an RFQ. Open the sourcing screen to review and verify the draft offer.
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                    <form action={confirmSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <Button size="sm" variant="primary">
                        Confirm extracted values
                      </Button>
                    </form>
                    <form action={reprocessSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <Button size="sm">Reprocess with AI</Button>
                    </form>
                    <form action={dismissSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <input type="hidden" name="reviewStatus" value="REVIEWED" />
                      <Button size="sm">Mark reviewed</Button>
                    </form>
                    <form action={dismissSupplierReplyAction}>
                      <input type="hidden" name="replyId" value={reply.id} />
                      <input type="hidden" name="reviewStatus" value="DISMISSED" />
                      <Button size="sm" variant="ghost">
                        Dismiss as irrelevant
                      </Button>
                    </form>
                    <span className="text-[10px] text-muted">
                      Attachments: {parseJson<Array<{ filename: string }>>(reply.attachmentsJson, []).length}
                      {correlation.offerIds && correlation.offerIds.length > 0 ? ` · Draft offers: ${correlation.offerIds.length}` : ""}
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
