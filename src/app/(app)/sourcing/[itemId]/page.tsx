import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentOrganization } from "@/lib/organization";
import { requirePermission, canSeeSupplierCosts } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { buildSpecSummary } from "@/lib/catalog/normalize";
import {
  INVENTORY_STATUS_LABELS,
  MATCH_STATUS_LABELS,
  SOURCING_STATUS_LABELS,
  label,
} from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney, formatQty, timeAgo, truncate } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, Notice, PageHeader, inputClass, statusTone, textareaClass } from "@/components/ui";
import { approveOfferAction, createSupplierQuoteAction, recordManualOfferAction, requestMoreQuotesAction } from "@/app/actions/sourcing";
import { CheckCircle2, ExternalLink, Info } from "lucide-react";

export const dynamic = "force-dynamic";

type Snapshot = {
  landed?: {
    currency?: string;
    effectiveQuantity?: number;
    productCost?: number | null;
    shipping?: number | null;
    otherCharges?: number | null;
    taxes?: number | null;
    total?: number | null;
    complete?: boolean;
    missing?: string[];
    notes?: string[];
    fx?: { rate: number; source: string | null; at: string | null } | null;
  };
  evaluation?: { rank?: number | null; eligible?: boolean; blockers?: string[]; reasons?: string[] };
  requiredQuantity?: number;
  targetCurrency?: string;
};

export default async function SourcingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ error?: string; saved?: string; approved?: string; queued?: string; requested?: string }>;
}) {
  const user = await requirePermission("sourcing.view");
  const canViewCosts = canSeeSupplierCosts(user);
  const { itemId } = await params;
  const flags = await searchParams;

  const item = await db.enquiryItem.findUnique({
    where: { id: itemId },
    include: {
      enquiry: true,
      offers: { orderBy: { createdAt: "asc" } },
      searchSessions: {
        orderBy: { startedAt: "desc" },
        take: 2,
        include: { queries: true },
      },
      supplierQuotes: { include: { supplier: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!item) notFound();

  const org = await getCurrentOrganization();
  const suppliers = await db.supplier.findMany({ where: { status: { not: "BLOCKED" } }, orderBy: { name: "asc" } });
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));

  const offers = item.offers
    .map((offer) => {
      const snapshot = parseJson<Snapshot>(offer.landedCostJson, {});
      return { offer, snapshot };
    })
    .sort((a, b) => {
      const rankA = a.snapshot.evaluation?.rank ?? 999;
      const rankB = b.snapshot.evaluation?.rank ?? 999;
      if (rankA !== rankB) return rankA - rankB;
      return (a.offer.unitPrice ?? Number.MAX_SAFE_INTEGER) - (b.offer.unitPrice ?? Number.MAX_SAFE_INTEGER);
    });

  const currency = offers[0]?.snapshot.targetCurrency ?? org?.defaultCurrency ?? "AED";
  const recommended = offers.find((entry) => entry.snapshot.evaluation?.rank === 1);
  const eligibleOffers = offers.filter((entry) => entry.snapshot.evaluation?.eligible);
  const approvedOffer = item.offers.find((offer) => offer.id === item.approvedOfferId);
  const session = item.searchSessions[0];
  const coverage = parseJson<Array<{ adapter: string; label: string; status: string; queries: number; results: number; note?: string }>>(
    session?.sourcesJson ?? "[]",
    [],
  );
  const summary = parseJson<{ suppliers?: number; results?: number; offers?: number; exactMatches?: number; rankableOffers?: number }>(
    session?.summaryJson ?? "{}",
    {},
  );

  const isOwner = user.role === "OWNER";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${item.enquiry.publicRef} · ${item.enquiry.customerName ?? "Customer"}`}
        title={truncate(item.description, 90)}
        description={buildSpecSummary({
          description: "",
          size: item.size,
          material: item.material,
          grade: item.grade,
          pressureRating: item.pressureRating,
          schedule: item.schedule,
          standard: item.standard,
          brand: item.brand,
        }) || "No further specification recorded"}
        actions={
          <>
            <ButtonLink href={`/enquiries/${item.enquiryId}`} variant="ghost" size="sm">
              Back to enquiry
            </ButtonLink>
            <Badge tone={statusTone(item.sourcingStatus)} dot>
              {label(SOURCING_STATUS_LABELS, item.sourcingStatus)}
            </Badge>
          </>
        }
      />

      {flags.error ? <Notice tone="danger" title="Action not completed">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Supplier offer recorded and compared.</Notice> : null}
      {flags.approved ? <Notice tone="ok">Supplier approved for this product. This is approval to use the option — no purchase order has been placed.</Notice> : null}
      {flags.queued ? <Notice tone="info">Another supplier search has been queued.</Notice> : null}
      {flags.requested ? <Notice tone="info">Supplier quotation request prepared. It will be sent once approved.</Notice> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">Customer needs</p>
          <p className="text-lg font-semibold tabular text-ink">{formatQty(item.quantity, item.unit)}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">Available from your stock</p>
          <p className="text-lg font-semibold tabular text-ink">{formatQty(item.quantityFromStock, item.unit)}</p>
          <p className="text-[11px] text-muted">{label(INVENTORY_STATUS_LABELS, item.inventoryStatus)}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[11px] text-muted">Quantity to buy</p>
          <p className="text-lg font-semibold tabular text-ink">{formatQty(item.quantityToSource, item.unit)}</p>
        </Card>
      </div>

      {approvedOffer ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-ok/30 bg-ok/5 px-4 py-3 text-sm">
          <CheckCircle2 size={15} className="text-ok" aria-hidden />
          <span className="text-ink">
            Approved sourcing option: <strong>{approvedOffer.supplierName}</strong>
            {canViewCosts && approvedOffer.unitPrice != null ? ` at ${formatMoney(approvedOffer.unitPrice, approvedOffer.currency ?? currency)} per ${item.unit}` : ""}.
          </span>
          <Link href={`/enquiries/${item.enquiryId}`} className="text-xs text-accent hover:underline">
            Prepare the customer quotation
          </Link>
        </div>
      ) : null}

      {offers.length === 0 ? (
        <Notice tone="warn" title="No supplier offer found yet">
          {session
            ? "The searches ran, but no verifiable offer matched this product. Nothing has been invented. You can ask a known supplier for a quote, record a price you receive, or search again."
            : "No supplier search has run for this product yet."}
        </Notice>
      ) : null}

      {recommended ? (
        <Card className="border-accent/30">
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-accent">
                <Info size={12} aria-hidden /> Recommended option
              </p>
              <p className="mt-1 text-base font-semibold text-ink">{recommended.offer.supplierName}</p>
              {canViewCosts ? (
                <p className="text-sm tabular text-ink">
                  Estimated total {formatMoney(recommended.snapshot.landed?.total ?? null, currency)}
                  <span className="ml-1 text-xs font-normal text-muted">
                    {" "}for {recommended.snapshot.landed?.effectiveQuantity ?? item.quantityToSource} {item.unit}
                  </span>
                </p>
              ) : (
                <p className="text-xs text-muted">Supplier costs are visible to the owner only.</p>
              )}
              <ul className="mt-2 space-y-1 text-xs text-soft">
                {(recommended.snapshot.evaluation?.reasons ?? []).slice(0, 3).map((reason) => (
                  <li key={reason} className="flex gap-1.5">
                    <span aria-hidden className="text-ok">•</span>
                    {reason}
                  </li>
                ))}
                {(recommended.snapshot.landed?.notes ?? []).map((note) => (
                  <li key={note} className="flex gap-1.5 text-muted">
                    <span aria-hidden>•</span>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
            {isOwner ? (
              <form action={approveOfferAction} className="shrink-0">
                <input type="hidden" name="itemId" value={item.id} />
                <input type="hidden" name="offerId" value={recommended.offer.id} />
                <Button variant="primary" size="sm">
                  Approve this supplier
                </Button>
              </form>
            ) : (
              <p className="text-[11px] text-muted">Only the owner can approve a supplier.</p>
            )}
          </div>
        </Card>
      ) : offers.length > 0 ? (
        <Notice tone="warn" title="No offer can be recommended yet">
          {eligibleOffers.length === 0
            ? "None of the offers meets the requested specification and quantity. Check the reasons below; you can request quotations from suppliers or search again."
            : "There are eligible offers, but their total cost is incomplete. Compare the known details and confirm shipping or taxes before approving."}
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Supplier comparison"
          description="Compared by total estimated landed cost, not the advertised unit price."
          action={
            isOwner ? (
              <form action={requestMoreQuotesAction}>
                <input type="hidden" name="itemId" value={item.id} />
                <Button size="sm">Search again</Button>
              </form>
            ) : undefined
          }
        />
        {offers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No offers to compare. Record a price from a supplier below, or ask a known supplier for a quotation.
          </p>
        ) : (
          <div className="scroll-x">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 1040 }}>
              <thead>
                <tr>
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Supplier</th>
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Match</th>
                  {canViewCosts ? (
                    <>
                      <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Unit price</th>
                      <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">MOQ</th>
                      <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Shipping</th>
                      <th scope="col" className="border-b border-line px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted">Est. total</th>
                    </>
                  ) : null}
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Delivery</th>
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Price date</th>
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Status</th>
                  <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted">Decision</th>
                </tr>
              </thead>
              <tbody>
                {offers.map(({ offer, snapshot }) => {
                  const evaluation = snapshot.evaluation;
                  const expired = offer.validityDate ? offer.validityDate.getTime() < Date.now() : false;
                  const isRecommended = evaluation?.rank === 1;
                  return (
                    <tr key={offer.id} className={isRecommended ? "bg-accent/[0.06]" : "hover:bg-elevated/50"}>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-ink">{offer.supplierName}</span>
                          {offer.isDemo ? <Badge tone="warn">Sample</Badge> : null}
                          {isRecommended ? <Badge tone="accent">Recommended</Badge> : null}
                        </div>
                        <span className="mt-0.5 block text-[11px] text-muted">
                          {offer.sourceType === "PUBLIC_WEB"
                            ? "Public listing"
                            : offer.sourceType === "SUPPLIER_QUOTE"
                              ? "Supplier quotation"
                              : offer.sourceType === "INTERNAL_DB"
                                ? "Your supplier records"
                                : "Entered by your company"}
                        </span>
                        {offer.sourceUrl ? (
                          <a
                            href={offer.sourceUrl}
                            target="_blank"
                            rel="noreferrer nofollow"
                            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                          >
                            View source <ExternalLink size={10} aria-hidden />
                          </a>
                        ) : null}
                      </td>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top">
                        <Badge tone={offer.matchStatus === "EXACT" ? "ok" : offer.matchStatus === "NO_MATCH" ? "danger" : "warn"}>
                          {label(MATCH_STATUS_LABELS, offer.matchStatus)}
                        </Badge>
                        {offer.verificationStatus !== "VERIFIED" ? (
                          <span className="mt-1 block text-[11px] text-muted">
                            {offer.verificationStatus === "PARTIAL" ? "Specification partly verified" : "Not verified"}
                          </span>
                        ) : null}
                      </td>
                      {canViewCosts ? (
                        <>
                          <td className="border-b border-line/70 px-3 py-2.5 align-top text-right tabular whitespace-nowrap">
                            {offer.unitPrice != null ? formatMoney(offer.unitPrice, offer.currency ?? currency) : <span className="text-muted">Not listed</span>}
                          </td>
                          <td className="border-b border-line/70 px-3 py-2.5 align-top text-right tabular">{offer.moq ?? "—"}</td>
                          <td className="border-b border-line/70 px-3 py-2.5 align-top text-right tabular">
                            {offer.shippingCost != null ? formatMoney(offer.shippingCost, offer.currency ?? currency) : <span className="text-warn">Unknown</span>}
                          </td>
                          <td className="border-b border-line/70 px-3 py-2.5 align-top text-right tabular whitespace-nowrap">
                            <span className={snapshot.landed?.complete ? "font-medium text-ink" : "text-warn"}>
                              {snapshot.landed?.total != null ? formatMoney(snapshot.landed.total, currency) : "Incomplete"}
                            </span>
                            {!snapshot.landed?.complete && (snapshot.landed?.missing?.length ?? 0) > 0 ? (
                              <span className="mt-0.5 block text-[10px] text-muted">Missing {snapshot.landed?.missing?.join(", ").toLowerCase()}</span>
                            ) : null}
                          </td>
                        </>
                      ) : null}
                      <td className="border-b border-line/70 px-3 py-2.5 align-top text-xs text-soft">
                        {offer.leadTimeDays != null ? `${offer.leadTimeDays} day${offer.leadTimeDays === 1 ? "" : "s"}` : <span className="text-muted">Not stated</span>}
                        {offer.quantityAvailable != null ? <span className="block text-[11px] text-muted">{offer.quantityAvailable} available</span> : null}
                      </td>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top text-xs text-soft">
                        {offer.quotedAt ? formatDate(offer.quotedAt) : "—"}
                        {expired ? <span className="block text-[11px] text-danger">Expired</span> : offer.validityDate ? (
                          <span className="block text-[11px] text-muted">Valid to {formatDate(offer.validityDate)}</span>
                        ) : null}
                      </td>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top">
                        <Badge tone={statusTone(offer.status)}>{offer.status.replaceAll("_", " ").toLowerCase()}</Badge>
                        {offer.isEligible ? (
                          <span className="mt-1 block text-[11px] text-ok">Can be used</span>
                        ) : (
                          <span className="mt-1 block max-w-[190px] text-[11px] text-muted">{offer.ineligibilityReason ?? "Not eligible"}</span>
                        )}
                      </td>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top">
                        {isOwner && offer.isEligible ? (
                          <form action={approveOfferAction}>
                            <input type="hidden" name="itemId" value={item.id} />
                            <input type="hidden" name="offerId" value={offer.id} />
                            <Button size="sm">Approve</Button>
                          </form>
                        ) : (
                          <span className="text-[11px] text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {offers.length > 0 ? (
          <details className="border-t border-line">
            <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-soft hover:text-ink">
              Show the evidence behind each offer
            </summary>
            <div className="space-y-3 border-t border-line px-4 py-3">
              {offers.map(({ offer, snapshot }) => {
                const evidence = parseJson<Record<string, unknown>>(offer.evidenceJson, {});
                const match = evidence.match as { reasons?: string[]; missing?: string[] } | undefined;
                return (
                  <div key={offer.id} className="rounded-card border border-line p-3">
                    <p className="text-xs font-medium text-ink">{offer.supplierName} — {offer.productTitle}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      {offer.productTitle ? `Listed as: ${truncate(offer.productTitle, 160)}` : "No product title recorded"}
                    </p>
                    {match?.reasons?.length ? (
                      <ul className="mt-1 list-disc pl-4 text-[11px] text-soft">
                        {match.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    ) : null}
                    {match?.missing?.length ? (
                      <p className="mt-1 text-[11px] text-warn">Not disclosed: {match.missing.join(", ")}.</p>
                    ) : null}
                    {snapshot.landed?.fx ? (
                      <p className="mt-1 text-[11px] text-muted">
                        Converted at {snapshot.landed.fx.rate} ({snapshot.landed.fx.source ?? "source not recorded"})
                        {snapshot.landed.fx.at ? ` on ${formatDate(snapshot.landed.fx.at)}` : ""}.
                      </p>
                    ) : null}
                    {(snapshot.landed?.notes ?? []).map((note) => (
                      <p key={note} className="mt-1 text-[11px] text-muted">{note}</p>
                    ))}
                    <p className="mt-1 text-[11px] text-muted">
                      Retrieved {offer.quotedAt ? formatDateTime(offer.quotedAt) : "unknown"}
                      {offer.quoteRef ? ` · reference ${offer.quoteRef}` : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where the search looked" description="Only connected sources are searched. Nothing is scraped past a block." />
          {!session ? (
            <p className="px-4 py-4 text-sm text-muted">No search has run yet.</p>
          ) : (
            <div className="space-y-3 px-4 py-3">
              <p className="text-xs text-soft">
                {summary.suppliers ?? 0} supplier{(summary.suppliers ?? 0) === 1 ? "" : "s"} found across{" "}
                {coverage.filter((entry) => entry.status === "OK").length} connected source
                {coverage.filter((entry) => entry.status === "OK").length === 1 ? "" : "s"} ·{" "}
                {summary.results ?? 0} result{(summary.results ?? 0) === 1 ? "" : "s"} · {summary.exactMatches ?? 0} exact match
                {(summary.exactMatches ?? 0) === 1 ? "" : "es"}
              </p>
              <ul className="space-y-2">
                {coverage.map((entry) => (
                  <li key={entry.adapter} className="flex items-start justify-between gap-3 rounded-card border border-line px-3 py-2">
                    <div>
                      <p className="text-xs font-medium text-ink">{entry.label}</p>
                      <p className="text-[11px] text-muted">
                        {entry.queries} search{entry.queries === 1 ? "" : "es"} · {entry.results} result
                        {entry.results === 1 ? "" : "s"}
                        {entry.note ? ` · ${entry.note}` : ""}
                      </p>
                    </div>
                    <Badge tone={statusTone(entry.status)}>
                      {entry.status === "OK"
                        ? "Searched"
                        : entry.status === "NOT_CONFIGURED"
                          ? "Not connected"
                          : entry.status.toLowerCase()}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted">Last checked {timeAgo(session.startedAt)}.</p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Ask a supplier" description="Sends only after your approval, from your connected company account." />
          <div className="space-y-4 px-4 py-3">
            {!isOwner ? (
              <p className="text-sm text-muted">Only the owner can request supplier quotations or record supplier prices.</p>
            ) : suppliers.length === 0 ? (
              <p className="text-sm text-muted">
                No suppliers are saved yet. <Link href="/suppliers" className="text-accent hover:underline">Add a supplier</Link> with an email or WhatsApp number.
              </p>
            ) : (
              <form action={createSupplierQuoteAction} className="space-y-2">
                <input type="hidden" name="itemId" value={item.id} />
                <label htmlFor="supplierId" className="block text-xs font-medium text-soft">
                  Supplier
                </label>
                <select id="supplierId" name="supplierId" className={inputClass} required>
                  <option value="">Choose a supplier…</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                      {supplier.email ? ` — ${supplier.email}` : supplier.whatsapp ? ` — WhatsApp ${supplier.whatsapp}` : " — no contact saved"}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted">
                  A secure, expiring form link is included so the supplier can submit price, MOQ, lead time and validity without seeing your dashboard.
                </p>
                <Button size="sm">Prepare quotation request</Button>
              </form>
            )}

            {item.supplierQuotes.length > 0 ? (
              <div className="space-y-1.5 border-t border-line pt-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Requests for this product</p>
                {item.supplierQuotes.map((quote) => (
                  <p key={quote.id} className="text-[11px] text-soft">
                    {quote.supplier.name} — {quote.status === "RESPONDED" ? "replied" : quote.status === "SENT" ? "sent, waiting" : "waiting for your approval"}
                    {quote.expiresAt ? ` · link expires ${formatDate(quote.expiresAt)}` : ""}
                  </p>
                ))}
                {item.supplierQuotes.some((quote) => quote.status === "AWAITING_APPROVAL") ? (
                  <Link href="/approvals" className="text-[11px] text-accent hover:underline">
                    Approve the message before it is sent
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      {isOwner ? (
      <Card>
        <CardHeader title="Record a price you received" description="For prices confirmed by phone, WhatsApp or email. It is marked as entered by your company, not scraped." />
        <details className="group">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-accent hover:underline">
            Add supplier offer
          </summary>
          <form action={recordManualOfferAction} className="grid gap-3 border-t border-line px-4 py-4 sm:grid-cols-3">
            <input type="hidden" name="itemId" value={item.id} />
            <label className="block text-xs text-soft">
              Supplier name *
              <input name="supplierName" required className={`${inputClass} mt-1`} list="supplier-options" />
              <datalist id="supplier-options">
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.name} />)}
              </datalist>
            </label>
            <label className="block text-xs text-soft">
              Product as offered
              <input name="productTitle" defaultValue={item.description} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Reference (quote no. / email)
              <input name="reference" className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Unit price *
              <input name="unitPrice" required inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Currency
              <input name="currency" defaultValue={currency} className={`${inputClass} mt-1`} maxLength={3} />
            </label>
            <label className="block text-xs text-soft">
              Minimum order quantity
              <input name="moq" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Shipping cost
              <input name="shippingCost" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Other charges
              <input name="otherCharges" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Taxes (if quoted separately)
              <input name="taxes" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Lead time (days)
              <input name="leadTimeDays" inputMode="numeric" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Quantity available
              <input name="quantityAvailable" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Quote valid until
              <input name="validityDate" type="date" className={`${inputClass} mt-1`} />
            </label>
            <div className="sm:col-span-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                Specification confirmed by the supplier
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block text-xs text-soft">
                  Size offered
                  <input name="offeredSize" defaultValue={item.size ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Material offered
                  <input name="offeredMaterial" defaultValue={item.material ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Pressure rating offered
                  <input name="offeredPressure" defaultValue={item.pressureRating ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Grade offered
                  <input name="offeredGrade" defaultValue={item.grade ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Standard offered
                  <input name="offeredStandard" defaultValue={item.standard ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Brand offered
                  <input name="offeredBrand" defaultValue={item.brand ?? ""} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Thread system offered
                  <input name="offeredThread" className={`${inputClass} mt-1`} placeholder="METRIC_COARSE / UNC / UNF" />
                </label>
                <label className="block text-xs text-soft">
                  Pitch offered (mm)
                  <input name="offeredPitch" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
                </label>
                <label className="block text-xs text-soft">
                  Length offered (mm)
                  <input name="offeredLength" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
                </label>
                <label className="block text-xs text-soft">
                  Fastener type offered
                  <input name="offeredFastenerType" className={`${inputClass} mt-1`} placeholder="HEX_BOLT / HEX_NUT" />
                </label>
                <label className="block text-xs text-soft">
                  Property class offered
                  <input name="offeredPropertyClass" className={`${inputClass} mt-1`} placeholder="8.8 / 10.9 / A2-70" />
                </label>
                <label className="block text-xs text-soft">
                  Finish offered
                  <input name="offeredFinish" className={`${inputClass} mt-1`} placeholder="ZINC_PLATED / HOT_DIP_GALVANIZED" />
                </label>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                Leave a field blank if the supplier did not confirm it. A blank required specification is never treated as an exact match.
              </p>
            </div>
            <label className="block text-xs text-soft sm:col-span-3">
              Payment terms / notes
              <textarea name="paymentTerms" rows={2} className={`${textareaClass} mt-1`} />
            </label>
            <div className="sm:col-span-3">
              <Button size="sm" variant="primary">Save supplier offer</Button>
            </div>
          </form>
        </details>
      </Card>
      ) : null}
    </div>
  );
}
