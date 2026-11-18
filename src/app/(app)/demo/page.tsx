import Link from "next/link";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { isDemoMode } from "@/lib/env";
import { parseJson } from "@/lib/json";
import { FASTENER_DEMO_REFS } from "@/scripts/demo-fasteners";
import { formatMoney, timeAgo, truncate } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, statusTone } from "@/components/ui";
import { resetDemoWalkthroughAction, simulateDemoSendAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

const STEPS = [
  { title: "1. Enquiry and exact fastener specification", detail: "Structured type, diameter, thread/pitch, length, grade, finish and standard — confirmed versus missing is explicit." },
  { title: "2. Stock position", detail: "On-hand, reserved and available are separate. Only the genuine shortage is sourced." },
  { title: "3. Supplier offers", detail: "Offers are compared only after a deterministic specification check. A wrong grade or finish is excluded with a reason." },
  { title: "4. Landed cost", detail: "MOQ overbuy, freight and other charges are included. Missing freight leaves the total incomplete and unranked." },
  { title: "5. Owner decision", detail: "Approving a supplier option is separate from approving a purchase (which this app does not do) and from approving a quotation." },
  { title: "6. Customer quotation and PDF", detail: "Customer-facing only. Internal supplier cost, margin and competing offers never appear." },
];

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; simulated?: string; error?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;

  if (!isDemoMode) {
    return (
      <div className="space-y-5">
        <PageHeader title="Demo walkthrough" description="This page is only available when DEMO_MODE=true." />
        <Notice tone="warn" title="Demo mode is off">
          Sample data and simulated sends are disabled. Use <code className="rounded bg-elevated px-1">provision:owner</code> and real data instead.
        </Notice>
      </div>
    );
  }

  const enquiries = await db.enquiry.findMany({
    where: { publicRef: { in: Object.values(FASTENER_DEMO_REFS) } },
    include: {
      items: { orderBy: { lineNo: "asc" }, include: { offers: true } },
      quotations: { orderBy: { version: "desc" } },
    },
  });
  const rfq = enquiries.find((enquiry) => enquiry.publicRef === FASTENER_DEMO_REFS.rfq) ?? null;
  const quoted = enquiries.find((enquiry) => enquiry.publicRef === FASTENER_DEMO_REFS.quoted) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sample data — not live market prices"
        title="Fastener owner walkthrough"
        description="A guided, replayable demonstration of a fastener RFQ from arrival to a released customer quotation."
        actions={
          <>
            <form action={resetDemoWalkthroughAction}>
              <Button size="sm">Restore walkthrough</Button>
            </form>
            <form action={simulateDemoSendAction}>
              <Button size="sm" variant="primary">Simulate sending the quote</Button>
            </form>
          </>
        }
      />

      {flags.reset ? <Notice tone="ok">Walkthrough restored. Only the two labelled sample records were rebuilt.</Notice> : null}
      {flags.simulated ? (
        <Notice tone="ok" title="Simulation recorded">
          The quotation is marked as sent in demo mode. No email or WhatsApp message was transmitted and no order or payment exists.
        </Notice>
      ) : null}
      {flags.error ? <Notice tone="danger">{flags.error}</Notice> : null}

      <Notice tone="warn" title="Demo-only sign-in">
        The seeded accounts (<strong>owner@mfbmt.local</strong> / <strong>staff@mfbmt.local</strong>) use a shared demo password shown on the sign-in page.
        They must be replaced before any real use. Supplier names, contacts and prices below are fictional sample data; email addresses use the
        non-deliverable <code className="rounded bg-elevated px-1">.test</code> domain.
      </Notice>

      <Card>
        <CardHeader title="What the owner will see" description="Follow these six steps in order; the shortcut buttons below open the matching screens." />
        <ol className="grid gap-0 divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
          {STEPS.map((step) => (
            <li key={step.title} className="px-4 py-3">
              <p className="text-xs font-medium text-ink">{step.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{step.detail}</p>
            </li>
          ))}
        </ol>
      </Card>

      {!rfq ? (
        <Card>
          <EmptyState
            title="The walkthrough data is not loaded"
            description="Run npm run db:seed with DEMO_MODE=true and SEED_DEMO_DATA=true, then reload this page."
            action={<ButtonLink href="/demo">Reload</ButtonLink>}
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={`Live RFQ · ${rfq.publicRef}`}
            description={`${rfq.customerName ?? "Sample customer"} · ${rfq.items.length} lines · ${timeAgo(rfq.createdAt)}`}
            action={
              <ButtonLink href={`/enquiries/${rfq.id}`} size="sm">
                Open enquiry
              </ButtonLink>
            }
          />
          <div className="divide-y divide-line">
            {rfq.items.map((item) => {
              const missing = parseJson<string[]>(item.missingFields, []);
              return (
                <div key={item.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-[240px]">
                      <p className="text-sm font-medium text-ink">{item.description}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        Requested {item.quantity} {item.unit} · from stock {item.quantityFromStock} · to source {item.quantityToSource}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={statusTone(item.inventoryStatus)}>{item.inventoryStatus.toLowerCase()}</Badge>
                      <Badge tone={statusTone(item.sourcingStatus)}>{item.sourcingStatus.replaceAll("_", " ").toLowerCase()}</Badge>
                      {missing.length > 0 ? <Badge tone="warn">{missing.length} detail(s) needed</Badge> : null}
                    </div>
                  </div>
                  {missing.length > 0 ? (
                    <p className="mt-2 text-[11px] text-warn">
                      Needs clarification: {missing.join(", ")}. Nothing is assumed and stock is not promised.
                    </p>
                  ) : null}
                  {item.offers.length > 0 ? (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left text-[11px]">
                        <thead className="text-muted">
                          <tr>
                            <th className="py-1 pr-3 font-medium">Supplier</th>
                            <th className="py-1 pr-3 font-medium">Spec check</th>
                            <th className="py-1 pr-3 text-right font-medium">Unit</th>
                            <th className="py-1 pr-3 text-right font-medium">MOQ</th>
                            <th className="py-1 pr-3 text-right font-medium">Landed total</th>
                            <th className="py-1 font-medium">Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.offers
                            .slice()
                            .sort((a, b) => {
                              const rank = (offer: typeof a) =>
                                parseJson<{ evaluation?: { rank?: number | null } }>(offer.landedCostJson, {}).evaluation?.rank ?? 999;
                              return rank(a) - rank(b);
                            })
                            .map((offer) => {
                              const snapshot = parseJson<{
                                landed?: { total?: number | null; complete?: boolean; missing?: string[]; excessQuantity?: number };
                                evaluation?: { rank?: number | null };
                              }>(offer.landedCostJson, {});
                              return (
                                <tr key={offer.id} className="border-t border-line align-top">
                                  <td className="py-1.5 pr-3">{offer.supplierName}</td>
                                  <td className="py-1.5 pr-3">
                                    <Badge tone={offer.matchStatus === "EXACT" ? "ok" : "danger"}>{offer.matchStatus.replaceAll("_", " ").toLowerCase()}</Badge>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right tabular">{offer.unitPrice != null ? formatMoney(offer.unitPrice, offer.currency ?? "AED") : "—"}</td>
                                  <td className="py-1.5 pr-3 text-right tabular">{offer.moq ?? "—"}</td>
                                  <td className="py-1.5 pr-3 text-right tabular">
                                    {snapshot.landed?.total != null ? formatMoney(snapshot.landed.total, "AED") : "Incomplete"}
                                  </td>
                                  <td className="py-1.5 text-muted">
                                    {offer.ineligibilityReason ??
                                      (snapshot.landed?.complete === false
                                        ? `Not ranked: ${(snapshot.landed.missing ?? []).join(", ")} not known.`
                                        : snapshot.evaluation?.rank
                                          ? `Rank ${snapshot.evaluation.rank} by complete landed cost.`
                                          : "Eligible; no comparable total.")}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {quoted ? (
        <Card>
          <CardHeader
            title={`Approved quotation sample · ${quoted.publicRef}`}
            description="Customer-facing document only. Open the quotation to view or download the PDF."
            action={
              quoted.quotations[0] ? (
                <ButtonLink href={`/quotations/${quoted.quotations[0].id}`} size="sm">
                  Open quotation
                </ButtonLink>
              ) : null
            }
          />
          <div className="space-y-2 px-4 py-3 text-xs text-soft">
            <p>
              Status: <Badge tone={statusTone(quoted.quotations[0]?.status ?? "APPROVED")}>{quoted.quotations[0]?.status.toLowerCase() ?? "approved"}</Badge>
            </p>
            <p>
              The sample line is priced at {formatMoney(quoted.quotations[0]?.total ?? null, "AED")} including tax. Supplier cost and margin are stored internally and are
              not printed on the customer PDF.
            </p>
            {quoted.quotations[0]?.pdfPath ? (
              <p className="text-muted">Sample PDF: generated and stored privately. Download it from the quotation page.</p>
            ) : (
              <p className="text-warn">The sample PDF was not generated. Open the quotation page and use “Generate PDF”.</p>
            )}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Where to click next" description="Shortcuts for a live presentation." />
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {rfq ? <ButtonLink href={`/enquiries/${rfq.id}`} size="sm">Enquiry with 3 lines</ButtonLink> : null}
          <ButtonLink href="/sourcing" size="sm">Sourcing comparison</ButtonLink>
          <ButtonLink href="/approvals" size="sm">Owner approvals</ButtonLink>
          <ButtonLink href="/activity" size="sm">Activity and audit trail</ButtonLink>
          {quoted?.quotations[0] ? <ButtonLink href={`/quotations/${quoted.quotations[0].id}`} size="sm">Customer quotation</ButtonLink> : null}
        </div>
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-muted">
          There is no purchase order, payment or supplier commitment capability in this build. Approving a supplier only allows it to be used in a quotation.
        </p>
      </Card>
    </div>
  );
}
