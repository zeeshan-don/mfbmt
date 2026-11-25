import Link from "next/link";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { formatDateTime, formatMoney, truncate } from "@/lib/format";
import { parseJson } from "@/lib/json";
import { supplierDailyUsage } from "@/lib/suppliers/sendGuard";
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui";
import { approveSupplierDraftsAction } from "@/app/actions/supplierOutreach";

export const dynamic = "force-dynamic";

export default async function SupplierOutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;
  const [drafts, usage] = await Promise.all([
    db.supplierQuote.findMany({
      where: { status: "DRAFT" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        supplier: { select: { id: true, name: true, email: true, whatsapp: true, city: true, country: true, doNotContact: true, status: true, identityStatus: true } },
        items: true,
        enquiryItem: { include: { enquiry: { select: { publicRef: true, customerName: true } } } },
      },
    }),
    supplierDailyUsage(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Supplier outreach"
        title="Draft RFQ queue"
        description="Supplier requests discovered during sourcing wait here. Nothing is transmitted until you approve the selected drafts."
        actions={<Link href="/suppliers" className="text-xs text-accent hover:underline">Back to suppliers</Link>}
      />

      {flags.error ? <Notice tone="danger" title="Some drafts were not sent">{flags.error}</Notice> : null}
      {flags.sent ? <Notice tone="ok">{flags.sent} RFQ(s) sent. Replies will be matched to their reference automatically.</Notice> : null}

      <Notice tone="info" title="Approval is recorded for every message">
        One click records a durable owner approval for each selected RFQ, then uses the same guarded sender as a single request.
        Do-not-contact, bounced and excluded suppliers are refused, and the daily cap is enforced.
      </Notice>

      <Card>
        <CardHeader
          title="Waiting to send"
          description={`${drafts.length} draft(s) · ${usage.sentToday} of ${usage.dailyLimit} supplier messages sent today.`}
        />
        {drafts.length === 0 ? (
          <EmptyState
            title="No drafted RFQs"
            description="Sourcing creates a draft when it finds a public supplier with a contact address but no usable public price."
          />
        ) : (
          <form action={approveSupplierDraftsAction} className="divide-y divide-line">
            {drafts.map((draft) => {
              const blocked = draft.supplier.doNotContact || draft.supplier.status === "BLOCKED";
              const quality = parseJson<{ findings?: Array<{ severity: string; message: string }> }>(
                draft.draftQualityJson ?? "{}",
                {},
              );
              const qualityErrors = (quality.findings ?? []).filter((finding) => finding.severity === "error");
              const disabled = blocked || qualityErrors.length > 0;
              return (
                <label key={draft.id} className="flex cursor-pointer gap-3 px-4 py-3 hover:bg-elevated/50">
                  <input
                    type="checkbox"
                    name="quoteIds"
                    value={draft.id}
                    disabled={disabled}
                    defaultChecked={!disabled}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{draft.supplier.name}</span>
                      <Badge tone={blocked ? "danger" : draft.supplier.identityStatus === "VERIFIED" ? "ok" : "warn"}>
                        {blocked ? "blocked" : draft.supplier.identityStatus.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                      <span className="text-[11px] text-muted">
                        {draft.enquiryItem?.enquiry.publicRef ?? "RFQ"} · {draft.enquiryItem?.enquiry.customerName ?? "Customer"}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-soft">{truncate(draft.subject ?? "Quotation request", 110)}</span>
                    <span className="mt-1 block text-[11px] text-muted">
                      {[draft.supplier.city, draft.supplier.country].filter(Boolean).join(", ") || "Location not recorded"} ·{" "}
                      {draft.supplier.email ?? draft.supplier.whatsapp ?? "no contact"} · drafted {formatDateTime(draft.createdAt)}
                    </span>
                    {draft.items[0] ? (
                      <span className="mt-1 block text-[11px] text-soft">
                        {truncate(draft.items[0].description, 120)} · {draft.items[0].quantity} {draft.items[0].unit}
                        {draft.items[0].unitPrice != null ? ` · ${formatMoney(draft.items[0].unitPrice, draft.items[0].currency ?? "AED")}` : ""}
                      </span>
                    ) : null}
                    {qualityErrors.length > 0 ? (
                      <span className="mt-1 block text-[11px] text-danger">
                        Quality check: {qualityErrors.map((finding) => finding.message).join(" ")}
                      </span>
                    ) : null}
                    {draft.lastError ? <span className="mt-1 block text-[11px] text-danger">{draft.lastError}</span> : null}
                    <Link
                      href={`/suppliers/outreach/${draft.id}`}
                      className="mt-1 inline-block text-[11px] text-accent hover:underline"
                    >
                      Inspect and edit this message
                    </Link>
                    {blocked ? (
                      <span className="mt-1 block text-[11px] text-warn">
                        This supplier is excluded from contact. Clear the block on the supplier record only if that is intended.
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <p className="text-[11px] text-muted">
                Approval applies only to the selected drafts. It does not approve a supplier price or place a purchase order.
              </p>
              <Button variant="primary">Approve &amp; send selected</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
