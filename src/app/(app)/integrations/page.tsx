import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { getIntegrationDiagnostics } from "@/lib/integrations/diagnostics";
import { storageReadiness } from "@/lib/storage";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, statusTone } from "@/components/ui";
import { runDiagnosticAction } from "@/app/actions/diagnostics";

export const dynamic = "force-dynamic";

const STATUS_COPY: Record<string, string> = {
  CONNECTED: "Connected and checked",
  NEEDS_ATTENTION: "Needs attention",
  NOT_CONFIGURED: "Not configured",
  NOT_VERIFIED: "Not verified yet",
};

/**
 * Organization-scoped integration diagnostics. Rendering this page makes no
 * provider request; each check is an explicit owner action. No secret value is
 * displayed or returned by the underlying diagnostics.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ checked?: string; result?: string; error?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;
  const diagnostics = await getIntegrationDiagnostics();
  const storage = storageReadiness();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Provider health"
        title="Integrations"
        description="Status is based on real provider checks for this workspace. Stored credentials alone never count as connected."
        actions={
          <Link href="/settings#integrations" className="text-xs text-accent hover:underline">
            Manage connections in Settings
          </Link>
        }
      />

      {flags.error ? <Notice tone="danger" title="Could not run the check">{flags.error}</Notice> : null}
      {flags.checked ? (
        <Notice tone="info" title={`Last check: ${flags.checked}`}>
          {flags.result ?? "Check finished."}
        </Notice>
      ) : null}

      {!storage.ok ? (
        <Notice tone="warn" title="File storage is not ready">
          {storage.detail} File uploads and supplier attachment processing fail closed until this is corrected.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Provider status"
          description="Live checks are non-destructive: profile/metadata reads and a minimal AI prompt. No customer or supplier message is sent."
        />
        <ul className="divide-y divide-line">
          {diagnostics.map((integration) => (
            <li key={integration.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-ink">{integration.label}</p>
                  <Badge tone={statusTone(integration.status)}>{STATUS_COPY[integration.status] ?? integration.status}</Badge>
                  {integration.authenticated === true ? <Badge tone="ok">Authenticated</Badge> : null}
                  {integration.authenticated === false ? <Badge tone="warn">Not authenticated</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-soft">{integration.detail}</p>
                {integration.remediation ? <p className="mt-1 text-[11px] text-muted">{integration.remediation}</p> : null}
                <p className="mt-1 text-[11px] text-muted">
                  Checked {integration.lastCheckedAt ? formatDateTime(integration.lastCheckedAt) : "never"}
                  {integration.lastSuccessAt ? ` · last success ${formatDateTime(integration.lastSuccessAt)}` : ""}
                  {integration.lastSyncAt ? ` · last sync ${formatDateTime(integration.lastSyncAt)}` : ""}
                </p>
              </div>
              <form action={runDiagnosticAction}>
                <input type="hidden" name="key" value={integration.key} />
                <Button size="sm" variant={integration.configured ? "primary" : "ghost"}>
                  Run check
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </Card>

      <p className="text-[11px] text-muted">
        Diagnostics never display tokens, API keys or account secrets. WhatsApp and email are read-only checks; sending a
        supplier RFQ, follow-up or purchase order still requires explicit owner approval.
      </p>
    </div>
  );
}
