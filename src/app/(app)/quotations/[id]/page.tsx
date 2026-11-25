import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { marginPct } from "@/lib/pricing/rules";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, Notice, PageHeader, inputClass, statusTone } from "@/components/ui";
import { generateQuotationPdfAction, sendQuotationAction, setQuotationOutcomeAction, updateQuotationPriceAction, updateQuotationTechnicalAction } from "@/app/actions/quotations";

export const dynamic = "force-dynamic";

export default async function QuotationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; pdf?: string; sent?: string; error?: string }>;
}) {
  const user = await requirePermission("quotations.view");
  const { id } = await params;
  const flags = await searchParams;

  const quotation = await db.customerQuotation.findUnique({
    where: { id },
    include: {
      items: true,
      enquiry: true,
      approvedBy: { select: { name: true } },
    },
  });
  if (!quotation) notFound();

  const approval = await db.approval.findFirst({
    where: { type: "CUSTOMER_QUOTATION", entityId: quotation.id },
    orderBy: { createdAt: "desc" },
  });

  const isOwner = user.role === "OWNER";
  // A new quotation is created AWAITING_APPROVAL, so prices must stay editable
  // until the approval is decided, not only in DRAFT.
  const canPrice = isOwner && (quotation.status === "DRAFT" || quotation.status === "AWAITING_APPROVAL");
  const costKnown = quotation.internalCostComplete && quotation.internalCostTotal != null;
  const internalMargin = costKnown ? quotation.subtotal - (quotation.internalCostTotal ?? 0) : null;
  const totalQty = quotation.items.reduce((sum, line) => sum + line.quantity, 0);
  const org = await db.organization.findUnique({ where: { id: quotation.organizationId } });
  const belowFloor =
    org && org.minMarginPct > 0 && costKnown && internalMargin != null && quotation.subtotal > 0
      ? (internalMargin / quotation.subtotal) * 100 < org.minMarginPct
      : false;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${quotation.enquiry.publicRef} · version ${quotation.version}`}
        title={`Quotation ${quotation.quoteNumber}`}
        description={`${quotation.customerName} · ${formatDate(quotation.createdAt)}`}
        actions={
          <>
            <ButtonLink href={`/enquiries/${quotation.enquiryId}`} variant="ghost" size="sm">Back to enquiry</ButtonLink>
            <Badge tone={statusTone(quotation.status)} dot>{quotation.status.replaceAll("_", " ").toLowerCase()}</Badge>
          </>
        }
      />

      {flags.error ? <Notice tone="danger" title="Action not completed">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Quotation updated.</Notice> : null}
      {flags.pdf ? <Notice tone="ok">PDF created. Use the download button to open it.</Notice> : null}
      {flags.sent ? <Notice tone="ok">{flags.sent}</Notice> : null}

      {quotation.changeSummary ? (
        <Notice tone="info" title="What changed in this revision">
          {quotation.changeSummary}
        </Notice>
      ) : null}
      {belowFloor && !quotation.marginExceptionReason ? (
        <Notice tone="danger" title="Below your margin floor">
          The recorded margin is below the {org?.minMarginPct}% floor. PDF creation and release are blocked until you approve an explicit
          margin exception on the approval screen.
        </Notice>
      ) : null}
      {quotation.marginExceptionReason ? (
        <Notice tone="warn" title="Owner margin exception recorded">
          {quotation.marginExceptionReason}
        </Notice>
      ) : null}

      {quotation.status === "AWAITING_APPROVAL" ? (
        <Notice tone="warn" title="This quotation is not approved yet">
          It cannot be sent until you approve it.{" "}
          {approval ? <Link href={`/approvals/${approval.id}`} className="text-accent underline">Review the approval</Link> : null}
        </Notice>
      ) : null}
      {quotation.status === "DRAFT" ? (
        <Notice tone="info" title="Draft">
          A previous approval was sent back for changes. Edit the prices below, then request approval again from the enquiry.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Quotation lines"
              description="Customer-facing description and selling prices. Supplier costs are never shown to the customer."
            />
            <div className="scroll-x">
              <table
                className="w-full text-sm"
                style={{ minWidth: canPrice ? 800 : isOwner ? 640 : 560 }}
              >
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-muted">
                    <th scope="col" className="border-b border-line px-3 py-2 text-left">Item</th>
                    <th scope="col" className="border-b border-line px-3 py-2 text-right">Qty</th>
                    {isOwner ? <th scope="col" className="border-b border-line px-3 py-2 text-right">Cost</th> : null}
                    <th scope="col" className="border-b border-line px-3 py-2 text-right">Unit price</th>
                    <th scope="col" className="border-b border-line px-3 py-2 text-right">Total</th>
                    {canPrice ? <th scope="col" className="border-b border-line px-3 py-2 text-right">Set price</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {quotation.items.map((line) => (
                    <tr key={line.id}>
                      <td className="border-b border-line/70 px-3 py-2.5 align-top">
                        <p className="text-ink">{line.description}</p>
                        {line.specs && line.specs !== line.description ? (
                          <p className="mt-0.5 text-[11px] text-muted">{line.specs}</p>
                        ) : null}
                        {line.supplierOfferId ? (
                          <p className="mt-0.5 text-[10px] text-muted">Sourced from an approved supplier option</p>
                        ) : (
                          <p className="mt-0.5 text-[10px] text-warn">No approved supplier — price set manually</p>
                        )}
                      </td>
                      <td className="border-b border-line/70 px-3 py-2.5 text-right align-top tabular">{line.quantity} {line.unit}</td>
                      {isOwner ? (
                        <td className="border-b border-line/70 px-3 py-2.5 text-right align-top tabular text-muted">
                          {formatMoney(line.costPrice, quotation.currency)}
                        </td>
                      ) : null}
                      <td className="border-b border-line/70 px-3 py-2.5 text-right align-top tabular">{formatMoney(line.unitPrice, quotation.currency)}</td>
                      <td className="border-b border-line/70 px-3 py-2.5 text-right align-top tabular">{formatMoney(line.lineTotal, quotation.currency)}</td>
                      {canPrice ? (
                        <td className="border-b border-line/70 px-3 py-2 align-top">
                          <form action={updateQuotationPriceAction} className="flex items-center justify-end gap-1">
                            <input type="hidden" name="quotationId" value={quotation.id} />
                            <input type="hidden" name="itemId" value={line.id} />
                            <input
                              name="unitPrice"
                              defaultValue={line.unitPrice ?? ""}
                              inputMode="decimal"
                              aria-label={`Selling price for ${line.description}`}
                              className={`${inputClass} h-8 w-24 tabular`}
                            />
                            <Button size="sm">Save</Button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={isOwner ? 4 : 3} className="px-3 py-2 text-right text-xs text-muted">Subtotal</td>
                    <td className="px-3 py-2 text-right text-sm tabular text-ink">{formatMoney(quotation.subtotal, quotation.currency)}</td>
                    {canPrice ? <td /> : null}
                  </tr>
                  {quotation.taxAmount > 0 ? (
                    <tr>
                      <td colSpan={isOwner ? 4 : 3} className="px-3 py-2 text-right text-xs text-muted">Tax</td>
                      <td className="px-3 py-2 text-right text-sm tabular text-ink">{formatMoney(quotation.taxAmount, quotation.currency)}</td>
                      {canPrice ? <td /> : null}
                    </tr>
                  ) : null}
                  <tr>
                    <td colSpan={isOwner ? 4 : 3} className="px-3 py-2 text-right text-xs font-medium text-ink">Total</td>
                    <td className="px-3 py-2 text-right text-base font-semibold tabular text-ink">{formatMoney(quotation.total, quotation.currency)}</td>
                    {canPrice ? <td /> : null}
                  </tr>
                </tfoot>
              </table>
            </div>
            <details className="border-t border-line">
              <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-soft hover:text-ink">
                Per-line technical terms, origin, certification and delivery
              </summary>
              <div className="space-y-3 border-t border-line px-4 py-3">
                {quotation.items.map((line) => (
                  <form key={line.id} action={updateQuotationTechnicalAction} className="grid gap-2 rounded-control border border-line p-3 sm:grid-cols-3">
                    <input type="hidden" name="quotationId" value={quotation.id} />
                    <input type="hidden" name="itemId" value={line.id} />
                    <p className="text-xs font-medium text-ink sm:col-span-3">{line.description}</p>
                    <label className="block text-[11px] text-soft">Country of origin<input name="countryOfOrigin" defaultValue={line.countryOfOrigin ?? ""} className={`${inputClass} mt-1`} /></label>
                    <label className="block text-[11px] text-soft">Certification<input name="certification" defaultValue={line.certification ?? ""} className={`${inputClass} mt-1`} placeholder="EN 10204 3.1" /></label>
                    <label className="block text-[11px] text-soft">Lead time (days)<input name="leadTimeDays" inputMode="numeric" defaultValue={line.leadTimeDays ?? ""} className={`${inputClass} mt-1 tabular`} /></label>
                    <label className="block text-[11px] text-soft">Delivery terms<input name="deliveryTerms" defaultValue={line.deliveryTerms ?? ""} className={`${inputClass} mt-1`} placeholder="DAP Dubai" /></label>
                    <label className="block text-[11px] text-soft">Line validity<input name="validityDate" type="date" defaultValue={line.validityDate ? line.validityDate.toISOString().slice(0, 10) : ""} className={`${inputClass} mt-1`} /></label>
                    <label className="block text-[11px] text-soft">Technical note<input name="technicalNotes" defaultValue={line.technicalNotes ?? ""} className={`${inputClass} mt-1`} /></label>
                    <div className="sm:col-span-3"><Button size="sm">Save technical terms</Button></div>
                  </form>
                ))}
              </div>
            </details>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <p className="text-[11px] text-muted">
                Valid until {quotation.validityDate ? formatDate(quotation.validityDate) : "not set"} · {totalQty} unit(s).
              </p>
              <div className="flex flex-wrap gap-2">
                {isOwner && ["APPROVED", "SENT"].includes(quotation.status) ? (
                  <form action={generateQuotationPdfAction}>
                    <input type="hidden" name="quotationId" value={quotation.id} />
                    <Button size="sm">{quotation.pdfPath ? "Regenerate PDF" : "Create PDF"}</Button>
                  </form>
                ) : !["APPROVED", "SENT"].includes(quotation.status) ? (
                  <span className="text-[11px] text-muted">PDF can be created after approval.</span>
                ) : null}
                {quotation.pdfPath ? (
                  <ButtonLink href={`/api/quotations/${quotation.id}/pdf`} size="sm">Download PDF</ButtonLink>
                ) : null}
                {["APPROVED", "SENT"].includes(quotation.status) ? (
                  <ButtonLink href={`/api/quotations/${quotation.id}/excel`} size="sm">Download Excel</ButtonLink>
                ) : null}
                {isOwner && quotation.status === "APPROVED" ? (
                  <form action={sendQuotationAction} className="flex flex-wrap items-end gap-2 rounded-control border border-line bg-elevated/40 px-2.5 py-2">
                    <input type="hidden" name="quotationId" value={quotation.id} />
                    <label className="text-[11px] text-muted">
                      Send by
                      <select name="channel" defaultValue={quotation.customerEmail ? "EMAIL" : quotation.customerPhone ? "WHATSAPP" : "MANUAL"} className={`${inputClass} mt-0.5 h-8 w-36`}>
                        <option value="EMAIL">Email (system sends)</option>
                        <option value="WHATSAPP">WhatsApp document</option>
                        <option value="MANUAL">I sent it manually</option>
                      </select>
                    </label>
                    <label className="text-[11px] text-muted">
                      To
                      <input name="to" defaultValue={quotation.customerEmail ?? quotation.customerPhone ?? ""} className={`${inputClass} mt-0.5 h-8 w-52`} />
                    </label>
                    <label className="text-[11px] text-muted">
                      Manual note (optional)
                      <input name="manualNote" placeholder="e.g. handed over at the office" className={`${inputClass} mt-0.5 h-8 w-48`} />
                    </label>
                    <Button size="sm" variant="primary">Release quotation</Button>
                    <p className="w-full text-[10px] text-muted">
                      Email/WhatsApp are only recorded as sent when the provider accepts the message. “I sent it manually” records your
                      own confirmation — no message is sent by the system.
                    </p>
                  </form>
                ) : null}
              </div>
            </div>
          </Card>

          {quotation.notes ? (
            <Card className="px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Notes on this quotation</p>
              <p className="mt-1 text-sm text-soft">{quotation.notes}</p>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          {isOwner ? (
            <Card>
              <CardHeader title="Internal only" description="Never printed on the customer quotation." />
              <dl className="space-y-2 px-4 py-3 text-xs">
                <div className="flex justify-between"><dt className="text-muted">Estimated supplier cost</dt><dd className="tabular text-ink">{costKnown ? formatMoney(quotation.internalCostTotal, quotation.currency) : "Not complete"}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Gross margin</dt><dd className="tabular text-ink">{internalMargin != null ? formatMoney(internalMargin, quotation.currency) : "—"}</dd></div>
                <div className="flex justify-between">
                  <dt className="text-muted">Margin</dt>
                  <dd className="tabular text-ink">{costKnown ? `${marginPct(quotation.internalCostTotal, quotation.subtotal) ?? "—"}%` : "—"}</dd>
                </div>
              </dl>
              <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
                {costKnown
                  ? "Based on approved supplier landed costs and recorded stock cost at the time of preparation."
                  : "Cost is incomplete because a stock unit cost or supplier cost is missing. No margin is claimed."}
              </p>
            </Card>
          ) : null}

          {isOwner && ["APPROVED", "SENT"].includes(quotation.status) ? (
            <Card>
              <CardHeader title="Outcome" description="Record what the customer decided. This drives the conversion report." />
              <form action={setQuotationOutcomeAction} className="space-y-2 px-4 py-3">
                <input type="hidden" name="quotationId" value={quotation.id} />
                <label className="block text-xs text-soft">Result
                  <select name="outcome" defaultValue={quotation.outcome ?? "NO_RESPONSE"} className={`${inputClass} mt-1`}>
                    <option value="WON">Won</option>
                    <option value="LOST">Lost</option>
                    <option value="NO_RESPONSE">No response</option>
                  </select>
                </label>
                <label className="block text-xs text-soft">Reason / note<input name="reason" defaultValue={quotation.outcomeReason ?? ""} className={`${inputClass} mt-1`} /></label>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted">{quotation.outcomeAt ? `Recorded ${formatDateTime(quotation.outcomeAt)}` : "Not recorded yet"}</span>
                  <Button size="sm">Record outcome</Button>
                </div>
              </form>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Customer" />
            <dl className="space-y-1.5 px-4 py-3 text-xs">
              <div className="flex justify-between gap-2"><dt className="text-muted">Name</dt><dd className="text-ink">{quotation.customerName}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Phone</dt><dd className="text-ink">{quotation.customerPhone ?? "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Email</dt><dd className="break-all text-right text-ink">{quotation.customerEmail ?? "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Enquiry</dt><dd><Link href={`/enquiries/${quotation.enquiryId}`} className="text-accent hover:underline">{quotation.enquiry.publicRef}</Link></dd></div>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Approval record" />
            <div className="px-4 py-3 text-xs">
              {quotation.approvedAt ? (
                <p className="text-soft">
                  Approved by {quotation.approvedBy?.name ?? "owner"} on {formatDateTime(quotation.approvedAt)}.
                </p>
              ) : (
                <p className="text-warn">Not approved. This quotation cannot be recorded as sent until it is approved.</p>
              )}
              {quotation.sentAt ? (
                <p className="mt-2 text-soft">
                  Recorded as sent on {formatDateTime(quotation.sentAt)}
                  {quotation.sentChannel ? ` via ${quotation.sentChannel.toLowerCase()}` : ""}
                  {quotation.sentTo ? ` to ${quotation.sentTo}` : ""}.
                </p>
              ) : null}
              {quotation.sendError ? (
                <p className="mt-2 text-danger">Last release attempt failed: {quotation.sendError}</p>
              ) : null}
              {quotation.pricingExceptionById ? (
                <p className="mt-2 text-warn">
                  Released with an owner pricing exception: {quotation.pricingExceptionReason ?? "no reason recorded"}.
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
