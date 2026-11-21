import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";

export default async function ObservabilityPage() {
  const [pendingApprovals, needsReview, failedJobs, deadLetters, integrations] = await Promise.all([
    db.approval.count({ where: { status: "PENDING" } }),
    db.enquiry.count({ where: { status: "NEEDS_REVIEW" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
    db.backgroundJob.count({ where: { status: "FAILED", deadLetteredAt: { not: null } } }),
    db.integration.findMany({ select: { key: true, status: true, lastError: true, lastCheckedAt: true } }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title="Observability" description="Operational counters and integration health." />
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Pending approvals</p><p className="text-2xl font-semibold tabular">{pendingApprovals}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Enquiries needing review</p><p className="text-2xl font-semibold tabular">{needsReview}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Failed jobs</p><p className="text-2xl font-semibold tabular">{failedJobs}</p></div></Card>
        <Card><div className="px-4 py-3"><p className="text-xs text-muted">Dead-lettered jobs</p><p className="text-2xl font-semibold tabular">{deadLetters}</p></div></Card>
      </div>
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