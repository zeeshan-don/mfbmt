import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDate } from "@/lib/format";
import { createSalesOrderAction } from "@/app/actions/orders";
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, inputClass, statusTone } from "@/components/ui";
import { ownerOperationsBoard, salesOrderList } from "@/lib/orders/dashboard";
import { quotationsAwaitingAcceptance } from "@/lib/orders/salesOrder";
import { SALES_ORDER_STATUS_LABELS } from "@/lib/orders/state";
import { toMoneyString } from "@/lib/orders/money";

export const dynamic = "force-dynamic";

type DiscrepancyView = {
  code: string;
  severity: string;
  description: string;
  quoted: string | number | null;
  requested: string | number | null;
  message: string;
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; discrepancies?: string; blocking?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;
  const [orders, board, quotations] = await Promise.all([
    salesOrderList(),
    ownerOperationsBoard(),
    quotationsAwaitingAcceptance(),
  ]);

  const discrepancies = flags.discrepancies ? parseJson<DiscrepancyView[]>(flags.discrepancies, []) : [];
  const blocking = flags.blocking ? parseJson<string[]>(flags.blocking, []) : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales orders and deal closure"
        eyebrow="Customer acceptance → procurement → delivery → cash"
        description="Every order here is bound to one exact quotation version. Purchases, receipts, dispatches, invoices and receipts are separate records, and nothing closes until its obligations are accounted for."
      />

      {flags.error ? (
        <Notice tone="danger" title="Action not completed">
          {flags.error}
        </Notice>
      ) : null}
      {flags.saved ? <Notice tone="ok">{flags.saved}</Notice> : null}

      {blocking.length > 0 ? (
        <Notice tone="warn" title="Mandatory obligations still open">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {blocking.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {discrepancies.length > 0 ? (
        <Card>
          <CardHeader
            title="The customer's document differs from the quotation"
            description="Compare each difference, then decide explicitly. Nothing was changed automatically."
          />
          <ul className="divide-y divide-line">
            {discrepancies.map((discrepancy, index) => (
              <li key={`${discrepancy.code}-${index}`} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={discrepancy.severity === "BLOCKING" ? "danger" : "warn"}>{discrepancy.code.replaceAll("_", " ")}</Badge>
                  <span className="font-medium text-ink">{discrepancy.description}</span>
                </div>
                <p className="mt-1 text-[13px] text-soft">{discrepancy.message}</p>
                <p className="mt-1 text-[12px] text-muted tabular">
                  Quoted: {discrepancy.quoted ?? "—"} · Requested: {discrepancy.requested ?? "—"}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Open sales orders</p>
          <p className="mt-1 text-2xl font-semibold tabular text-ink">{board.overview.openSalesOrders}</p>
          <p className="mt-1 text-[12px] text-muted">
            {board.overview.ordersInProcurement} in procurement · {board.overview.ordersInFulfilment} in fulfilment
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Supplier purchase orders open</p>
          <p className="mt-1 text-2xl font-semibold tabular text-ink">{board.overview.openSupplierPos}</p>
          <p className="mt-1 text-[12px] text-muted">{board.attention.find((entry) => entry.code === "PO_APPROVAL")?.count ?? 0} awaiting your approval</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Customer receivables</p>
          {board.money.receivables.length === 0 ? (
            <p className="mt-1 text-sm text-muted">Nothing outstanding.</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {board.money.receivables.map((total) => (
                <p key={total.currency} className="text-lg font-semibold tabular text-ink">
                  {total.currency} {total.amount}
                </p>
              ))}
            </div>
          )}
          <p className="mt-1 text-[12px] text-muted">
            {board.money.payables.length === 0
              ? "No supplier balances recorded."
              : `Supplier payables: ${board.money.payables.map((total) => `${total.currency} ${total.amount}`).join(" · ")}`}
          </p>
        </Card>
      </div>

      {board.attention.length > 0 ? (
        <Card>
          <CardHeader title="Attention required" description="Live counts from the records, not estimates." />
          <ul className="divide-y divide-line">
            {board.attention.map((entry) => (
              <li key={entry.code}>
                <Link href={entry.href} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-elevated/60">
                  <span className="text-soft">
                    <span className="mr-2 inline-flex min-w-6 justify-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent tabular">
                      {entry.count}
                    </span>
                    {entry.title}
                  </span>
                  <span className="text-[11px] text-muted">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Record a customer acceptance"
          description="Select the exact quotation version the customer accepted. If their PO changed a price, quantity, specification, tax or currency, the difference must be decided before an order exists."
        />
        {quotations.length === 0 ? (
          <EmptyState
            title="No approved quotation is waiting for acceptance"
            description="Approve and send a customer quotation first; it will appear here as the source of the sales order."
          />
        ) : (
          <div className="divide-y divide-line">
            {quotations.slice(0, 8).map((quotation) => (
              <details key={quotation.id} className="group">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-elevated/50">
                  <span className="text-ink">
                    <span className="font-medium">{quotation.quoteNumber}</span> v{quotation.version}
                    <span className="text-muted"> · {quotation.customerName} · {quotation.currency} {toMoneyString(quotation.total)}</span>
                  </span>
                  <Badge tone={statusTone(quotation.status)}>{quotation.status.toLowerCase()}</Badge>
                </summary>
                <form action={createSalesOrderAction} className="space-y-4 border-t border-line bg-bg/40 px-4 py-4">
                  <input type="hidden" name="quotationId" value={quotation.id} />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Customer PO number</span>
                      <input name="customerPoNumber" className={inputClass} placeholder="e.g. PO-4471" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">PO reference / evidence</span>
                      <input name="customerPoReference" className={inputClass} placeholder="Email id, attachment name" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Currency on the PO</span>
                      <input name="currency" className={inputClass} defaultValue={quotation.currency} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Requested delivery date</span>
                      <input type="date" name="deliveryDate" className={inputClass} />
                    </label>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] border-collapse text-sm">
                      <thead>
                        <tr>
                          <th className="border-b border-line px-2 py-2 text-left text-[11px] uppercase text-muted">Quoted line</th>
                          <th className="border-b border-line px-2 py-2 text-right text-[11px] uppercase text-muted">Quoted qty</th>
                          <th className="border-b border-line px-2 py-2 text-right text-[11px] uppercase text-muted">PO qty</th>
                          <th className="border-b border-line px-2 py-2 text-right text-[11px] uppercase text-muted">PO unit price</th>
                          <th className="border-b border-line px-2 py-2 text-left text-[11px] uppercase text-muted">PO specification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quotation.items.map((item) => (
                          <tr key={item.id}>
                            <td className="border-b border-line/60 px-2 py-2 text-ink">{item.description}</td>
                            <td className="border-b border-line/60 px-2 py-2 text-right tabular text-soft">{item.quantity}</td>
                            <td className="border-b border-line/60 px-2 py-2">
                              <input name={`item_${item.id}_qty`} className={inputClass} placeholder={String(item.quantity)} />
                            </td>
                            <td className="border-b border-line/60 px-2 py-2">
                              <input name={`item_${item.id}_price`} className={inputClass} placeholder="Quoted price" />
                            </td>
                            <td className="border-b border-line/60 px-2 py-2">
                              <input name={`item_${item.id}_spec`} className={inputClass} placeholder="Only if changed" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[12px] text-muted">
                    Leave the PO columns blank when the customer accepted the quotation unchanged. Adding a value compares it with the quoted line.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Decision on differences</span>
                      <select name="decision" className={inputClass} defaultValue="">
                        <option value="">Terms match the quotation</option>
                        <option value="ACCEPT_ORIGINAL">Do not accept changes — use the original quotation</option>
                        <option value="APPROVE_REVISED">Approve the customer&apos;s revised terms</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Reason (required for a revision)</span>
                      <input name="reason" className={inputClass} placeholder="Why the revised terms are acceptable" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Payment terms on the PO</span>
                      <input name="paymentTerms" className={inputClass} placeholder="Optional" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-soft">Delivery address</span>
                      <input name="deliveryAddress" className={inputClass} placeholder="Optional" />
                    </label>
                  </div>
                  <Button type="submit" variant="primary" size="sm">
                    Create sales order
                  </Button>
                </form>
              </details>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Sales orders" description="Open obligations, supplier purchase orders and invoice exposure per order." />
        {orders.length === 0 ? (
          <EmptyState
            title="No sales orders yet"
            description="Record a customer acceptance above. The resulting order binds every later purchase, receipt, delivery and invoice."
          />
        ) : (
          <DataTable minWidth={900}>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th align="right">Value</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Supplier POs</Th>
                <Th align="right">Delivered</Th>
                <Th align="right">Open balance</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-elevated/50">
                  <Td>
                    <Link href={`/orders/${order.id}`} className="font-medium text-accent hover:underline">
                      {order.orderNumber}
                    </Link>
                    <span className="mt-0.5 block text-[11px] text-muted">Quotation v{order.quotationVersion}</span>
                  </Td>
                  <Td>{order.customerName}</Td>
                  <Td>
                    <Badge tone={statusTone(order.status)} dot>
                      {SALES_ORDER_STATUS_LABELS[order.status] ?? order.status}
                    </Badge>
                  </Td>
                  <Td align="right">{order.currency} {toMoneyString(order.total)}</Td>
                  <Td align="right">{order.totalQty}</Td>
                  <Td align="right">{order.openSupplierPos}</Td>
                  <Td align="right">
                    {order.deliveredCount}/{order.deliveries.length}
                  </Td>
                  <Td align="right">
                    {order.currency} {toMoneyString(order.overdueBalance)}
                  </Td>
                  <Td>{formatDate(order.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </div>
  );
}

