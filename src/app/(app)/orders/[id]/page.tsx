import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { parseJson } from "@/lib/json";
import { Badge, Button, ButtonLink, Card, CardHeader, DataTable, Notice, PageHeader, Td, Th, inputClass, statusTone, textareaClass } from "@/components/ui";
import { dec, money, toMoneyString } from "@/lib/orders/money";
import { orderMetrics, deliveryAvailability } from "@/lib/orders/metrics";
import { orderProgress, SALES_ORDER_STATUS_LABELS } from "@/lib/orders/state";
import { PURCHASE_ORDER_STATUS_LABELS, procurementPlan, purchaseOrdersForOrder } from "@/lib/orders/purchaseOrders";
import { dealClosureSummary } from "@/lib/orders/closure";
import { deliveriesForOrder } from "@/lib/orders/delivery";
import { customerInvoicesForOrder } from "@/lib/orders/invoicing";
import { customerPaymentsForOrder, supplierBillsForOrder } from "@/lib/orders/payments";
import {
  approvePurchaseOrderAction,
  closeSalesOrderAction,
  createProcurementAction,
  issueInvoiceAction,
  recordAcknowledgementAction,
  recordDeliveryAction,
  recordPaymentAction,
  recordProofOfDeliveryAction,
  recordReceiptAction,
  recordSupplierBillAction,
  recordSupplierPaymentAction,
  resolveDiscrepancyAction,
  reversePaymentAction,
  reviewAcknowledgementAction,
  sendPurchaseOrderAction,
} from "@/app/actions/orders";

export const dynamic = "force-dynamic";

const ACK_OUTCOMES = ["ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REVISED", "REJECTED"] as const;
const RECEIPT_CONDITIONS = ["OK", "DAMAGED", "WRONG_PRODUCT", "WRONG_SPEC", "SHORT", "EXCESS"] as const;

export default async function SalesOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string; blocking?: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const flags = await searchParams;

  const order = await db.salesOrder.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      quotation: { select: { id: true, quoteNumber: true, version: true, status: true, sentAt: true } },
      enquiry: { select: { id: true, publicRef: true } },
      discrepancies: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();

  const [metrics, plan, purchaseOrders, deliveries, invoices, payments, bills, closure] = await Promise.all([
    db.$transaction((tx) => orderMetrics(tx, order.id)),
    procurementPlan(order.id),
    purchaseOrdersForOrder(order.id),
    deliveriesForOrder(order.id),
    customerInvoicesForOrder(order.id),
    customerPaymentsForOrder(order.id),
    supplierBillsForOrder(order.id),
    dealClosureSummary(order.id),
  ]);

  const invoiceIds = invoices.map((invoice) => invoice.id);
  const billIds = bills.map((bill) => bill.id);
  const poIds = purchaseOrders.map((po) => po.id);
  const events = await db.orderStatusEvent.findMany({
    where: {
      OR: [
        { entityType: "SalesOrder", entityId: order.id },
        { entityType: "PurchaseOrder", entityId: { in: poIds } },
        { entityType: "CustomerInvoice", entityId: { in: invoiceIds } },
        { entityType: "SupplierBill", entityId: { in: billIds } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 80,
  });

  const progress = orderProgress(metrics);
  const availability = deliveryAvailability(metrics);
  const openDiscrepancies = order.discrepancies.filter((discrepancy) => discrepancy.status === "OPEN");
  const blockingReasons = flags.blocking ? parseJson<string[]>(flags.blocking, []) : [];
  const closed = order.status === "CLOSED";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${order.enquiry?.publicRef ?? "No enquiry"} · quotation ${order.quotation.quoteNumber} v${order.quotation.version}`}
        title={`Sales order ${order.orderNumber}`}
        description={`${order.customerName} · accepted ${formatDate(order.acceptedAt)}${order.customerPoNumber ? ` · customer PO ${order.customerPoNumber}` : ""}`}
        actions={
          <>
            <ButtonLink href="/orders" variant="ghost" size="sm">
              All orders
            </ButtonLink>
            <ButtonLink href={`/quotations/${order.quotation.id}`} variant="ghost" size="sm">
              Quotation
            </ButtonLink>
            <Badge tone={statusTone(order.status)} dot>
              {SALES_ORDER_STATUS_LABELS[order.status] ?? order.status}
            </Badge>
          </>
        }
      />

      {flags.error ? (
        <Notice tone="danger" title="Action not completed">
          {flags.error}
        </Notice>
      ) : null}
      {flags.saved ? <Notice tone="ok">{flags.saved}</Notice> : null}
      {blockingReasons.length > 0 ? (
        <Notice tone="warn" title="Closure is blocked">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Order value</p>
          <p className="mt-1 text-lg font-semibold tabular text-ink">
            {order.currency} {toMoneyString(order.total)}
          </p>
          <p className="mt-1 text-[11px] text-muted">Net {toMoneyString(order.subtotal)} · tax {toMoneyString(order.taxAmount)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Delivered</p>
          <p className="mt-1 text-lg font-semibold tabular text-ink">{progress.deliveredPct}%</p>
          <p className="mt-1 text-[11px] text-muted">
            {progress.delivered} of {progress.ordered} units
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Open supplier commitments</p>
          <p className="mt-1 text-lg font-semibold tabular text-ink">{toMoneyString(dec(closure?.obligations.openSupplierValue ?? 0))}</p>
          <p className="mt-1 text-[11px] text-muted">{closure?.obligations.openSupplierQty ?? 0} units · {closure?.obligations.openSupplierOrders ?? 0} POs open</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Customer balance</p>
          <p className="mt-1 text-lg font-semibold tabular text-ink">
            {order.currency} {closure?.obligations.outstandingCustomerBalance ?? "0.00"}
          </p>
          <p className="mt-1 text-[11px] text-muted">Invoiced {closure?.obligations.invoicedTotal ?? "0.00"} · paid {closure?.obligations.paidTotal ?? "0.00"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Closure</p>
          <p className="mt-1 text-sm font-semibold text-ink">{closure?.readyToClose ? "All conditions met" : `${closure?.blockingReasons.length ?? 0} obligation(s) open`}</p>
          <p className="mt-1 text-[11px] text-muted">
            {closed ? `Closed ${formatDate(order.closedAt)}` : `Unbilled ${order.currency} ${closure?.obligations.unbilledValue ?? "0.00"}`}
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Order lines"
          description="The accepted commercial snapshot. Stock cover and external procurement are tracked separately."
        />
        <DataTable minWidth={980}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Product</Th>
              <Th align="right">Ordered</Th>
              <Th align="right">From stock</Th>
              <Th align="right">To procure</Th>
              <Th align="right">Accepted from suppliers</Th>
              <Th align="right">Dispatched</Th>
              <Th align="right">Delivered</Th>
              <Th align="right">Invoiced</Th>
              <Th align="right">Unit price</Th>
              <Th align="right">Line value</Th>
            </tr>
          </thead>
          <tbody>
            {metrics.lines.map((line, index) => (
              <tr key={line.id}>
                <Td>{index + 1}</Td>
                <Td>
                  <span className="text-ink">{line.description}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">{line.unit}</span>
                </Td>
                <Td align="right">{line.quantity.toFixed(4)}</Td>
                <Td align="right">{line.stockQuantity.toFixed(4)}</Td>
                <Td align="right">{line.procureQuantity.toFixed(4)}</Td>
                <Td align="right">{line.receivedAccepted.toFixed(4)}</Td>
                <Td align="right">{line.dispatched.toFixed(4)}</Td>
                <Td align="right">{line.delivered.toFixed(4)}</Td>
                <Td align="right">{line.invoiced.toFixed(4)}</Td>
                <Td align="right">{toMoneyString(line.unitPrice)}</Td>
                <Td align="right">
                  {order.currency} {toMoneyString(money(line.quantity.times(line.unitPrice)))}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        <div className="grid gap-3 border-t border-line px-4 py-3 text-[12px] text-muted sm:grid-cols-3">
          <p>Delivery: {order.deliveryTerms ?? "not specified"} {order.agreedDeliveryDate ? `· agreed ${formatDate(order.agreedDeliveryDate)}` : ""}</p>
          <p>Payment: {order.paymentTerms ?? "not specified"}</p>
          <p>Address: {order.deliveryAddress ?? "not recorded"}</p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Supplier procurement"
          description="Only stock-uncovered quantities are purchased. Each purchase uses an owner-verified supplier offer and needs separate approval before sending."
        />
        {purchaseOrders.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">No supplier purchase order has been raised for this order.</p>
        ) : (
          <div className="divide-y divide-line">
            {purchaseOrders.map((po) => {
              const accepted = new Map<string, number>();
              for (const receipt of po.receipts) {
                for (const line of receipt.lines) {
                  accepted.set(line.purchaseOrderLineId, (accepted.get(line.purchaseOrderLineId) ?? 0) + Number(line.quantityAccepted));
                }
              }
              const remainingLines = po.lines
                .map((line) => ({ line, remaining: Number(line.quantity) - (accepted.get(line.id) ?? 0) }))
                .filter((entry) => entry.remaining > 0.0001);
              const pendingAck = po.acknowledgements.find((ack) => ack.reviewStatus === "PENDING");
              const canApprove = po.status === "AWAITING_APPROVAL";
              const canSend = po.status === "APPROVED";
              const canAcknowledge = ["SENT", "ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REVISED"].includes(po.status) && !pendingAck;
              const canReceive = ["SENT", "ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REVISED", "PARTIALLY_RECEIVED"].includes(po.status) && remainingLines.length > 0;
              const canBill = po.receipts.length > 0;

              return (
                <div key={po.id} className="space-y-4 px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">
                        {po.poNumber} · {po.supplier.name}
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {po.currency} {toMoneyString(po.total)} · version {po.version}
                        {po.expectedDeliveryDate ? ` · required ${formatDate(po.expectedDeliveryDate)}` : ""}
                        {po.sentAt ? ` · sent ${formatDateTime(po.sentAt)}` : ""}
                      </p>
                    </div>
                    <Badge tone={statusTone(po.status)} dot>
                      {PURCHASE_ORDER_STATUS_LABELS[po.status] ?? po.status}
                    </Badge>
                  </div>

                  <DataTable minWidth={720}>
                    <thead>
                      <tr>
                        <Th>Product</Th>
                        <Th align="right">Ordered</Th>
                        <Th align="right">Supplier confirmed</Th>
                        <Th align="right">Accepted</Th>
                        <Th align="right">Unit price</Th>
                        <Th align="right">Line total</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.lines.map((line) => (
                        <tr key={line.id}>
                          <Td>{line.description}</Td>
                          <Td align="right">{Number(line.quantity).toFixed(4)} {line.unit}</Td>
                          <Td align="right">
                            {line.acknowledgedQuantity == null ? "Not confirmed" : `${Number(line.acknowledgedQuantity).toFixed(4)} ${line.unit}`}
                          </Td>
                          <Td align="right">{(accepted.get(line.id) ?? 0).toFixed(4)}</Td>
                          <Td align="right">{toMoneyString(line.unitPrice)}</Td>
                          <Td align="right">{order.currency} {toMoneyString(line.lineTotal)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>

                  <div className="flex flex-wrap gap-2">
                    {canApprove ? (
                      <form action={approvePurchaseOrderAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="purchaseOrderId" value={po.id} />
                        <input type="hidden" name="salesOrderId" value={order.id} />
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted">Approval note (optional)</span>
                          <input name="reason" className={inputClass} placeholder="Why this purchase is authorised" />
                        </label>
                        <Button type="submit" variant="primary" size="sm">
                          Approve purchase order
                        </Button>
                      </form>
                    ) : null}
                    {canSend ? (
                      <form action={sendPurchaseOrderAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="purchaseOrderId" value={po.id} />
                        <input type="hidden" name="salesOrderId" value={order.id} />
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted">Send to</span>
                          <input name="to" className={inputClass} defaultValue={po.supplier.email ?? ""} placeholder="supplier email" />
                        </label>
                        <Button type="submit" variant="primary" size="sm">
                          Send purchase order
                        </Button>
                      </form>
                    ) : null}
                  </div>

                  {pendingAck ? (
                    <div className="rounded-card border border-warn/30 bg-warn/5 p-3">
                      <p className="text-[13px] font-medium text-ink">
                        Supplier replied: {pendingAck.outcome.replaceAll("_", " ").toLowerCase()}
                        {pendingAck.promisedDate ? ` · promised ${formatDate(pendingAck.promisedDate)}` : ""}
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] text-soft">
                        {parseJson<Array<{ code: string; detail: string }>>(pendingAck.deviationsJson, []).map((deviation, index) => (
                          <li key={`${deviation.code}-${index}`}>{deviation.detail}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px] text-muted">No purchase term has changed. Approving revised terms creates a new PO version.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <form action={reviewAcknowledgementAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="acknowledgementId" value={pendingAck.id} />
                          <input type="hidden" name="salesOrderId" value={order.id} />
                          <input type="hidden" name="decision" value="APPROVE" />
                          <input name="note" className={inputClass} placeholder="Reason for accepting the supplier's terms" />
                          <Button type="submit" variant="primary" size="sm">
                            Approve supplier terms
                          </Button>
                        </form>
                        <form action={reviewAcknowledgementAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="acknowledgementId" value={pendingAck.id} />
                          <input type="hidden" name="salesOrderId" value={order.id} />
                          <input type="hidden" name="decision" value="DISMISS" />
                          <input name="note" className={inputClass} placeholder="Why the reply does not change the order" />
                          <Button type="submit" variant="secondary" size="sm">
                            Keep original PO terms
                          </Button>
                        </form>
                      </div>
                    </div>
                  ) : null}

                  {canAcknowledge ? (
                    <form action={recordAcknowledgementAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="purchaseOrderId" value={po.id} />
                      <input type="hidden" name="salesOrderId" value={order.id} />
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">What did the supplier say?</span>
                        <select name="outcome" className={inputClass} defaultValue="ACKNOWLEDGED">
                          {ACK_OUTCOMES.map((outcome) => (
                            <option key={outcome} value={outcome}>
                              {outcome.replaceAll("_", " ").toLowerCase()}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">Promised date</span>
                        <input type="date" name="promisedDate" className={inputClass} />
                      </label>
                      <label className="block min-w-[14rem]">
                        <span className="mb-1 block text-[11px] text-muted">Notes / evidence</span>
                        <input name="notes" className={inputClass} placeholder="Email reference or summary" />
                      </label>
                      <Button type="submit" variant="secondary" size="sm">
                        Record supplier reply
                      </Button>
                    </form>
                  ) : null}

                  {po.versions.length > 0 ? (
                    <details className="rounded-card border border-line/70 p-3 text-[12px]">
                      <summary className="cursor-pointer font-medium text-ink">
                        Version history ({po.versions.length}) — the issued and approved documents are immutable
                      </summary>
                      <ul className="mt-2 space-y-3">
                        {po.versions.map((version) => {
                          const diff = parseJson<
                            Array<{ lineId: string; description: string; changes: Record<string, { before: string | null; after: string | null }> }>
                          >(version.changeSummaryJson, []);
                          return (
                            <li key={version.id} className="rounded border border-line/70 px-2 py-1.5">
                              <p className="text-ink">
                                v{version.version} · {version.status.replaceAll("_", " ").toLowerCase()} · {formatDateTime(version.createdAt)}
                                {version.source === "SENT" ? " · issued to supplier" : version.source === "SUPPLIER_ACKNOWLEDGEMENT" ? " · approved supplier revision" : ""}
                              </p>
                              {version.reason ? <p className="text-muted">{version.reason}</p> : null}
                              {diff.length > 0 ? (
                                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-soft">
                                  {diff.map((entry) => (
                                    <li key={entry.lineId}>
                                      {entry.description}:{" "}
                                      {Object.entries(entry.changes)
                                        .map(([field, change]) => `${field} ${change.before ?? "—"} → ${change.after ?? "—"}`)
                                        .join("; ")}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ) : null}

                  {po.receipts.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Goods receipts</p>
                      <ul className="space-y-1 text-[12px] text-soft">
                        {po.receipts.map((receipt) => (
                          <li key={receipt.id}>
                            {receipt.receiptNumber} · {formatDate(receipt.receivedAt)}
                            {receipt.deliveryNoteRef ? ` · note ${receipt.deliveryNoteRef}` : ""} · accepted{" "}
                            {receipt.lines.reduce((total, line) => total + Number(line.quantityAccepted), 0).toFixed(4)} · rejected{" "}
                            {receipt.lines.reduce((total, line) => total + Number(line.quantityRejected), 0).toFixed(4)}
                            {receipt.lines.some((line) => line.discrepancyType) ? " · discrepancy" : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {canReceive ? (
                    <form action={recordReceiptAction} className="space-y-2 rounded-card border border-line p-3">
                      <input type="hidden" name="operationKey" value={randomUUID()} />
                      <p className="text-[12px] font-medium text-ink">Record goods receipt</p>
                      <input type="hidden" name="purchaseOrderId" value={po.id} />
                      <input type="hidden" name="salesOrderId" value={order.id} />
                      <div className="grid gap-2 sm:grid-cols-3">
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted">Delivery note reference</span>
                          <input name="deliveryNoteRef" className={inputClass} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted">Received date</span>
                          <input type="date" name="receivedAt" className={inputClass} />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted">Inspection</span>
                          <select name="inspectionResult" className={inputClass} defaultValue="">
                            <option value="">Not recorded</option>
                            <option value="PASSED">Passed</option>
                            <option value="PARTIAL">Partly passed</option>
                            <option value="FAILED">Failed</option>
                          </select>
                        </label>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-sm">
                          <thead>
                            <tr>
                              <th className="px-2 py-1 text-left text-[11px] uppercase text-muted">Line</th>
                              <th className="px-2 py-1 text-right text-[11px] uppercase text-muted">Remaining</th>
                              <th className="px-2 py-1 text-[11px] uppercase text-muted">Received</th>
                              <th className="px-2 py-1 text-[11px] uppercase text-muted">Accepted</th>
                              <th className="px-2 py-1 text-[11px] uppercase text-muted">Condition</th>
                            </tr>
                          </thead>
                          <tbody>
                            {remainingLines.map(({ line, remaining }) => (
                              <tr key={line.id}>
                                <td className="px-2 py-1 text-ink">{line.description}</td>
                                <td className="px-2 py-1 text-right tabular text-muted">{remaining.toFixed(4)}</td>
                                <td className="px-2 py-1">
                                  <input name={`received_${line.id}`} className={inputClass} placeholder="0" />
                                </td>
                                <td className="px-2 py-1">
                                  <input name={`accepted_${line.id}`} className={inputClass} placeholder="= received" />
                                </td>
                                <td className="px-2 py-1">
                                  <select name={`condition_${line.id}`} className={inputClass} defaultValue="OK">
                                    {RECEIPT_CONDITIONS.map((condition) => (
                                      <option key={condition} value={condition}>
                                        {condition.replaceAll("_", " ").toLowerCase()}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[11px] text-muted">
                        Damaged, wrong-product and wrong-specification quantities are never added to usable stock; they stay as an open discrepancy.
                      </p>
                      <Button type="submit" variant="primary" size="sm">
                        Post goods receipt
                      </Button>
                    </form>
                  ) : null}

                  {canBill ? (
                    <form action={recordSupplierBillAction} className="flex flex-wrap items-end gap-2 rounded-card border border-line p-3">
                      <input type="hidden" name="operationKey" value={randomUUID()} />
                      <input type="hidden" name="purchaseOrderId" value={po.id} />
                      <input type="hidden" name="supplierId" value={po.supplierId} />
                      <input type="hidden" name="salesOrderId" value={order.id} />
                      <input type="hidden" name="currency" value={po.currency} />
                      <p className="w-full text-[12px] font-medium text-ink">Record the supplier bill</p>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">Supplier invoice ref</span>
                        <input name="supplierInvoiceRef" className={inputClass} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">Amount (excl. tax)</span>
                        <input name="amount" className={inputClass} placeholder="0.00" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">Tax</span>
                        <input name="taxAmount" className={inputClass} placeholder="0.00" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted">Due date</span>
                        <input type="date" name="dueDate" className={inputClass} />
                      </label>
                      <Button type="submit" variant="secondary" size="sm">
                        Record bill
                      </Button>
                    </form>
                  ) : null}

                  {bills.filter((bill) => bill.supplierId === po.supplierId).length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Supplier bills</p>
                      {bills
                        .filter((bill) => bill.supplierId === po.supplierId)
                        .map((bill) => {
                          const balance = money(dec(bill.total).minus(dec(bill.paidAmount)));
                          return (
                            <div key={bill.id} className="flex flex-wrap items-end justify-between gap-2 rounded border border-line/70 px-3 py-2 text-[12px]">
                              <div>
                                <p className="text-ink">
                                  {bill.billNumber} {bill.supplierInvoiceRef ? `· ${bill.supplierInvoiceRef}` : ""} · {bill.currency} {toMoneyString(bill.total)}
                                </p>
                                <p className="text-muted">
                                  Paid {toMoneyString(bill.paidAmount)} · outstanding {toMoneyString(balance)} · {bill.status.toLowerCase()}
                                  {bill.dueDate ? ` · due ${formatDate(bill.dueDate)}` : ""}
                                </p>
                              </div>
                              {balance.gt(0) ? (
                                <form action={recordSupplierPaymentAction} className="flex items-end gap-2">
                                  <input type="hidden" name="operationKey" value={randomUUID()} />
                                  <input type="hidden" name="supplierBillId" value={bill.id} />
                                  <input type="hidden" name="salesOrderId" value={order.id} />
                                  <input name="amount" className={inputClass} placeholder="amount" />
                                  <input name="reference" className={inputClass} placeholder="bank ref" />
                                  <Button type="submit" variant="secondary" size="sm">
                                    Record payment
                                  </Button>
                                </form>
                              ) : (
                                <Badge tone="ok">Paid</Badge>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {plan && plan.lines.some((line) => line.remainingToOrder > 0.0001) ? (
          <div className="space-y-3 border-t border-line px-4 py-4">
            <p className="text-sm font-semibold text-ink">Raise a purchase order</p>
            <p className="text-[12px] text-muted">
              Only verified, unexpired supplier offers can become a purchase commitment. Split procurement across suppliers is allowed.
            </p>
            {plan.lines
              .filter((line) => line.remainingToOrder > 0.0001)
              .map((line) => (
                <form key={line.salesOrderLineId} action={createProcurementAction} className="rounded-card border border-line p-3">
                  <input type="hidden" name="operationKey" value={randomUUID()} />
                  <input type="hidden" name="salesOrderId" value={order.id} />
                  <input type="hidden" name="salesOrderLineId" value={line.salesOrderLineId} />
                  <p className="text-[12px] font-medium text-ink">
                    {line.description} · {line.remainingToOrder} {line.unit} to procure
                    <span className="ml-2 font-normal text-muted">({line.stockQuantity} from stock)</span>
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-4">
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-[11px] text-muted">Verified supplier offer</span>
                      <select name="supplierOfferId" className={inputClass} defaultValue={line.approvedOffer?.eligible ? line.approvedOffer.id : ""}>
                        <option value="">Choose an offer</option>
                        {line.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id} disabled={!candidate.eligible}>
                            {candidate.supplierName} · {candidate.currency ?? order.currency} {candidate.unitPrice?.toFixed(2) ?? "—"} ·{" "}
                            {candidate.eligible ? `${candidate.leadTimeDays ?? "?"} days` : candidate.blocker}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-muted">Quantity</span>
                      <input name="quantity" className={inputClass} defaultValue={line.remainingToOrder} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-muted">Unit price override</span>
                      <input name="unitPrice" className={inputClass} placeholder="Offer price" />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <input name="reason" className={inputClass} placeholder="Reason, if the price differs from the verified offer" />
                    <Button type="submit" variant="secondary" size="sm">
                      Create purchase order
                    </Button>
                  </div>
                </form>
              ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Dispatch and delivery"
          description="Each dispatch is separate. The order is delivered only when every line is confirmed delivered with proof."
        />
        {deliveries.length > 0 ? (
          <ul className="divide-y divide-line">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <p className="text-ink">
                      {delivery.deliveryNumber} · {delivery.status.toLowerCase()} · {formatDateTime(delivery.dispatchedAt)}
                    </p>
                    <p className="text-[12px] text-muted">
                      {delivery.lines.map((line) => `${line.salesOrderLine.description} ${Number(line.quantity).toFixed(4)} ${line.salesOrderLine.unit}`).join(" · ")}
                      {delivery.carrier ? ` · ${delivery.carrier}` : ""}
                      {delivery.receivedBy ? ` · received by ${delivery.receivedBy}` : ""}
                    </p>
                  </div>
                  <Badge tone={statusTone(delivery.status)}>{delivery.status.toLowerCase()}</Badge>
                </div>
                {delivery.status === "DISPATCHED" ? (
                  <form action={recordProofOfDeliveryAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="deliveryId" value={delivery.id} />
                    <input type="hidden" name="salesOrderId" value={order.id} />
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-muted">Delivered date</span>
                      <input type="date" name="deliveredAt" className={inputClass} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-muted">Received by</span>
                      <input name="receivedBy" className={inputClass} placeholder="Customer name" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-muted">Proof of delivery reference</span>
                      <input name="proofPath" className={inputClass} placeholder="Signed note / photo reference" />
                    </label>
                    <Button type="submit" variant="primary" size="sm">
                      Record delivery
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted">Nothing dispatched yet.</p>
        )}

        {availability.some((line) => line.available > 0.0001) && !closed ? (
          <form action={recordDeliveryAction} className="space-y-2 border-t border-line px-4 py-4">
            <input type="hidden" name="operationKey" value={randomUUID()} />
            <input type="hidden" name="salesOrderId" value={order.id} />
            <p className="text-[12px] font-medium text-ink">Record a dispatch</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Carrier</span>
                <input name="carrier" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Vehicle / tracking</span>
                <input name="vehicleRef" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Dispatch date</span>
                <input type="date" name="dispatchedAt" className={inputClass} />
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left text-[11px] uppercase text-muted">Line</th>
                    <th className="px-2 py-1 text-right text-[11px] uppercase text-muted">Available</th>
                    <th className="px-2 py-1 text-right text-[11px] uppercase text-muted">Deliver now</th>
                  </tr>
                </thead>
                <tbody>
                  {availability
                    .filter((line) => line.available > 0.0001)
                    .map((line) => (
                      <tr key={line.lineId}>
                        <td className="px-2 py-1 text-ink">{line.description}</td>
                        <td className="px-2 py-1 text-right tabular text-muted">{line.available.toFixed(4)}</td>
                        <td className="px-2 py-1">
                          <input name={`deliver_${line.lineId}`} className={inputClass} placeholder="0" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Button type="submit" variant="primary" size="sm">
              Record dispatch
            </Button>
          </form>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Customer invoices and receipts"
          description="Invoices are issued for delivered quantity only. A receipt is money actually recorded, never inferred."
        />
        {invoices.length > 0 ? (
          <DataTable minWidth={860}>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Issued</Th>
                <Th>Due</Th>
                <Th>Status</Th>
                <Th align="right">Total</Th>
                <Th align="right">Paid</Th>
                <Th align="right">Balance</Th>
                <Th>Payment allocations</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const balance = money(dec(invoice.total).minus(dec(invoice.amountPaid)));
                return (
                  <tr key={invoice.id}>
                    <Td>{invoice.invoiceNumber}</Td>
                    <Td>{formatDate(invoice.invoiceDate)}</Td>
                    <Td>{invoice.dueDate ? formatDate(invoice.dueDate) : "—"}</Td>
                    <Td>
                      <Badge tone={statusTone(invoice.status)}>{invoice.status.toLowerCase()}</Badge>
                    </Td>
                    <Td align="right">{invoice.currency} {toMoneyString(invoice.total)}</Td>
                    <Td align="right">{toMoneyString(invoice.amountPaid)}</Td>
                    <Td align="right">{toMoneyString(balance)}</Td>
                    <Td>
                      {invoice.allocations.length === 0
                        ? "—"
                        : invoice.allocations.map((allocation) => `${allocation.payment.paymentNumber} ${toMoneyString(allocation.amount)}`).join(", ")}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        ) : (
          <p className="px-4 py-3 text-sm text-muted">No customer invoice has been issued.</p>
        )}

        {metrics.lines.some((line) => line.remainingToInvoice.gt(0)) && !closed ? (
          <form action={issueInvoiceAction} className="space-y-2 border-t border-line px-4 py-4">
            <input type="hidden" name="operationKey" value={randomUUID()} />
            <input type="hidden" name="salesOrderId" value={order.id} />
            <p className="text-[12px] font-medium text-ink">Issue an invoice from delivered quantity</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Invoice date</span>
                <input type="date" name="invoiceDate" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Due date</span>
                <input type="date" name="dueDate" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Notes</span>
                <input name="notes" className={inputClass} />
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left text-[11px] uppercase text-muted">Line</th>
                    <th className="px-2 py-1 text-right text-[11px] uppercase text-muted">Delivered, uninvoiced</th>
                    <th className="px-2 py-1 text-right text-[11px] uppercase text-muted">Invoice now</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-2 py-1 text-ink">{line.description}</td>
                      <td className="px-2 py-1 text-right tabular text-muted">{line.remainingToInvoice.toFixed(4)}</td>
                      <td className="px-2 py-1">
                        <input
                          name={`invoice_${line.id}`}
                          className={inputClass}
                          placeholder={line.remainingToInvoice.gt(0) ? line.remainingToInvoice.toFixed(4) : "—"}
                          disabled={line.remainingToInvoice.lte(0)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted">Leave every quantity blank to invoice all delivered, uninvoiced quantity.</p>
            <Button type="submit" variant="primary" size="sm">
              Issue invoice
            </Button>
          </form>
        ) : null}

        {invoices.some((invoice) => money(dec(invoice.total).minus(dec(invoice.amountPaid))).gt(0)) ? (
          <form action={recordPaymentAction} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-4">
            <input type="hidden" name="operationKey" value={randomUUID()} />
            <input type="hidden" name="salesOrderId" value={order.id} />
            <p className="w-full text-[12px] font-medium text-ink">Record a customer receipt</p>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Invoice</span>
              <select name="invoiceId" className={inputClass}>
                {invoices
                  .filter((invoice) => money(dec(invoice.total).minus(dec(invoice.amountPaid))).gt(0))
                  .map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoiceNumber} · {invoice.currency} {toMoneyString(money(dec(invoice.total).minus(dec(invoice.amountPaid))))} open
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Amount received</span>
              <input name="amount" className={inputClass} placeholder="0.00" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Bank reference</span>
              <input name="reference" className={inputClass} placeholder="Transaction reference" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Received date</span>
              <input type="date" name="receivedAt" className={inputClass} />
            </label>
            <Button type="submit" variant="primary" size="sm">
              Record receipt
            </Button>
          </form>
        ) : null}

        {payments.length > 0 ? (
          <ul className="divide-y divide-line border-t border-line">
            {payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[12px]">
                <div>
                  <p className="text-ink">
                    {payment.paymentNumber} · {payment.currency} {toMoneyString(payment.amount)} · {payment.method.toLowerCase()} · {formatDate(payment.receivedAt)}
                    {payment.reference ? ` · ${payment.reference}` : ""}
                  </p>
                  <p className="text-muted">
                    {payment.status.toLowerCase()}
                    {payment.allocations.length > 0 ? ` · ${payment.allocations.map((allocation) => allocation.invoice.invoiceNumber).join(", ")}` : " · unallocated"}
                  </p>
                </div>
                {payment.status === "CONFIRMED" ? (
                  <form action={reversePaymentAction} className="flex items-end gap-2">
                    <input type="hidden" name="paymentId" value={payment.id} />
                    <input type="hidden" name="salesOrderId" value={order.id} />
                    <input name="reason" className={inputClass} placeholder="Reason for reversal" />
                    <Button type="submit" variant="danger" size="sm">
                      Reverse
                    </Button>
                  </form>
                ) : (
                  <Badge tone="danger">Reversed</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Discrepancies and quality issues" description="Open issues block verified closure until resolved or explicitly waived." />
        {order.discrepancies.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No discrepancy has been recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {order.discrepancies.map((discrepancy) => (
              <li key={discrepancy.id} className="space-y-2 px-4 py-3 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={discrepancy.status === "OPEN" ? "warn" : "ok"}>{discrepancy.status.toLowerCase()}</Badge>
                  <span className="font-medium text-ink">{discrepancy.code.replaceAll("_", " ")}</span>
                  <span className="text-muted">{discrepancy.entityType}</span>
                </div>
                <p className="text-soft">{discrepancy.note ?? parseJson<{ detail?: string }>(discrepancy.detailJson, {}).detail ?? ""}</p>
                {discrepancy.status === "OPEN" ? (
                  <form action={resolveDiscrepancyAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="discrepancyId" value={discrepancy.id} />
                    <input type="hidden" name="salesOrderId" value={order.id} />
                    <select name="decision" className={inputClass} defaultValue="RESOLVED">
                      <option value="RESOLVED">Resolved</option>
                      <option value="WAIVED">Waived with reason</option>
                    </select>
                    <input name="resolutionNote" className={inputClass} placeholder="How it was resolved" />
                    <Button type="submit" variant="secondary" size="sm">
                      Record resolution
                    </Button>
                  </form>
                ) : (
                  <p className="text-muted">{discrepancy.resolutionNote}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {openDiscrepancies.length === 0 && order.discrepancies.length > 0 ? (
          <p className="border-t border-line px-4 py-2 text-[12px] text-muted">All recorded discrepancies are resolved.</p>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Verified deal closure"
          description="Closure uses the configured policy, not a status change. Owner overrides keep their reason and the before/after state."
        />
        {closure ? (
          <div className="space-y-3 px-4 py-4 text-[13px]">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted">Undelivered</p>
                <p className="mt-0.5 text-ink">{closure.obligations.undeliveredQty} units</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted">Open supplier commitments</p>
                <p className="mt-0.5 text-ink">
                  {closure.obligations.openSupplierQty} units · {order.currency} {closure.obligations.openSupplierValue}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted">Unbilled delivered value</p>
                <p className="mt-0.5 text-ink">{order.currency} {closure.obligations.unbilledValue}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted">Open discrepancies</p>
                <p className="mt-0.5 text-ink">{closure.obligations.openDiscrepancies}</p>
              </div>
            </div>
            <p className="text-[12px] text-muted">
              Policy: delivery {closure.policy.requireFullDelivery ? "required" : "not required"} · invoicing{" "}
              {closure.policy.requireFullInvoicing ? "required" : "not required"} · customer payment{" "}
              {closure.policy.requireCustomerPaid ? "required" : "not required"} · supplier settlement{" "}
              {closure.policy.requireSupplierSettled ? "required" : "tracked only"} · open discrepancies{" "}
              {closure.policy.allowOpenDiscrepancies ? "allowed" : "blocking"}.
            </p>
            {closed ? (
              <Notice tone="ok" title={`Closed ${formatDate(order.closedAt)}`}>
                {order.closureOverrideReason
                  ? `Closed with an owner override: ${order.closureOverrideReason}`
                  : "Every configured closure condition was satisfied by the records."}
              </Notice>
            ) : (
              <>
                {!closure.readyToClose ? (
                  <Notice tone="warn" title="Outstanding obligations">
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {closure.blockingReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : (
                  <Notice tone="ok" title="Ready to close">
                    Delivered, invoiced and paid according to the configured policy.
                  </Notice>
                )}
                <form action={closeSalesOrderAction} className="grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="salesOrderId" value={order.id} />
                  <label className="block sm:col-span-1">
                    <span className="mb-1 block text-[11px] text-muted">Closure note</span>
                    <input name="note" className={inputClass} placeholder="Optional note" />
                  </label>
                  <label className="block sm:col-span-1">
                    <span className="mb-1 block text-[11px] text-muted">Owner override reason</span>
                    <input name="overrideReason" className={inputClass} placeholder="Only if obligations remain" />
                  </label>
                  <div className="flex items-end">
                    <Button type="submit" variant={closure.readyToClose ? "primary" : "danger"} size="sm">
                      {closure.readyToClose ? "Close deal" : "Close with owner override"}
                    </Button>
                  </div>
                </form>
              </>
            )}
            <details>
              <summary className="cursor-pointer text-[12px] text-soft">Configuration note</summary>
              <p className="mt-1 text-[12px] text-muted">
                Closure policy is stored per workspace in Settings → app setting <code>orders.closurePolicy</code> (JSON:
                requireFullDelivery, requireFullInvoicing, requireCustomerPaid, requireSupplierSettled, allowOpenDiscrepancies).
              </p>
            </details>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Lifecycle history" description="Every state change with its actor, reason and timestamp." />
        {events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No lifecycle event recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2 text-[12px]">
                <div>
                  <span className="text-ink">
                    {event.entityType} · {event.fromStatus ? `${event.fromStatus} → ` : ""}
                    {event.toStatus}
                  </span>
                  <span className="ml-2 text-muted">{event.reason ?? ""}</span>
                </div>
                <span className="text-muted">
                  {event.actorLabel} · {formatDateTime(event.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
