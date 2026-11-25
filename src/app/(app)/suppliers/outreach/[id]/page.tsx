import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, inputClass, textareaClass } from "@/components/ui";
import { updateSupplierDraftAction } from "@/app/actions/supplierOutreach";

export const dynamic = "force-dynamic";

export default async function SupplierDraftReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const flags = await searchParams;

  const quote = await db.supplierQuote.findFirst({
    where: { id, status: "DRAFT" },
    include: {
      supplier: true,
      items: true,
      enquiryItem: { include: { enquiry: true } },
    },
  });
  if (!quote) notFound();

  const quality = parseJson<{ findings?: Array<{ severity: string; message: string }> }>(
    quote.draftQualityJson ?? "{}",
    {},
  );
  const errors = (quality.findings ?? []).filter((finding) => finding.severity === "error");
  const warnings = (quality.findings ?? []).filter((finding) => finding.severity === "warning");
  const enquiry = quote.enquiryItem?.enquiry;
  const instructions = parseJson<string[]>(enquiry?.customerInstructionsJson ?? "[]", []);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${enquiry?.publicRef ?? "RFQ"} · ${quote.supplier.name}`}
        title="Review the supplier message"
        description="This draft is not sent until you approve it. Edit the wording here if needed; the validation is re-run on save."
        actions={
          <Link href="/suppliers/outreach" className="text-xs text-accent hover:underline">
            Back to the draft queue
          </Link>
        }
      />

      {flags.saved ? <Notice tone="ok" title="Draft saved">Your edit was stored. Review any remaining notes before approving.</Notice> : null}
      {flags.error ? <Notice tone="danger" title="Draft not saved">{flags.error}</Notice> : null}

      {errors.length > 0 ? (
        <Notice tone="danger" title="This draft cannot be sent yet">
          <ul className="list-disc space-y-1 pl-4">
            {errors.map((finding) => (
              <li key={finding.message}>{finding.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {warnings.length > 0 ? (
        <Notice tone="warn" title="Worth checking">
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((finding) => (
              <li key={finding.message}>{finding.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {enquiry ? (
        <Card>
          <CardHeader
            title="Customer context"
            description="Kept separate from the products. A requested delivery window is the customer's requirement, not the supplier's lead time."
          />
          <div className="grid gap-3 px-4 py-3 sm:grid-cols-3">
            <div>
              <p className="text-[11px] text-muted">Urgency</p>
              <p className="text-sm text-ink">{enquiry.urgency ?? "Not stated"}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Requested delivery</p>
              <p className="text-sm text-ink">{enquiry.requestedDeliveryTimeframe ?? "Not stated"}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Delivery location</p>
              <p className="text-sm text-ink">{enquiry.deliveryLocation ?? "Not stated"}</p>
            </div>
            {instructions.length > 0 ? (
              <div className="sm:col-span-3">
                <p className="text-[11px] text-muted">Customer instructions</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-soft">
                  {instructions.map((instruction) => (
                    <li key={instruction}>{instruction}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Supplier-facing message"
          description={`To ${quote.supplier.email ?? quote.supplier.whatsapp ?? "the supplier"} · created ${formatDateTime(quote.createdAt)}`}
          action={<Badge tone={errors.length > 0 ? "danger" : "ok"}>{errors.length > 0 ? "Blocked" : "Ready"}</Badge>}
        />
        <form action={updateSupplierDraftAction} className="space-y-3 px-4 py-4">
          <input type="hidden" name="quoteId" value={quote.id} />
          <label className="block text-xs text-soft">
            Subject
            <input name="subject" defaultValue={quote.subject ?? ""} maxLength={180} required className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-xs text-soft">
            Message
            <textarea name="body" defaultValue={quote.messageBody ?? ""} rows={22} maxLength={12000} required className={`${textareaClass} mt-1 font-mono text-[12px]`} />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted">
              Internal notes, catalogue references and unverified specifications must never appear in this message.
            </p>
            <Button variant="primary">Save draft</Button>
          </div>
        </form>
      </Card>

      <p className="text-[11px] text-muted">
        Approval is recorded per message. Sending still checks do-not-contact, bounced and excluded suppliers and the daily cap.
      </p>
    </div>
  );
}
