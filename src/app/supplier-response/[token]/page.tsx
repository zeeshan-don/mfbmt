import { db } from "@/lib/db";
import { formatQty } from "@/lib/format";
import { submitSupplierResponseAction } from "@/app/actions/intake";
import { Notice, inputClass, textareaClass } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SupplierResponsePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ submitted?: string; error?: string }>;
}) {
  const { token } = await params;
  const flags = await searchParams;

  const quote = await db.supplierQuote.findUnique({
    where: { token },
    include: { supplier: true, items: true },
  });

  const expired = quote ? quote.expiresAt.getTime() < Date.now() : false;
  const already = quote?.status === "RESPONDED";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
      <div className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">Multi Fasteners Building Materials Trading LLC</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">Submit your quotation</h1>
      </div>

      {!quote ? (
        <Notice tone="danger" title="This link is not valid">
          Please contact MFBMT procurement for a new quotation request link.
        </Notice>
      ) : expired ? (
        <Notice tone="warn" title="This link has expired">
          Please contact MFBMT procurement and we will send a fresh request.
        </Notice>
      ) : flags.submitted || already ? (
        <Notice tone="ok" title="Thank you — your quotation was received">
          MFBMT procurement will review your price and contact you if anything needs clarification.
        </Notice>
      ) : (
        <>
          {flags.error ? <Notice tone="danger" title="Could not submit">{flags.error}</Notice> : null}
          <div className="mb-4 rounded-card border border-line bg-surface px-4 py-3 text-sm">
            <p className="text-xs text-muted">Requested by MFBMT · kindly quote:</p>
            {quote.items.map((item) => (
              <div key={item.id} className="mt-1">
                <p className="font-medium text-ink">{item.description}</p>
                <p className="text-xs text-soft">
                  {formatQty(item.quantity, item.unit)}
                  {item.notes ? ` · ${item.notes}` : ""}
                </p>
              </div>
            ))}
          </div>

          <form action={submitSupplierResponseAction} className="panel space-y-4 p-5">
            <input type="hidden" name="token" value={token} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs text-soft">
                Unit price *
                <input name="unitPrice" required inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
              </label>
              <label className="block text-xs text-soft">
                Currency *
                <input name="currency" defaultValue="AED" maxLength={3} required className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-xs text-soft">
                Minimum order quantity
                <input name="moq" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
              </label>
              <label className="block text-xs text-soft">
                Lead time (days)
                <input name="leadTimeDays" inputMode="numeric" className={`${inputClass} mt-1 tabular`} />
              </label>
              <label className="block text-xs text-soft">
                Shipping charges
                <input name="shippingCost" inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
              </label>
              <label className="block text-xs text-soft">
                Quote valid for (days)
                <input name="validityDays" inputMode="numeric" defaultValue="14" className={`${inputClass} mt-1 tabular`} />
              </label>
            </div>
            <label className="block text-xs text-soft">
              Availability
              <input name="availability" className={`${inputClass} mt-1`} placeholder="e.g. ex-stock, 500 available" />
            </label>
            <label className="block text-xs text-soft">
              Notes (payment terms, remarks)
              <textarea name="notes" rows={3} className={`${textareaClass} mt-1`} />
            </label>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted">
                Your price is used only to prepare an MFBMT customer quotation. This is not a purchase order.
              </p>
              <button className="h-9 rounded-control bg-accent px-4 text-sm font-medium text-white hover:opacity-90">
                Submit quotation
              </button>
            </div>
          </form>
          <p className="mt-4 text-[11px] text-muted">
            This secure link expires automatically and cannot be used to access MFBMT&apos;s internal system.
          </p>
        </>
      )}
    </main>
  );
}
