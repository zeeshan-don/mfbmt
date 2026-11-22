import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { recentOutboundMessages } from "@/lib/outbound/messages";
import { Card, PageHeader } from "@/components/ui";
import { reconcileOutboundAction } from "./outbound-actions";

export default async function ObservabilityPage() {
  const user = await requireOwner();
  const [pendingApprovals, needsReview, failedJobs, deadLetters, integrations, outbound] = await Promise.all([
    db.approval.count({ where: { status: "PENDING" } }),
    db.enquiry.count({ where: { status: "NEEDS_REVIEW" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
    db.backgroundJob.count({ where: { status: "FAILED", deadLetteredAt: { not: null } } }),
    db.integration.findMany({ select: { key: true, status: true, lastError: true, lastCheckedAt: true } }),
    recentOutboundMessages(100),
  ]);
  const unknown = outbound.filter((row) => row.status === "UNKNOWN");
  const failedSafe = outbound.filter((row) => row.status === "FAILED_SAFE");

  return (
    <div className="space-y-5">
      <PageHeader title="Observability" description="Operational counters, integration health and uncertain outbound messages." />
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Pending approvals</p><p className="text-2xl font-semibold tabular">{pendingApprovals}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Enquiries needing review</p><p className="text-2xl font-semibold tabular">{needsReview}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Failed jobs</p><p className="text-2xl font-semibold tabular">{failedJobs}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Dead-lettered jobs</p><p className="text-2xl font-semibold tabular">{deadLetters}</p></div></Card>
      </div>

      <Card>
        <div className="px-4 py-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-ink">Outbound messages needing attention</p>
            <p className="text-xs text-muted">
              {unknown.length} UNKNOWN · {failedSafe.length} safe failure{failedSafe.length === 1 ? "" : "s"}
            </p>
          </div>
          <p className="mb-3 text-xs text-soft">
            UNKNOWN means the provider may have accepted the message. It is never retried automatically.
            Check the provider (or the recipient) first, then record the evidence and the decision below.
            A live SENDING claim cannot be reconciled until its lease expires.
          </p>
          {outbound.length === 0 ? (
            <p className="text-sm text-soft">No outbound messages recorded in this organization.</p>
          ) : (
            <div className="space-y-3">
              {outbound.slice(0, 40).map((row) => (
                <div key={row.id} className="rounded border border-line/70 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm text-ink">
                      <span className="font-medium">{row.kind}</span> · {row.channel} · {row.recipient}
                    </p>
                    <p className={`text-xs font-semibold ${row.status === "UNKNOWN" ? "text-danger" : row.status === "SENT" ? "text-success" : "text-soft"}`}>
                      {row.status} · attempt {row.attempts}/{row.maxAttempts}
                    </p>
                  </div>
                  {row.subject ? <p className="mt-1 text-xs text-soft">{row.subject}</p> : null}
                  <p className="mt-1 text-xs text-soft">
                    Provider id: {row.providerMessageId ?? "not recorded"} · created {row.createdAt.toISOString()}
                  </p>
                  {row.lastError ? <p className="mt-1 text-xs text-danger">{row.lastError}</p> : null}
                  {row.status === "UNKNOWN" ? (
                    <form action={reconcileOutboundAction} className="mt-3 grid gap-2 sm:grid-cols-[10rem_12rem_1fr_auto] sm:items-end">
                      <input type="hidden" name="id" value={row.id} />
                      <label className="text-xs text-soft">
                        Decision
                        <select name="resolution" className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink" defaultValue="SENT">
                          <option value="SENT">Provider confirmed sent</option>
                          <option value="NOT_SENT">Provider confirmed not sent</option>
                        </select>
                      </label>
                      <label className="text-xs text-soft">
                        Provider message id (optional)
                        <input name="providerMessageId" className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink" placeholder="from provider log" />
                      </label>
                      <label className="text-xs text-soft">
                        Evidence / audit note (required)
                        <input name="note" required minLength={3} className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink" placeholder="Checked provider log at 14:05; message accepted" />
                      </label>
                      <button type="submit" className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-surface">Record decision</button>
                    </form>
                  ) : null}
                </div>
              ))}
              {outbound.length > 40 ? <p className="text-xs text-soft">Showing the newest 40 of {outbound.length} messages.</p> : null}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-ink">Integrations</p>
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase tracking-wide text-muted"><th className="text-left">Key</th><th className="text-left">Status</th><th className="text-left">Last error</th></tr></thead>
            <tbody>
              {integrations.map((entry) => (
                <tr key={entry.key} className="border-t border-line/70">
                  <td className="py-1.5 text-ink">{entry.key}</td>
                  <td className="py-1.5 text-soft">{entry.status}</td>
                  <td className="py-1.5 text-soft">{entry.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
