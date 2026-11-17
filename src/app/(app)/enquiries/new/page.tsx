import { requireUser } from "@/lib/auth";
import { Button, ButtonLink, Card, CardHeader, Notice, PageHeader, inputClass, textareaClass } from "@/components/ui";
import { createManualEnquiryAction } from "@/app/actions/intake";

export const dynamic = "force-dynamic";

export default async function NewEnquiryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const { error } = await searchParams;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Add a request"
        description="Use this when a customer sends a request by phone, in person or through a channel that is not connected."
        actions={<ButtonLink href="/enquiries" size="sm" variant="ghost">Back to enquiries</ButtonLink>}
      />

      {error ? <Notice tone="danger" title="Could not add the request">{error}</Notice> : null}

      <Card>
        <CardHeader
          title="Customer request"
          description="Paste the message exactly as received, or type the product list. Attach a photo, PDF or spreadsheet if you have one."
        />
        <form action={createManualEnquiryAction} className="space-y-4 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs text-soft">
              Customer name
              <input name="customerName" className={`${inputClass} mt-1`} placeholder="e.g. Al Noor Contracting" />
            </label>
            <label className="block text-xs text-soft">
              Phone
              <input name="customerPhone" className={`${inputClass} mt-1`} placeholder="+971…" />
            </label>
            <label className="block text-xs text-soft">
              Email
              <input name="customerEmail" type="email" className={`${inputClass} mt-1`} />
            </label>
          </div>

          <label className="block text-xs text-soft">
            What did the customer ask for? *
            <textarea
              name="text"
              rows={7}
              required
              className={`${textareaClass} mt-1`}
              placeholder={"Example:\n10 hammers\n20 pcs SS316 elbow 1 inch\n5 industrial valves"}
            />
          </label>

          <label className="block text-xs text-soft">
            Attachments (PDF, Excel, CSV, image or text)
            <input
              type="file"
              name="attachments"
              multiple
              accept=".pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp"
              className="mt-1 block w-full cursor-pointer rounded-control border border-line bg-bg px-3 py-2 text-sm text-soft file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs file:text-ink"
            />
          </label>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <p className="text-[11px] text-muted">
              The request is read and checked against stock automatically. Incomplete product details will be flagged for you instead of guessed.
            </p>
            <Button variant="primary">Add request</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
