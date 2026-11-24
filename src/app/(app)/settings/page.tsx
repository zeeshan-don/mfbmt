import { db } from "@/lib/db";
import { getCurrentOrganization } from "@/lib/organization";
import { requireOwner } from "@/lib/auth";
import { env, integrationEnv, whatsAppSignupConfig, MAX_UPLOAD_MB } from "@/lib/env";
import { aiStatus } from "@/lib/ai/provider";
import { getWhatsAppConnection } from "@/lib/integrations/whatsapp";
import { emailSyncState } from "@/lib/email/sync";
import { microsoftConnectionState } from "@/lib/email/oauth";
import { ensureIntegrations } from "@/lib/integrations/store";
import { PERMISSIONS, ROLES, INTEGRATION_STATUS_LABELS } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, inputClass, statusTone, textareaClass } from "@/components/ui";
import { WhatsAppConnect } from "@/components/whatsapp-connect";
import {
  testIntegrationAction,
  syncEmailNowAction,
  saveOutlookPreferencesAction,
  disconnectEmailAction,
  saveOrganizationAction,
  addExcludedContactAction,
  removeExcludedContactAction,
  savePricingRuleAction,
  togglePricingRuleAction,
  deletePricingRuleAction,
  saveLimitsAction,
  createUserAction,
  toggleUserAction,
} from "@/app/actions/settings";
import { CATEGORIES } from "@/lib/catalog/categories";
import { storageDriver } from "@/lib/storage";
import { getOrgLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";

type IntegrationRow = {
  key: string;
  title: string;
  description: string;
  status: string;
  detail?: string;
  lastCheckedAt?: Date | null;
  lastError?: string | null;
  action?: "oauth-gmail" | "oauth-microsoft";
  setup: string;
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tested?: string;
    result?: string;
    saved?: string;
    error?: string;
    sync?: string;
    disconnected?: string;
    connected?: string;
    sending?: string;
    mailbox?: string;
    wa?: string;
  }>;
}) {
  await requireOwner();
  const flags = await searchParams;
  await ensureIntegrations();

  const [integrations, org, exclusions, rules, users, gmail, microsoft, whatsapp, storage, aiIntegration, webIntegration, limits] =
    await Promise.all([
      db.integration.findMany(),
      getCurrentOrganization(),
      db.excludedContact.findMany({ orderBy: { createdAt: "desc" } }),
      db.pricingRule.findMany({ orderBy: [{ scope: "asc" }, { priority: "asc" }] }),
      db.user.findMany({ orderBy: { createdAt: "asc" } }),
      db.integration.findFirst({ where: { key: "GMAIL" } }),
      db.integration.findFirst({ where: { key: "MICROSOFT365" } }),
      getWhatsAppConnection(),
      db.integration.findFirst({ where: { key: "STORAGE" } }),
      db.integration.findFirst({ where: { key: "AI_PROVIDER" } }),
      db.integration.findFirst({ where: { key: "WEB_SEARCH" } }),
      getOrgLimits(),
    ]);

  const ai = aiStatus();
  const waSignup = whatsAppSignupConfig();
  const byKey = new Map(integrations.map((row) => [row.key, row]));
  const microsoftState = microsoftConnectionState(microsoft?.configJson, microsoft?.status);
  const microsoftSyncState = emailSyncState(microsoft?.configJson ?? null);
  const emailState = emailSyncState(
    gmail?.status === "CONNECTED" ? gmail.configJson : (microsoft?.configJson ?? gmail?.configJson ?? null),
  );
  const connectedMailbox = gmail?.status === "CONNECTED" ? "Gmail" : microsoft?.status === "CONNECTED" ? "Microsoft 365" : null;

  // Actual mailbox outcomes for this company, not a hard-coded success state.
  const [emailMessageCount, emailEnquiries, emailSupplierReplies, emailIgnored, attachmentsReview] = await Promise.all([
    db.message.count({ where: { channel: "EMAIL" } }),
    db.enquiry.count({ where: { channel: "EMAIL" } }),
    db.supplierEmailReply.count(),
    db.message.count({ where: { channel: "EMAIL", processingStatus: "IGNORED" } }),
    db.attachment.count({ where: { extractionStatus: { in: ["FAILED", "NEEDS_REVIEW"] } } }),
  ]);

  const rows: IntegrationRow[] = [
    {
      key: "AI_PROVIDER",
      title: "AI reading service",
      description: "Reads product lists from messages and documents and structures them. It never sets prices or approves anything.",
      status: ai.configured ? (aiIntegration?.status ?? "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: ai.configured
        ? `${ai.provider} · ${ai.model}${aiIntegration?.lastSuccessAt ? ` · last verified ${timeAgo(aiIntegration.lastSuccessAt)}` : ""}`
        : (ai.reason ?? "Not configured."),
      lastCheckedAt: aiIntegration?.lastCheckedAt,
      lastError: aiIntegration?.lastError,
      setup:
        "Set AI_PROVIDER, AI_API_KEY and AI_MODEL in .env. Without it, requests are read with the built-in parser and flagged for review.",
    },
    {
      key: "WEB_SEARCH",
      title: "Web search",
      description: "Finds public supplier listings. A listing is evidence, never a confirmed price.",
      status: integrationEnv.webSearch() ? (webIntegration?.status ?? "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: integrationEnv.webSearch()
        ? `Providers: ${[env.TAVILY_API_KEY ? "Tavily" : null, env.SERPER_API_KEY ? "Serper" : null, env.BRAVE_SEARCH_API_KEY ? "Brave" : null].filter(Boolean).join(" → ")}. Tavily is tried first; falls back to Serper/Brave on quota or auth errors.`
        : "No search provider connected. Set TAVILY_API_KEY or SERPER_API_KEY to enable public supplier search.",
      lastCheckedAt: webIntegration?.lastCheckedAt,
      lastError: webIntegration?.lastError,
      setup: "Supported: Tavily, Serper or Brave Search official APIs. No scraping behind logins, CAPTCHAs or blocks.",
    },
    {
      key: "EXCHANGE_RATE",
      title: "Currency rates",
      description: "Converts supplier prices to AED using a recorded rate and timestamp.",
      status: integrationEnv.exchangeRate() ? (byKey.get("EXCHANGE_RATE")?.status ?? "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: integrationEnv.exchangeRate()
        ? `Provider: ${env.EXCHANGE_RATE_PROVIDER}.`
        : "No rate source configured. Cross-currency offers are marked incomplete instead of guessed.",
      lastCheckedAt: byKey.get("EXCHANGE_RATE")?.lastCheckedAt,
      lastError: byKey.get("EXCHANGE_RATE")?.lastError,
      setup: "Set EXCHANGE_RATE_PROVIDER=exchangerate_host with an API key, or fixed for the USD/AED peg.",
    },
    {
      key: "STORAGE",
      title: "File storage",
      description: "Stores customer attachments and quotation PDFs. Downloads require an authorised, expiring link.",
      status: storage?.status ?? "NEEDS_ATTENTION",
      detail:
        storageDriver === "s3"
          ? `Object storage: ${env.S3_BUCKET || "bucket not set"}${env.S3_ENDPOINT ? ` at ${env.S3_ENDPOINT}` : ""}.`
          : `Local folder: ${env.STORAGE_ROOT}. Max upload ${MAX_UPLOAD_MB} MB (also the Server Action limit).`,
      lastCheckedAt: storage?.lastCheckedAt,
      lastError: storage?.lastError,
      setup:
        storageDriver === "s3"
          ? "Private bucket; downloads use short-lived authenticated URLs. No public access."
          : "Local disk must be a persistent volume. On an ephemeral host, configure STORAGE_DRIVER=s3 instead.",
    },
    {
      key: "OCR",
      title: "Photo and scan reading",
      description: "Reads photographed lists, scanned PDFs and images.",
      status:
        env.OCR_PROVIDER === "none" ? "NOT_CONFIGURED" : (byKey.get("OCR")?.status ?? "NEEDS_ATTENTION"),
      detail:
        env.OCR_PROVIDER === "none"
          ? "Turned off. Images are attached for manual reading."
          : `Built-in OCR (Tesseract), languages: ${env.OCR_LANGUAGES}. Scanned PDFs are rendered and read page by page.`,
      lastCheckedAt: byKey.get("OCR")?.lastCheckedAt,
      setup:
        "Arabic needs OCR_LANGUAGES to include “ara”. Language data is downloaded once on first use, so the server needs internet access the first time.",
    },
  ];

  const oauthConfigured = {
    gmail: Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  };

  const emailRows = [
    {
      key: "GMAIL" as const,
      title: "Gmail",
      status: gmail?.status ?? "NOT_CONFIGURED",
      account: gmail?.accountLabel ?? null,
      lastCheckedAt: gmail?.lastCheckedAt ?? null,
      lastSuccessAt: gmail?.lastSuccessAt ?? null,
      lastError: gmail?.lastError ?? null,
      scopes: "gmail.readonly, gmail.send",
      push: integrationEnv.gmailPush(),
      configured: oauthConfigured.gmail,
      provider: "gmail" as const,
    },
    {
      key: "MICROSOFT365" as const,
      title: "Microsoft 365 / Outlook",
      status: microsoft?.status ?? "NOT_CONFIGURED",
      account: microsoft?.accountLabel ?? null,
      lastCheckedAt: microsoft?.lastCheckedAt ?? null,
      lastSuccessAt: microsoft?.lastSuccessAt ?? null,
      lastError: microsoft?.lastError ?? null,
      scopes: "read-only: Mail.Read · sending is a separate optional permission",
      push: integrationEnv.graphPush(),
      configured: oauthConfigured.microsoft,
      provider: "microsoft" as const,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Connections, company details, inventory policy, pricing rules, excluded contacts and staff access."
      />

      {flags.error ? <Notice tone="danger" title="Could not save">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Settings saved.</Notice> : null}
      {flags.connected ? (
        <Notice tone="ok" title="Outlook connected">
          {flags.mailbox ? `${flags.mailbox} is connected. ` : ""}The first mailbox scan starts in the background; new email is read automatically.
        </Notice>
      ) : null}
      {flags.sending ? (
        <Notice tone="ok" title="Email sending enabled">
          Sending permission was granted for {flags.mailbox ?? "the connected mailbox"}. Supplier RFQs still require your approval before anything is sent.
        </Notice>
      ) : null}
      {flags.wa === "connected" ? <Notice tone="ok">WhatsApp linked. Run a connection test to confirm it.</Notice> : null}
      {flags.sync ? <Notice tone="info" title="Mailbox check">{flags.sync}</Notice> : null}
      {flags.disconnected ? <Notice tone="info">Mailbox disconnected.</Notice> : null}
      {flags.tested ? (
        <Notice tone={flags.result?.startsWith("CONNECTED") ? "ok" : "warn"} title={`Connection test: ${flags.tested}`}>
          {flags.result?.replace(/^[A-Z_]+:\s*/, "")}
        </Notice>
      ) : null}

      <section id="whatsapp" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">WhatsApp Business</h2>
        <p className="text-xs text-muted">
          Connect this company&apos;s own WhatsApp Business number with Meta&apos;s Embedded Signup. Credentials are stored
          encrypted for this company only.
        </p>
        <Card>
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Connection</h3>
              <p className="mt-0.5 text-[11px] text-muted">
                Receives customer messages and attachments on the connected business number.
              </p>
            </div>
            <Badge tone={statusTone(whatsapp?.status ?? "NOT_CONFIGURED")} dot>
              {INTEGRATION_STATUS_LABELS[whatsapp?.status ?? "NOT_CONFIGURED"] ?? whatsapp?.status}
            </Badge>
          </div>

          {!waSignup.configured ? (
            <div className="px-4 py-3">
              <Notice tone="warn" title="Meta app setup is incomplete">
                The platform administrator must set {waSignup.missing.join(", ")} before WhatsApp can be connected. The rest of
                the workspace keeps working without it.
              </Notice>
            </div>
          ) : (
            <WhatsAppConnect
              connected={Boolean(whatsapp?.connected)}
              businessName={whatsapp?.businessName ?? null}
              phoneNumber={whatsapp?.phoneNumber ?? null}
              status={whatsapp?.status ?? "NOT_CONFIGURED"}
              lastError={whatsapp?.lastError ?? null}
              lastCheckedAt={whatsapp?.lastCheckedAt ?? null}
            />
          )}

          <div className="border-t border-line px-4 py-3 text-[11px] text-muted">
            <p>
              Webhook URL: <code className="rounded bg-elevated px-1">{env.APP_URL.replace(/\/$/, "")}/api/webhooks/whatsapp</code>
            </p>
            <p className="mt-1">
              Verify token is configured ({env.WHATSAPP_VERIFY_TOKEN ? "set" : "missing"}). Subscribe to the <code>messages</code>{" "}
              field for this WABA.
            </p>
            <p className="mt-1">
              Business-initiated messages outside Meta&apos;s 24-hour service window need an approved template; free-form sends are
              reported as rejected rather than retried silently.
            </p>
          </div>
        </Card>
      </section>

      <section id="email" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Email intake</h2>
        <p className="text-xs text-muted">
          New enquiries are read automatically. Push notifications are used where configured; otherwise the worker polls with a
          persistent cursor, so messages are not re-read or missed.
        </p>
        <p className="text-[11px] text-muted">
          Connect with secure Microsoft sign-in — MFBMT never receives the mailbox password. The first connection is read-only;
          email sending requires a separate permission you grant explicitly. Shared mailboxes are not supported in this
          release; connect the mailbox owner&apos;s own Microsoft account.
        </p>
        {connectedMailbox ? (
          <Card>
            <div className="grid gap-2 px-4 py-3 text-xs text-soft sm:grid-cols-3">
              <p>
                <span className="text-muted">Connected mailbox:</span> {connectedMailbox}
              </p>
              <p>
                <span className="text-muted">Mode:</span>{" "}
                {emailState.mode === "push" ? "Push notifications" : "Scheduled polling"}
              </p>
              <p>
                <span className="text-muted">Last successful sync:</span>{" "}
                {emailState.lastSuccessAt ? timeAgo(new Date(emailState.lastSuccessAt)) : "Never"}
              </p>
              <p>
                <span className="text-muted">Last attempt:</span>{" "}
                {emailState.lastSyncAt ? formatDateTime(new Date(emailState.lastSyncAt)) : "—"}
              </p>
              <p>
                <span className="text-muted">Poll interval:</span> {Math.round(env.EMAIL_POLL_INTERVAL_MS / 1000)}s
              </p>
              <p>
                <span className="text-muted">Last error:</span> {emailState.lastError ?? "none"}
              </p>
            </div>
          </Card>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          {emailRows.map((row) => (
            <Card key={row.key} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{row.title}</h3>
                  <p className="mt-0.5 text-[11px] text-muted">Scopes requested: {row.scopes}.</p>
                </div>
                <Badge tone={statusTone(row.status)} dot>
                  {INTEGRATION_STATUS_LABELS[row.status] ?? row.status}
                </Badge>
              </div>
              <div className="flex-1 space-y-2 px-4 py-3">
                <p className="text-xs text-soft">{row.account ?? "No mailbox connected."}</p>
                <p className="text-[11px] text-muted">
                  {row.push
                    ? "Push notifications are configured; the worker also polls as a fallback."
                    : "Push notifications are not configured for this mailbox, so the worker polls on a schedule."}
                </p>
                <p className="text-[11px] text-muted">
                  Last successful sync: {row.lastSuccessAt ? timeAgo(row.lastSuccessAt) : "never"}
                </p>
                {row.lastError ? <p className="text-[11px] text-warn">{row.lastError}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
                <form action={testIntegrationAction}>
                  <input type="hidden" name="key" value={row.key} />
                  <Button size="sm">Test connection</Button>
                </form>
                {row.configured ? (
                  row.provider === "gmail" ? (
                    <a
                      href="/api/integrations/gmail/start"
                      className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-xs text-ink hover:bg-elevated"
                    >
                      {row.status === "CONNECTED" ? "Reconnect Gmail" : "Connect Gmail"}
                    </a>
                  ) : (
                    <a
                      href="/api/integrations/microsoft/start"
                      className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-xs text-ink hover:bg-elevated"
                    >
                      {row.status === "CONNECTED" ? "Reconnect Microsoft Outlook" : "Connect Microsoft Outlook"}
                    </a>
                  )
                ) : (
                  <span className="text-[11px] text-muted">
                    OAuth client not configured ({row.provider === "gmail" ? "GMAIL_CLIENT_ID" : "MICROSOFT_CLIENT_ID"}).
                  </span>
                )}
                {row.status === "CONNECTED" ? (
                  <>
                    <form action={syncEmailNowAction}>
                      <Button size="sm">Check now</Button>
                    </form>
                    <form action={disconnectEmailAction}>
                      <input type="hidden" name="provider" value={row.provider} />
                      <Button size="sm" variant="danger">Disconnect</Button>
                    </form>
                  </>
                ) : null}
              </div>
            </Card>
          ))}
        </div>

        {microsoftState.connected ? (
          <Card>
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-ink">Outlook mailbox health</h3>
                <p className="mt-0.5 text-[11px] text-muted">
                  {microsoftState.accountEmail ?? "Mailbox address unavailable"}
                  {microsoftState.displayName ? ` · ${microsoftState.displayName}` : ""}
                </p>
              </div>
              <Badge tone={statusTone(microsoftState.status)} dot>
                {INTEGRATION_STATUS_LABELS[microsoftState.status] ?? microsoftState.status}
              </Badge>
            </div>
            <div className="grid gap-2 px-4 py-3 text-xs text-soft sm:grid-cols-3">
              <p>
                <span className="text-muted">Connection:</span>{" "}
                {microsoftState.mailboxMode === "user" ? "Your own mailbox" : "Shared mailbox"}
              </p>
              <p>
                <span className="text-muted">Monitored folder:</span> {microsoftState.folder}
              </p>
              <p>
                <span className="text-muted">First scan:</span>{" "}
                {microsoftState.initialSyncCompleted ? "Complete" : "In progress"} · last {microsoftState.initialSyncDays} days
              </p>
              <p>
                <span className="text-muted">Automatic sync:</span> {microsoftSyncState.autoSyncEnabled ? "On" : "Paused"}
              </p>
              <p>
                <span className="text-muted">Push notifications:</span>{" "}
                {microsoftSyncState.pushStatus === "ACTIVE"
                  ? "Active"
                  : microsoftSyncState.pushStatus === "FAILED"
                    ? "Unavailable — polling continues"
                    : "Not configured — polling continues"}
              </p>
              <p>
                <span className="text-muted">Email sending:</span>{" "}
                {microsoftState.sendingEnabled ? "Enabled (still requires approval)" : "Read-only"}
              </p>
              <p>
                <span className="text-muted">Emails received:</span> {emailMessageCount}
              </p>
              <p>
                <span className="text-muted">Enquiries from email:</span> {emailEnquiries}
              </p>
              <p>
                <span className="text-muted">Supplier replies matched:</span> {emailSupplierReplies}
              </p>
              <p>
                <span className="text-muted">Messages ignored:</span> {emailIgnored}
              </p>
              <p>
                <span className="text-muted">Attachments needing review:</span> {attachmentsReview}
              </p>
              <p>
                <span className="text-muted">Last scan:</span>{" "}
                {microsoftSyncState.stats.messagesScanned ?? 0} message(s),{" "}
                {microsoftSyncState.stats.attachmentsProcessed ?? 0} attachment(s)
              </p>
              <p>
                <span className="text-muted">Last successful sync:</span>{" "}
                {microsoftSyncState.lastSuccessAt ? timeAgo(new Date(microsoftSyncState.lastSuccessAt)) : "Never"}
              </p>
              <p>
                <span className="text-muted">Last error:</span> {microsoftSyncState.lastError ?? "none"}
              </p>
            </div>
            <div className="border-t border-line px-4 py-3">
              <form action={saveOutlookPreferencesAction} className="flex flex-wrap items-end gap-3">
                <label className="text-[11px] text-muted">
                  Monitored folder
                  <input name="folder" defaultValue={microsoftState.folder} className={`${inputClass} mt-1 w-36`} />
                </label>
                <label className="text-[11px] text-muted">
                  First scan (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    name="initialSyncDays"
                    defaultValue={microsoftState.initialSyncDays}
                    className={`${inputClass} mt-1 w-24`}
                  />
                </label>
                <label className="flex items-center gap-2 pb-2 text-xs text-soft">
                  <input
                    type="checkbox"
                    name="autoSyncEnabled"
                    defaultChecked={microsoftSyncState.autoSyncEnabled}
                    className="h-4 w-4"
                  />
                  Read new email automatically
                </label>
                <Button size="sm">Save</Button>
              </form>
              {!microsoftState.sendingEnabled ? (
                <div className="mt-3 rounded-control border border-line bg-elevated px-3 py-2 text-[11px] text-muted">
                  Sending is off. Supplier RFQs can be prepared but not emailed until you{" "}
                  <a className="text-accent underline" href="/api/integrations/microsoft/start?intent=send">
                    enable email sending
                  </a>{" "}
                  with a separate Microsoft permission. Approval is still required before any supplier email is sent.
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader title="Which emails are read?" description="Intake is limited to the connected mailbox." />
            <div className="space-y-2 px-4 py-3 text-xs text-soft">
              <p>
                Gmail search filter:{" "}
                <code className="rounded bg-elevated px-1">{env.EMAIL_FILTER || "no filter — the whole inbox"}</code>
              </p>
              <p>
                Outlook folder: <code className="rounded bg-elevated px-1">{env.EMAIL_FOLDER}</code>
              </p>
              <p className="text-[11px] text-muted">
                A search filter narrows what is read afterwards; it does not narrow the OAuth permission granted to the app. The
                permission itself is the limit. A dedicated enquiries mailbox (or forwarding to one) is the cleanest arrangement when
                personal mail shares the inbox.
              </p>
            </div>
          </Card>
          <Card>
            <CardHeader title="Forwarding alternative" description="If you prefer not to connect a mailbox." />
            <div className="space-y-2 px-4 py-3 text-xs text-soft">
              <p>
                A forwarding service can POST to{" "}
                <code className="rounded bg-elevated px-1">/api/webhooks/inbound-email</code> with the{" "}
                <code className="rounded bg-elevated px-1">x-inbound-secret</code> header.
              </p>
              <p className="text-[11px] text-muted">
                Forwarded messages go through exactly the same classification, exclusion and extraction pipeline.
              </p>
            </div>
          </Card>
        </div>
      </section>

      <section id="integrations" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Other connections</h2>
        <p className="text-xs text-muted">
          A connection is only shown as connected after a real provider request succeeds. Saving a key alone never marks it active.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <Card key={row.key} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{row.title}</h3>
                  <p className="mt-0.5 text-[11px] text-muted">{row.description}</p>
                </div>
                <Badge tone={statusTone(row.status)} dot>
                  {INTEGRATION_STATUS_LABELS[row.status] ?? row.status}
                </Badge>
              </div>
              <div className="flex-1 space-y-2 px-4 py-3">
                <p className="text-xs text-soft">{row.detail}</p>
                <p className="text-[11px] text-muted">{row.setup}</p>
                <p className="text-[11px] text-muted">
                  {row.lastCheckedAt ? `Last checked ${timeAgo(row.lastCheckedAt)}.` : "Never tested."}
                </p>
                {row.lastError ? <p className="text-[11px] text-warn">{row.lastError}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
                <form action={testIntegrationAction}>
                  <input type="hidden" name="key" value={row.key} />
                  <Button size="sm">Test connection</Button>
                </form>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section id="company" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Company, inventory policy and quotation defaults</h2>
        <Card>
          <form action={saveOrganizationAction} className="grid gap-3 px-4 py-4 sm:grid-cols-3">
            <label className="block text-xs text-soft sm:col-span-2">
              Trading name
              <input name="name" defaultValue={org?.name ?? ""} placeholder="Your registered trading name" className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Legal name
              <input name="legalName" defaultValue={org?.legalName ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              TRN
              <input name="taxRegistrationNumber" defaultValue={org?.taxRegistrationNumber ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Email
              <input name="email" defaultValue={org?.email ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Phone
              <input name="phone" defaultValue={org?.phone ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Owner WhatsApp for alerts
              <input name="ownerWhatsappNumber" defaultValue={org?.ownerWhatsappNumber ?? ""} placeholder="+971501234567" className={`${inputClass} mt-1`} />
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs text-soft">
              <input type="checkbox" name="whatsappApprovalAlerts" defaultChecked={org?.whatsappApprovalAlerts ?? false} />
              Send approval alerts on WhatsApp (Meta rules still apply)
            </label>
            <label className="block text-xs text-soft sm:col-span-2">
              Address
              <input name="address" defaultValue={org?.address ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Website
              <input name="website" defaultValue={org?.website ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Default currency
              <input name="defaultCurrency" defaultValue={org?.defaultCurrency ?? "AED"} maxLength={3} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Quotation validity (days)
              <input name="quotationValidityDays" type="number" min={1} defaultValue={org?.quotationValidityDays ?? 14} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Inventory policy
              <select name="inventoryMode" defaultValue={org?.inventoryMode ?? "STOCK_FIRST"} className={`${inputClass} mt-1`}>
                <option value="STOCK_FIRST">Check stock first, then source the shortage</option>
                <option value="SOURCING_FIRST">Sourcing-first (the company mostly outsources goods)</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs text-soft">
              <input type="checkbox" name="taxEnabled" defaultChecked={org?.taxEnabled ?? false} />
              Apply tax on customer quotations
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs text-soft">
              <input type="checkbox" name="taxInLandedCost" defaultChecked={org?.taxInLandedCost ?? false} />
              Include supplier tax in landed cost
            </label>
            <label className="block text-xs text-soft">
              Tax label
              <input name="taxLabel" defaultValue={org?.taxLabel ?? "VAT"} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Tax rate (%)
              <input name="taxRatePct" type="number" step="0.01" defaultValue={org?.taxRatePct ?? 5} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Minimum gross margin (%)
              <input name="minMarginPct" type="number" min={0} max={100} step="0.1" defaultValue={org?.minMarginPct ?? 0} className={`${inputClass} mt-1 tabular`} />
            </label>
            <p className="pt-5 text-[11px] text-muted">
              A positive floor blocks PDF creation and release below it. The owner can still approve with an explicit recorded exception.
            </p>
            <label className="block text-xs text-soft sm:col-span-3">
              Default quotation terms
              <textarea name="quotationTerms" rows={3} defaultValue={org?.quotationTerms ?? ""} className={`${textareaClass} mt-1`} />
            </label>
            <div className="sm:col-span-3">
              <Button size="sm" variant="primary">Save company details</Button>
            </div>
          </form>
        </Card>
      </section>

      <section id="contacts" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Family and personal contacts</h2>
        <p className="text-xs text-muted">
          Numbers and addresses listed here never create an enquiry, never start a supplier search and never receive an automated
          reply. Message bodies and attachments are not stored and are never sent to an AI provider.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader title="Add an excluded contact" />
            <form action={addExcludedContactAction} className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              <label className="block text-xs text-soft">
                Phone or email *
                <input name="identifier" required className={`${inputClass} mt-1`} placeholder="+9715… or name@example.com" />
              </label>
              <label className="block text-xs text-soft">
                Category
                <select name="category" className={`${inputClass} mt-1`}>
                  <option value="FAMILY">Family</option>
                  <option value="PERSONAL">Personal</option>
                  <option value="OTHER">Other (never business)</option>
                  <option value="TRUSTED_SUPPLIER">Trusted supplier</option>
                  <option value="CUSTOMER">Customer</option>
                </select>
              </label>
              <label className="block text-xs text-soft">Name<input name="label" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Note<input name="reason" className={`${inputClass} mt-1`} /></label>
              <div className="sm:col-span-2"><Button size="sm" variant="primary">Save contact rule</Button></div>
            </form>
          </Card>
          <Card>
            <CardHeader title="Excluded contacts" description="Messages from these contacts are ignored and their content is not kept." />
            {exclusions.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No excluded contacts yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {exclusions.map((contact) => (
                  <li key={contact.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <div>
                      <p className="text-xs text-ink">{contact.label ?? contact.identifier}</p>
                      <p className="text-[11px] text-muted">
                        {contact.identifier} · {contact.category.toLowerCase()}
                        {contact.reason ? ` · ${contact.reason}` : ""}
                      </p>
                    </div>
                    <form action={removeExcludedContactAction}>
                      <input type="hidden" name="id" value={contact.id} />
                      <Button size="sm" variant="ghost">Remove</Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      <section id="pricing" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Pricing rules</h2>
        <p className="text-xs text-muted">
          Applied when a customer quotation is prepared. Category rules win over the global rule. Supplier cost and margin never
          appear on the customer document.
        </p>
        <Card>
          <CardHeader title="Active rules" />
          {rules.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted">
              No pricing rules yet. Until one exists, quotation prices must be entered manually.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {rules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <p className="text-xs text-ink">
                      {rule.scope === "GLOBAL" ? "All products" : rule.category}
                      {rule.customerTier ? ` · ${rule.customerTier} tier` : ""} ·{" "}
                      {rule.type === "PERCENT_MARKUP"
                        ? `${rule.value}% markup`
                        : rule.type === "FIXED_MARKUP"
                          ? `+${rule.value} fixed`
                          : "manual price"}
                    </p>
                    <p className="text-[11px] text-muted">Priority {rule.priority}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={rule.isActive ? "ok" : "neutral"}>{rule.isActive ? "active" : "paused"}</Badge>
                    <form action={togglePricingRuleAction}>
                      <input type="hidden" name="id" value={rule.id} />
                      <Button size="sm" variant="ghost">{rule.isActive ? "Pause" : "Activate"}</Button>
                    </form>
                    <form action={deletePricingRuleAction}>
                      <input type="hidden" name="id" value={rule.id} />
                      <Button size="sm" variant="ghost">Delete</Button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <details className="border-t border-line">
            <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-accent hover:underline">Add a rule</summary>
            <form action={savePricingRuleAction} className="grid gap-3 border-t border-line px-4 py-4 sm:grid-cols-4">
              <label className="block text-xs text-soft">
                Applies to
                <select name="scope" className={`${inputClass} mt-1`}>
                  <option value="GLOBAL">All products</option>
                  <option value="CATEGORY">One category</option>
                </select>
              </label>
              <label className="block text-xs text-soft">
                Category (if above)
                <select name="category" className={`${inputClass} mt-1`}>
                  <option value="">—</option>
                  {CATEGORIES.map((category) => (
                    <option key={category.name} value={category.name}>{category.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-soft">
                Type
                <select name="type" className={`${inputClass} mt-1`}>
                  <option value="PERCENT_MARKUP">Percentage markup</option>
                  <option value="FIXED_MARKUP">Fixed markup</option>
                  <option value="MANUAL">Manual price only</option>
                </select>
              </label>
              <label className="block text-xs text-soft">
                Customer tier (optional)
                <select name="customerTier" className={`${inputClass} mt-1`}>
                  <option value="">All tiers</option>
                  <option value="STANDARD">Standard</option>
                  <option value="SILVER">Silver</option>
                  <option value="GOLD">Gold</option>
                  <option value="STRATEGIC">Strategic</option>
                </select>
              </label>
              <label className="block text-xs text-soft">
                Value
                <input name="value" inputMode="decimal" defaultValue="15" className={`${inputClass} mt-1 tabular`} />
              </label>
              <div className="sm:col-span-4"><Button size="sm">Save rule</Button></div>
            </form>
          </details>
        </Card>
      </section>

      <section id="limits" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Cost and volume limits</h2>
        <p className="text-xs text-muted">
          These limits are deterministic and per company. Reaching one degrades to the built-in parser and notifies you; work is never silently discarded.
        </p>
        <Card>
          <form action={saveLimitsAction} className="grid gap-3 px-4 py-4 sm:grid-cols-3">
            <label className="block text-xs text-soft">
              Maximum items sourced per enquiry
              <input name="maxItemsPerEnquiry" type="number" min={1} max={50} defaultValue={limits.maxItemsPerEnquiry} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Maximum search queries per item
              <input name="maxSearchQueriesPerItem" type="number" min={1} max={10} defaultValue={limits.maxSearchQueriesPerItem} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Monthly AI budget (AED)
              <input name="monthlyAiBudgetAed" type="number" min={0} step="0.01" defaultValue={limits.monthlyAiBudgetAed} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Monthly enquiry allowance
              <input name="monthlyEnquiryAllowance" type="number" min={0} defaultValue={limits.monthlyEnquiryAllowance} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              SLA overdue threshold (hours)
              <input name="slaOverdueHours" type="number" min={1} max={720} defaultValue={limits.slaOverdueHours} className={`${inputClass} mt-1 tabular`} />
            </label>
            <label className="block text-xs text-soft">
              Search/page cache TTL (days)
              <input name="searchCacheTtlDays" type="number" min={1} max={90} defaultValue={limits.searchCacheTtlDays} className={`${inputClass} mt-1 tabular`} />
            </label>
            <div className="space-y-2 pt-5">
              <label className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" name="webSearchEnabled" defaultChecked={limits.webSearchEnabled} /> Enable public web search</label>
              <label className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" name="lowConfidenceSecondPass" defaultChecked={limits.lowConfidenceSecondPass} /> Second AI pass for low-confidence items</label>
              <label className="flex items-center gap-2 text-xs text-soft">
                <input type="checkbox" name="supplierAutoSendVerified" defaultChecked={limits.supplierAutoSendVerified} />
                Auto-send drafted RFQs only to verified suppliers
              </label>
              <p className="text-[11px] text-muted">
                Off by default. When on, each automatic send is recorded against this standing owner policy and still obeys do-not-contact, bounce and daily limits.
              </p>
            </div>
            <div className="sm:col-span-3"><Button size="sm" variant="primary">Save limits</Button></div>
          </form>
        </Card>
      </section>

      <section id="team" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">People and access</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader title="Accounts" description="Owner has full access. Staff only see what you allow." />
            <ul className="divide-y divide-line">
              {users.map((account) => (
                <li key={account.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <p className="text-xs text-ink">
                      {account.name} · {account.role === "OWNER" ? "Owner" : "Staff"}
                    </p>
                    <p className="text-[11px] text-muted">
                      {account.email} · {account.isActive ? "active" : "inactive"}
                      {account.lastLoginAt ? ` · last sign-in ${formatDateTime(account.lastLoginAt)}` : ""}
                    </p>
                  </div>
                  {account.role !== ROLES.OWNER ? (
                    <form action={toggleUserAction}>
                      <input type="hidden" name="id" value={account.id} />
                      <Button size="sm" variant="ghost">{account.isActive ? "Deactivate" : "Activate"}</Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Add a staff account" description="Staff can never approve suppliers, change pricing or release quotations." />
            <form action={createUserAction} className="space-y-2 px-4 py-3">
              <label className="block text-xs text-soft">Name<input name="name" required className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Email<input name="email" type="email" required className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">
                Temporary password
                <input name="password" type="password" minLength={10} required className={`${inputClass} mt-1`} />
              </label>
              <fieldset className="space-y-1 pt-1">
                <legend className="text-xs font-medium text-soft">Allowed areas</legend>
                {PERMISSIONS.map((permission) => (
                  <label key={permission} className="flex items-center gap-2 text-[11px] text-soft">
                    <input type="checkbox" name="permissions" value={permission} defaultChecked={permission.endsWith(".view")} />
                    {permission.replace(".", " — ")}
                  </label>
                ))}
              </fieldset>
              <Button size="sm" variant="primary">Create account</Button>
            </form>
          </Card>
        </div>
        <p className="text-[11px] text-muted">
          The new account must change its password at first sign-in. Own password: <a className="text-accent hover:underline" href="/account">change it here</a>.
        </p>
      </section>
    </div>
  );
}
