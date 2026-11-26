import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  convertAcceptanceReviewAction,
  dismissAcceptanceReviewAction,
  rejectAcceptanceReviewAction,
} from "@/app/actions/orders";
import { Badge, Button, Card, CardHeader, DataTable, Notice, PageHeader, Td, Th, inputClass, statusTone } from "@/components/ui";
import {
  acceptanceReviewById,
  reviewComparison,
  reviewPurchaseOrder,
} from "@/lib/orders/customerAcceptance";
import { toMoneyString } from "@/lib/orders/money";

export const dynamic = "force-dynamic";

export default async function AcceptanceReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; blocking?: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const flags = await searchParams;
  const review = await acceptanceReviewById(id);
  if (!review) notFound();

  const comparison = reviewComparison(review);
  const purchaseOrder = reviewPurchaseOrder(review);
  const extraction = parseJson<{ status?: string; error?: string | null; isPurchaseOrder?: boolean }>(
    review.extractionJson,
    {},
  );
  const blocking = flags.blocking ? parseJson<Array<{ code: string; message: string }>>(flags.blocking, []) : [];
  const pending = review.status === "PENDING";
  const readable = comparison.isPurchaseOrder && purchaseOrder != null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Customer acceptance · ${review.quotation.quoteNumber} v${review.quotationVersion}`}
        title={review.quotation.customerName}
        description={`Received ${formatDateTime(review.receivedAt)}${
          review.fromAddress ? ` from ${review.fromAddress}` : ""
        }. The quotation sent to this customer is the only source of commercial terms.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(review.status)} dot>
              {review.status.toLowerCase()}
            </Badge>
            <Link href="/orders" className="text-xs font-medium text-accent hover:underline">
              All sales orders
            </Link>
          </div>
        }
      />

      {flags.error ? (
        <Notice tone="danger" title="Action not completed">
          {flags.error}
        </Notice>
      ) : null}
      {flags.saved ? <Notice tone="ok">{flags.saved}</Notice> : null}

      {blocking.length > 0 ? (
        <Notice tone="warn" title="Changed commercial terms must be decided">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {blocking.map((item, index) => (
              <li key={`${item.code}-${index}`}>{item.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {!readable && pending ? (
        <Notice tone="warn" title="The document could not be read as a purchase order">
          {extraction.error
            ? `The reading pass reported: ${extraction.error}.`
            : "The email did not contain an order, signed acceptance or an unambiguous instruction to proceed."}{" "}
          The original email and its files are retained. Use the manual acceptance form on the orders screen after checking
          the document; no order has been created.
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Quotation</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {review.quotation.quoteNumber} · v{review.quotationVersion}
          </p>
          <p className="mt-1 text-[12px] text-muted">
            {review.quotation.currency} {toMoneyString(review.quotation.total)} · sent{" "}
            {formatDate(review.quotation.sentAt)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Customer document</p>
          <p className="mt-1 text-sm font-semibold text-ink">{purchaseOrder?.po_number ?? review.customerPoNumber ?? "—"}</p>
          <p className="mt-1 text-[12px] text-muted">
            {purchaseOrder?.po_date ? `Dated ${purchaseOrder.po_date}` : "No PO date read"}
            {purchaseOrder?.currency ? ` · ${purchaseOrder.currency}` : ""}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Correlation</p>
          <p className="mt-1 text-sm font-semibold text-ink">{review.provider ?? "Email"}</p>
          <p className="mt-1 break-all text-[12px] text-muted">{review.subject ?? "No subject"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Evidence retained</p>
          <p className="mt-1 text-sm font-semibold text-ink">{review.attachments.length} file(s)</p>
          <p className="mt-1 text-[12px] text-muted">
            {review.attachments.length === 0
              ? "Email body only"
              : review.attachments.map((attachment) => attachment.filename).join(", ")}
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Differences from the quotation"
          description="Each difference is computed from the exact quotation version that was sent. Nothing is changed automatically."
        />
        {comparison.discrepancies.length === 0 ? (
          <p className="px-4 py-4 text-sm text-soft">
            {readable
              ? "The customer's document matches the quotation on every compared term."
              : "No comparison is available because the document was not read as a purchase order."}
          </p>
        ) : (
          <DataTable minWidth={760}>
            <thead>
              <tr>
                <Th>Term</Th>
                <Th>Line</Th>
                <Th>Quoted</Th>
                <Th>Requested</Th>
                <Th>Severity</Th>
              </tr>
            </thead>
            <tbody>
              {comparison.discrepancies.map((discrepancy, index) => (
                <tr key={`${discrepancy.code}-${discrepancy.field}-${index}`}>
                  <Td>
                    <span className="font-medium text-ink">{discrepancy.code.replaceAll("_", " ")}</span>
                    <span className="mt-0.5 block text-[11px] text-muted">{discrepancy.message}</span>
                  </Td>
                  <Td>{discrepancy.description}</Td>
                  <Td>{discrepancy.quoted ?? "—"}</Td>
                  <Td>{discrepancy.requested ?? "—"}</Td>
                  <Td>
                    <Badge tone={discrepancy.severity === "BLOCKING" ? "danger" : "warn"}>{discrepancy.severity.toLowerCase()}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {purchaseOrder ? (
        <Card>
          <CardHeader
            title="Customer document as read"
            description="Extracted values are evidence, not approval. Blank values were not stated in the document."
          />
          <div className="grid gap-x-6 gap-y-2 px-4 py-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
            <p><span className="text-muted">Payment terms:</span> {purchaseOrder.payment_terms ?? "not stated"}</p>
            <p><span className="text-muted">Delivery terms:</span> {purchaseOrder.delivery_terms ?? "not stated"}</p>
            <p><span className="text-muted">Delivery address:</span> {purchaseOrder.delivery_address ?? "not stated"}</p>
            <p><span className="text-muted">Requested date:</span> {purchaseOrder.requested_delivery_date ?? "not stated"}</p>
            <p><span className="text-muted">Tax amount:</span> {purchaseOrder.tax_amount ?? "not stated"}</p>
            <p><span className="text-muted">Tax rate:</span> {purchaseOrder.tax_rate_pct != null ? `${purchaseOrder.tax_rate_pct}%` : "not stated"}</p>
            <p className="sm:col-span-2"><span className="text-muted">Conditions:</span> {purchaseOrder.conditions ?? "none stated"}</p>
          </div>
          <DataTable minWidth={760}>
            <thead>
              <tr>
                <Th>Description</Th>
                <Th>Specification</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Unit price</Th>
                <Th align="right">Line total</Th>
              </tr>
            </thead>
            <tbody>
              {purchaseOrder.lines.map((line, index) => (
                <tr key={`${line.description}-${index}`}>
                  <Td>{line.description}</Td>
                  <Td>{line.specifications ?? "—"}</Td>
                  <Td align="right">
                    {line.quantity ?? "—"} {line.unit ?? ""}
                  </Td>
                  <Td align="right">{line.unit_price ?? "—"}</Td>
                  <Td align="right">{line.line_total ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {purchaseOrder.notes ? <p className="border-t border-line px-4 py-2 text-[12px] text-muted">{purchaseOrder.notes}</p> : null}
        </Card>
      ) : null}

      {review.bodySummary ? (
        <Card>
          <CardHeader title="Original email" description="Retained exactly as received, before any interpretation." />
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 text-[12px] leading-5 text-soft">
            {review.bodySummary}
          </pre>
        </Card>
      ) : null}

      {pending ? (
        <Card>
          <CardHeader
            title="Your decision"
            description="Accepting the original terms binds the order to this quotation version. Approving revised terms records why the changed terms are acceptable. Rejecting creates no order."
          />
          {readable ? (
            <div className="space-y-5 px-4 py-4">
              <form action={convertAcceptanceReviewAction} className="space-y-3">
                <input type="hidden" name="reviewId" value={review.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-soft">Decision</span>
                    <select name="decision" className={inputClass} defaultValue="ACCEPT_ORIGINAL">
                      <option value="ACCEPT_ORIGINAL">Accept the original quotation terms</option>
                      <option value="APPROVE_REVISED">Approve the customer&apos;s revised terms</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-soft">Reason (required when approving a revision)</span>
                    <input name="reason" className={inputClass} placeholder="Why the changed terms are acceptable" />
                  </label>
                </div>
                <Button type="submit" variant="primary" size="sm">
                  Create sales order
                </Button>
              </form>
              <form action={rejectAcceptanceReviewAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                <input type="hidden" name="reviewId" value={review.id} />
                <label className="block min-w-64 flex-1">
                  <span className="mb-1 block text-xs font-medium text-soft">Reject the customer document</span>
                  <input name="reason" className={inputClass} placeholder="Why this document cannot be accepted" required />
                </label>
                <Button type="submit" variant="secondary" size="sm">
                  Reject
                </Button>
              </form>
            </div>
          ) : (
            <div className="space-y-3 px-4 py-4">
              <p className="text-sm text-soft">
                Conversion is disabled until the document is understood as a purchase order. The manual form on the orders
                screen remains available for an owner-checked entry.
              </p>
              <form action={dismissAcceptanceReviewAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="reviewId" value={review.id} />
                <label className="block min-w-64 flex-1">
                  <span className="mb-1 block text-xs font-medium text-soft">Dismiss this review</span>
                  <input name="reason" className={inputClass} placeholder="Optional note" />
                </label>
                <Button type="submit" variant="secondary" size="sm">
                  Dismiss
                </Button>
              </form>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader title="Outcome" description="Recorded when the review was decided." />
          <div className="px-4 py-3 text-sm text-soft">
            <p>
              Status: <span className="font-medium text-ink">{review.status.toLowerCase()}</span>
              {review.reviewedAt ? ` · ${formatDateTime(review.reviewedAt)}` : ""}
            </p>
            {review.reviewNote ? <p className="mt-1 text-[12px] text-muted">{review.reviewNote}</p> : null}
            {review.salesOrder ? (
              <p className="mt-2">
                <Link href={`/orders/${review.salesOrder.id}`} className="font-medium text-accent hover:underline">
                  Open sales order {review.salesOrder.orderNumber} →
                </Link>
              </p>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}
