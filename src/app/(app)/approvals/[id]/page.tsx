import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { MATCH_STATUS_LABELS, OFFER_STATUS_LABELS, label } from "@/lib/constants";
import { formatDate, formatMoney, formatQty, timeAgo } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, Notice, PageHeader, statusTone, textareaClass } from "@/components/ui";
import { decideApprovalAction } from "@/app/actions/approvals";

export const dynamic = "force-dynamic";

type Snapshot = {
  landed?: { total?: number | null; effectiveQuantity?: number; complete?: boolean; missing?: string[]; notes?: string[] };
  evaluation?: { rank?: number | null; eligible?: boolean; blockers?: string[]; reasons?: string[] };
  targetCurrency?: string;
};

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;
  const flags = await searchParams;

  const approval = await db.approval.findUnique({
    where: { id },
    include: {
      enquiry: true,
      decidedBy: { select: { name: true } },
    },
  });
  if (!approval) notFound();

  const payload = parseJson<Record<string, unknown>>(approval.payloadJson, {});

  let item = null as Awaited<ReturnType<typeof db.enquiryItem.findUnique>> | null;
  let offers: Array<{
    id: string;
    supplierName: string;
    productTitle: string;
    matchStatus: string;
    status: string;
    unitPrice: number | null;
    currency: string | null;
    moq: number | null;
    leadTimeDays: number | null;
    validityDate: Date | null;
    isEligible: boolean;
    ineligibilityReason: string | null;
    verificationStatus: string;
    snapshot: Snapshot;
  }> = [];

  if (approval.type === "SOURCING") {
    item = await db.enquiryItem.findUnique({ where: { id: approval.entityId } });
    const raw = await db.supplierOffer.findMany({
      where: { enquiryItemId: approval.entityId },
      orderBy: { createdAt: "asc" },
    });
    offers = raw
      .map((offer) => ({
        id: offer.id,
        supplierName: offer.supplierName,
        productTitle: offer.productTitle,
        matchStatus: offer.matchStatus,
        status: offer.status,
        unitPrice: offer.unitPrice,
        currency: offer.currency,
        moq: offer.moq,
        leadTimeDays: offer.leadTimeDays,
        validityDate: offer.validityDate,
        isEligible: offer.isEligible,
        ineligibilityReason: offer.ineligibilityReason,
        verificationStatus: offer.verificationStatus,
        snapshot: parseJson<Snapshot>(offer.landedCostJson, {}),
      }))
      .sort((a, b) => (a.snapshot.evaluation?.rank ?? 999) - (b.snapshot.evaluation?.rank ?? 999));
  }

  const quotation =
    approval.type === "CUSTOMER_QUOTATION"
      ? await db.customerQuotation.findUnique({ where: { id: approval.entityId }, include: { items: true } })
      : null;

  const quoteRequest =
    approval.type === "SUPPLIER_QUOTE_SEND"
      ? await db.supplierQuote.findUnique({ where: { id: approval.entityId }, include: { supplier: true, items: true } })
      : null;
  const quoteQuality = quoteRequest
    ? parseJson<{ findings?: Array<{ severity: string; message: string }> }>(
        quoteRequest.draftQualityJson ?? "{}",
        {},
      )
    : {};
  const quoteQualityErrors = (quoteQuality.findings ?? []).filter((finding) => finding.severity === "error");
  const quoteQualityWarnings = (quoteQuality.findings ?? []).filter((finding) => finding.severity === "warning");

  const currency = offers[0]?.snapshot.targetCurrency ?? quotation?.currency ?? "AED";
  const top = offers.find((offer) => offer.snapshot.evaluation?.rank === 1);
  const pending = approval.status === "PENDING";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${approval.enquiry?.publicRef ?? ""} · requested ${timeAgo(approval.createdAt)}`}
        title={
          approval.type === "SOURCING"
            ? "Choose the supplier for this product"
            : approval.type === "CUSTOMER_QUOTATION"
              ? "Approve the customer quotation"
              : "Approve the supplier message"
        }
        description={
          approval.type === "SOURCING"
            ? "Compare all options, then approve the one your company should use when quoting the customer."
            : approval.type === "CUSTOMER_QUOTATION"
              ? "The quotation is not sent to the customer until you approve it."
              : "This message is not sent until you approve it."
        }
        actions={<ButtonLink href="/approvals" size="sm" variant="ghost">All approvals</ButtonLink>}
      />

      {flags.error ? <Notice tone="danger" title="Decision not recorded">{flags.error}</Notice> : null}
      {!pending ? (
        <Notice tone="info" title="Already decided">
          This approval was {approval.status.toLowerCase().replaceAll("_", " ")} by {approval.decidedBy?.name ?? "the owner"} {timeAgo(approval.decidedAt)}.
          {approval.reason ? ` Reason: ${approval.reason}` : ""}
        </Notice>
      ) : null}

      {item && approval.type === "SOURCING" ? (
        <Card>
          <CardHeader title="What the customer asked for" />
          <div className="grid gap-3 px-4 py-3 sm:grid-cols-4">
            <div>
              <p className="text-[11px] text-muted">Product</p>
              <p className="text-sm text-ink">{item.description}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Specification</p>
              <p className="text-xs text-soft">
                {[item.size, item.material, item.grade, item.pressureRating, item.schedule, item.standard].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted">From stock / to buy</p>
              <p className="text-sm tabular text-ink">
                {formatQty(item.quantityFromStock, item.unit)} / {formatQty(item.quantityToSource, item.unit)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Needed by</p>
              <p className="text-sm text-ink">{approval.enquiry?.deliveryDate ? formatDate(approval.enquiry.deliveryDate) : "Not stated"}</p>
            </div>
          </div>
        </Card>
      ) : null}

      {top && approval.type === "SOURCING" ? (
        <Notice tone="ok" title="Our recommendation">
          {top.supplierName} at an estimated total of {formatMoney(top.snapshot.landed?.total ?? null, currency)}.
          {(top.snapshot.evaluation?.reasons ?? []).slice(0, 2).join(" ")}
          {top.verificationStatus !== "VERIFIED" ? " The price came from a listing and should be confirmed with the supplier." : ""}
        </Notice>
      ) : null}

      {offers.length > 0 && approval.type === "SOURCING" ? (
        <Card>
          <CardHeader title="Supplier options" description="Only eligible offers can be approved as a normal decision." />
          <form action={decideApprovalAction} className="space-y-4 px-4 py-3">
            <input type="hidden" name="approvalId" value={approval.id} />
            <ul className="space-y-2">
              {offers.map((offer) => {
                const recommended = offer.snapshot.evaluation?.rank === 1;
                return (
                  <li key={offer.id} className="rounded-card border border-line">
                    <label className="flex cursor-pointer items-start gap-3 p-3">
                      <input
                        type="radio"
                        name="selectedOfferId"
                        value={offer.id}
                        defaultChecked={recommended}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-ink">{offer.supplierName}</span>
                          {recommended ? <Badge tone="accent">Recommended</Badge> : null}
                          <Badge tone={offer.matchStatus === "EXACT" ? "ok" : "warn"}>
                            {label(MATCH_STATUS_LABELS, offer.matchStatus)}
                          </Badge>
                          {!offer.isEligible ? <Badge tone="danger">Not eligible</Badge> : null}
                        </span>
                        <span className="mt-1 block text-xs text-soft">
                          {offer.unitPrice != null ? `${formatMoney(offer.unitPrice, offer.currency ?? currency)} per unit` : "No price"}
                          {offer.moq != null ? ` · MOQ ${offer.moq}` : ""}
                          {offer.leadTimeDays != null ? ` · ${offer.leadTimeDays} days` : " · lead time not stated"}
                          {" · "}
                          <span className={offer.snapshot.landed?.complete ? "font-medium text-ink" : "text-warn"}>
                            estimated total {offer.snapshot.landed?.total != null ? formatMoney(offer.snapshot.landed.total, currency) : "incomplete"}
                          </span>
                        </span>
                        {offer.ineligibilityReason ? (
                          <span className="mt-1 block text-[11px] text-warn">{offer.ineligibilityReason}</span>
                        ) : null}
                        <span className="mt-1 block text-[11px] text-muted">
                          {label(OFFER_STATUS_LABELS, offer.status)} · {offer.verificationStatus === "VERIFIED" ? "confirmed by supplier" : "not confirmed by supplier"}
                          {offer.validityDate ? ` · valid to ${formatDate(offer.validityDate)}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <label className="block text-xs text-soft">
              Reason or note (required when overriding the recommendation)
              <textarea name="reason" rows={2} className={`${textareaClass} mt-1`} placeholder="e.g. Existing supplier, faster delivery" />
            </label>

            <div className="flex flex-wrap gap-2">
              <Button variant="primary" name="decision" value="APPROVED">
                Approve selected supplier
              </Button>
              <Button name="decision" value="REJECTED">
                Reject
              </Button>
              <Button name="decision" value="CHANGES_REQUESTED" variant="ghost">
                Ask for more quotations
              </Button>
            </div>
            <p className="text-[11px] text-muted">
              Approval records your decision and unlocks the customer quotation step. It does not purchase anything.
            </p>
          </form>
        </Card>
      ) : null}

      {quotation && approval.type === "CUSTOMER_QUOTATION" ? (
        <Card>
          <CardHeader title={`Quotation ${quotation.quoteNumber}`} description="Internal view. Supplier costs are never shown to the customer." />
          <div className="space-y-3 px-4 py-3">
            <div className="scroll-x">
              <table className="w-full text-sm" style={{ minWidth: 620 }}>
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-2 py-2 text-left">Item</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Cost</th>
                    <th className="px-2 py-2 text-right">Selling price</th>
                    <th className="px-2 py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {quotation.items.map((line) => (
                    <tr key={line.id} className="border-t border-line/70">
                      <td className="px-2 py-2 text-ink">{line.description}</td>
                      <td className="px-2 py-2 text-right tabular">{line.quantity} {line.unit}</td>
                      <td className="px-2 py-2 text-right tabular text-muted">{formatMoney(line.costPrice, quotation.currency)}</td>
                      <td className="px-2 py-2 text-right tabular">{formatMoney(line.unitPrice, quotation.currency)}</td>
                      <td className="px-2 py-2 text-right tabular">{formatMoney(line.lineTotal, quotation.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <p className="text-sm text-ink">
                Total <span className="font-semibold tabular">{formatMoney(quotation.total, quotation.currency)}</span>
                {quotation.notes ? <span className="block text-[11px] text-warn">{quotation.notes}</span> : null}
              </p>
              <ButtonLink href={`/quotations/${quotation.id}`} size="sm">Open quotation</ButtonLink>
            </div>
            {Array.isArray(payload.complianceWarnings) && payload.complianceWarnings.length > 0 ? (
              <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-warn">Compliance checklist</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-soft">
                  {(payload.complianceWarnings as string[]).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {pending ? (
              <form action={decideApprovalAction} className="space-y-2 border-t border-line pt-3">
                <input type="hidden" name="approvalId" value={approval.id} />
                <label className="block text-xs text-soft">
                  Note (optional)
                  <textarea name="reason" rows={2} className={`${textareaClass} mt-1`} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" name="decision" value="APPROVED">
                    Approve quotation
                  </Button>
                  <Button name="decision" value="REJECTED">
                    Send back for changes
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      {quoteRequest && approval.type === "SUPPLIER_QUOTE_SEND" ? (
        <Card>
          <CardHeader title="Message to supplier" description={`To ${quoteRequest.supplier.name}`} />
          <div className="space-y-3 px-4 py-3">
            {quoteQualityErrors.length > 0 ? (
              <Notice tone="danger" title="This draft cannot be sent yet">
                <p className="mb-1">The quality check blocked sending because of these problems:</p>
                <ul className="list-disc space-y-1 pl-4">
                  {quoteQualityErrors.map((finding) => (
                    <li key={finding.message}>{finding.message}</li>
                  ))}
                </ul>
              </Notice>
            ) : quoteQualityWarnings.length > 0 ? (
              <Notice tone="warn" title="Review these draft notes">
                <ul className="list-disc space-y-1 pl-4">
                  {quoteQualityWarnings.map((finding) => (
                    <li key={finding.message}>{finding.message}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <div className="rounded-card border border-line bg-bg p-3 text-[13px]">
              <p className="font-medium text-ink">Subject: {quoteRequest.subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-soft">{quoteRequest.messageBody}</p>
            </div>
            {quoteRequest.supplier.email ? (
              <p className="text-[11px] text-muted">Will be sent by email from your connected company mailbox.</p>
            ) : (
              <p className="text-[11px] text-muted">Will be sent by WhatsApp from the connected business number.</p>
            )}
            {pending ? (
              <form action={decideApprovalAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="approvalId" value={approval.id} />
                <Button variant="primary" name="decision" value="APPROVED">
                  Approve and send
                </Button>
                <Button name="decision" value="REJECTED">
                  Do not send
                </Button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      {approval.type === "SOURCING" && offers.length === 0 ? (
        <Notice tone="warn" title="No offers to approve">
          No supplier options exist for this product. Go back to the sourcing screen to record a price or search again.
        </Notice>
      ) : null}

      {approval.enquiryId ? (
        <p className="text-[11px] text-muted">
          <Link href={`/enquiries/${approval.enquiryId}`} className="text-accent hover:underline">
            Open the full enquiry
          </Link>{" "}
          · Decision recorded by {user.name} will be kept permanently in the activity log.
        </p>
      ) : null}

      <span className="sr-only">{String(payload.description ?? "")}</span>
    </div>
  );
}
