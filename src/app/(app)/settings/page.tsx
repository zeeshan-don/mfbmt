import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { env, integrationEnv } from "@/lib/env";
import { aiStatus } from "@/lib/ai/provider";
import { whatsAppStatus } from "@/lib/intake/whatsapp";
import { ensureIntegrations } from "@/lib/integrations/store";
import { PERMISSIONS, ROLES } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, inputClass, statusTone, textareaClass } from "@/components/ui";
import {
  testIntegrationAction,
  syncEmailNowAction,
  disconnectEmailAction,
  saveOrganizationAction,
  addExcludedContactAction,
  removeExcludedContactAction,
  savePricingRuleAction,
  togglePricingRuleAction,
  deletePricingRuleAction,
  createUserAction,
  toggleUserAction,
} from "@/app/actions/settings";
import { CATEGORIES } from "@/lib/catalog/categories";

export const dynamic = "force-dynamic";

type IntegrationRow = {
  key: string;
  title: string;
  description: string;
  status: string;
  detail?: string;
  lastCheckedAt?: Date | null;
  lastError?: string | null;
  action?: "email" | "oauth-gmail" | "oauth-microsoft";
  setup: string;
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tested?: string; result?: string; saved?: string; error?: string; sync?: string; disconnected?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;
  await ensureIntegrations();

  const [integrations, org, exclusions, rules, users, gmail, microsoft] = await Promise.all([
    db.integration.findMany(),
    db.organization.findFirst(),
    db.excludedContact.findMany({ orderBy: { createdAt: "desc" } }),
    db.pricingRule.findMany({ orderBy: [{ scope: "asc" }, { priority: "asc" }] }),
    db.user.findMany({ orderBy: { createdAt: "asc" } }),
    db.integration.findUnique({ where: { key: "GMAIL" } }),
    db.integration.findUnique({ where: { key: "MICROSOFT365" } }),
  ]);

  const ai = aiStatus();
  const wa = whatsAppStatus();
  const byKey = new Map(integrations.map((row) => [row.key, row]));

  const rows: IntegrationRow[] = [
    {
      key: "WHATSAPP",
      title: "WhatsApp Business",
      description: "Receives customer messages and attachments on the connected business number.",
      status: wa.configured ? (byKey.get("WHATSAPP")?.lastCheckedAt ? byKey.get("WHATSAPP")!.status : "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: wa.configured
        ? "Credentials found. Run a connection test to confirm the number."
        : `Not connected. Missing: ${wa.missing.join(", ") || "credentials"}.`,
      lastCheckedAt: byKey.get("WHATSAPP")?.lastCheckedAt,
      lastError: byKey.get("WHATSAPP")?.lastError,
      setup:
        "Uses Meta's official Cloud API only. The number must be registered to a WhatsApp Business Account. Family and personal chats on a personal inbox are not readable by this integration.",
    },
    {
      key: "GMAIL",
      title: "Gmail",
      description: "Reads customer enquiry emails and sends approved messages from your company mailbox.",
      status: gmail?.status ?? "NOT_CONFIGURED",
      detail: gmail?.accountLabel ?? "Connect with Google to grant read and send access only.",
      lastCheckedAt: gmail?.lastCheckedAt,
      lastError: gmail?.lastError,
      action: "oauth-gmail",
      setup: "Scopes requested: gmail.readonly and gmail.send. Personal mail in other labels is not read unless it matches your enquiry filter.",
    },
    {
      key: "MICROSOFT365",
      title: "Microsoft 365 / Outlook",
      description: "Reads customer enquiry emails and sends approved messages from your company mailbox.",
      status: microsoft?.status ?? "NOT_CONFIGURED",
      detail: microsoft?.accountLabel ?? "Connect with Microsoft to grant Mail.Read and Mail.Send only.",
      lastCheckedAt: microsoft?.lastCheckedAt,
      lastError: microsoft?.lastError,
      action: "oauth-microsoft",
      setup: "Scopes requested: Mail.Read, Mail.Send, offline_access. The folder to read is configured below.",
    },
    {
      key: "AI_PROVIDER",
      title: "AI reading service",
      description: "Reads product lists from messages and documents and structures them. It never sets prices or approves anything.",
      status: ai.configured ? (byKey.get("AI_PROVIDER")?.lastCheckedAt ? byKey.get("AI_PROVIDER")!.status : "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: ai.configured ? `${ai.provider} · ${ai.model}` : ai.reason ?? "Not configured.",
      lastCheckedAt: byKey.get("AI_PROVIDER")?.lastCheckedAt,
      lastError: byKey.get("AI_PROVIDER")?.lastError,
      setup: "Set AI_PROVIDER, AI_API_KEY and AI_MODEL in .env. Without it, requests are read with the built-in parser and flagged for review.",
    },
    {
      key: "WEB_SEARCH",
      title: "Web search",
      description: "Finds public supplier listings. A listing is evidence, never a confirmed price.",
      status: integrationEnv.webSearch() ? (byKey.get("WEB_SEARCH")?.lastCheckedAt ? byKey.get("WEB_SEARCH")!.status : "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: integrationEnv.webSearch()
        ? `${env.WEB_SEARCH_PROVIDER} is configured.`
        : "No search provider connected. Set WEB_SEARCH_PROVIDER and its API key.",
      lastCheckedAt: byKey.get("WEB_SEARCH")?.lastCheckedAt,
      lastError: byKey.get("WEB_SEARCH")?.lastError,
      setup: "Supported: Tavily, Serper or Brave Search official APIs. No scraping behind logins, CAPTCHAs or blocks.",
    },
    {
      key: "EXCHANGE_RATE",
      title: "Currency rates",
      description: "Converts supplier prices to AED using a recorded rate and timestamp.",
      status: integrationEnv.exchangeRate() ? (byKey.get("EXCHANGE_RATE")?.lastCheckedAt ? byKey.get("EXCHANGE_RATE")!.status : "NEEDS_ATTENTION") : "NOT_CONFIGURED",
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
      status: byKey.get("STORAGE")?.lastCheckedAt ? byKey.get("STORAGE")!.status : "NEEDS_ATTENTION",
      detail: `Folder: ${env.STORAGE_ROOT} · max upload ${env.MAX_UPLOAD_MB} MB.`,
      lastCheckedAt: byKey.get("STORAGE")?.lastCheckedAt,
      lastError: byKey.get("STORAGE")?.lastError,
      setup: "Local disk is used by default. Back this folder up together with the database.",
    },
    {
      key: "OCR",
      title: "Photo and scan reading",
      description: "Reads text from photographed lists and scanned pages where possible.",
      status: env.OCR_PROVIDER === "none" ? "NOT_CONFIGURED" : byKey.get("OCR")?.lastCheckedAt ? byKey.get("OCR")!.status : "NEEDS_ATTENTION",
      detail: env.OCR_PROVIDER === "none" ? "Turned off. Images are attached for manual reading." : "Built-in OCR (Tesseract). Language data is downloaded on first use.",
      lastCheckedAt: byKey.get("OCR")?.lastCheckedAt,
      setup: "Scanned PDFs without embedded text are marked for review instead of being guessed.",
    },
  ];

  const oauthConfigured = {
    gmail: Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Connections, company details, pricing rules, excluded contacts and staff access."
      />

      {flags.error ? <Notice tone="danger" title="Could not save">{flags.error}</Notice> : null}
      {flags.saved ? <Notice tone="ok">Settings saved.</Notice> : null}
      {flags.sync ? <Notice tone="info" title="Mailbox check">{flags.sync}</Notice> : null}
      {flags.disconnected ? <Notice tone="info">Mailbox disconnected.</Notice> : null}
      {flags.tested ? (
        <Notice tone={flags.result?.startsWith("CONNECTED") ? "ok" : "warn"} title={`Connection test: ${flags.tested}`}>
          {flags.result?.replace(/^[A-Z_]+:\s*/, "")}
        </Notice>
      ) : null}

      <section id="integrations" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Connections</h2>
        <p className="text-xs text-muted">
          A connection is only shown as connected after a real test succeeds. Saving a key alone never marks it active.
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
                  {row.status === "CONNECTED" ? "Connected" : row.status === "NOT_CONFIGURED" ? "Not connected" : row.status === "NEEDS_ATTENTION" ? "Needs attention" : row.status.toLowerCase()}
                </Badge>
              </div>
              <div className="flex-1 space-y-2 px-4 py-3">
                <p className="text-xs text-soft">{row.detail}</p>
                <p className="text-[11px] text-muted">{row.setup}</p>
                {row.lastCheckedAt ? (
                  <p className="text-[11px] text-muted">Last checked {timeAgo(row.lastCheckedAt)}.</p>
                ) : (
                  <p className="text-[11px] text-muted">Never tested.</p>
                )}
                {row.lastError ? <p className="text-[11px] text-warn">{row.lastError}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
                <form action={testIntegrationAction}>
                  <input type="hidden" name="key" value={row.key} />
                  <Button size="sm">Test connection</Button>
                </form>
                {row.action === "oauth-gmail" && oauthConfigured.gmail ? (
                  <a
                    href="/api/integrations/gmail/start"
                    className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-xs text-ink hover:bg-elevated"
                  >
                    {gmail?.status === "CONNECTED" ? "Reconnect Gmail" : "Connect Gmail"}
                  </a>
                ) : null}
                {row.action === "oauth-microsoft" && oauthConfigured.microsoft ? (
                  <a
                    href="/api/integrations/microsoft/start"
                    className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-xs text-ink hover:bg-elevated"
                  >
                    {microsoft?.status === "CONNECTED" ? "Reconnect Outlook" : "Connect Outlook"}
                  </a>
                ) : null}
                {(row.key === "GMAIL" || row.key === "MICROSOFT365") && (gmail?.status === "CONNECTED" || microsoft?.status === "CONNECTED") ? (
                  <>
                    <form action={syncEmailNowAction}>
                      <Button size="sm">Check mailbox now</Button>
                    </form>
                    <form action={disconnectEmailAction}>
                      <input type="hidden" name="provider" value={row.key === "GMAIL" ? "gmail" : "microsoft"} />
                      <Button size="sm" variant="danger">Disconnect</Button>
                    </form>
                  </>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section id="mailbox" className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Which emails are enquiries?" description="Only messages matching this filter are read." />
          <form action={testIntegrationAction} className="hidden" />
          <div className="space-y-2 px-4 py-3 text-xs text-soft">
            <p>
              Gmail filter in use: <code className="rounded bg-elevated px-1">{env.EMAIL_FILTER}</code>.
              Only messages matching this filter are read.
            </p>
            <p>
              Outlook reads the mail folder <code className="rounded bg-elevated px-1">{env.EMAIL_FOLDER}</code>.
              Messages from excluded contacts never start sourcing.
            </p>
            <p className="text-[11px] text-muted">
              Post-retrieval filtering does not reduce the OAuth permission granted to the app. The permission itself is the limit.
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Forwarding alternative" description="If you prefer not to connect a mailbox." />
          <div className="space-y-2 px-4 py-3 text-xs text-soft">
            <p>
              A forwarding address can post to <code className="rounded bg-elevated px-1">/api/webhooks/inbound-email</code> with the{" "}
              <code className="rounded bg-elevated px-1">INBOUND_EMAIL_SECRET</code> header. Messages are processed exactly like a connected mailbox.
            </p>
            <p className="text-[11px] text-muted">
              Setup steps are in the documentation under “Email connection”.
            </p>
          </div>
        </Card>
      </section>

      <section id="company" className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Company and quotation defaults</h2>
        <Card>
          <form action={saveOrganizationAction} className="grid gap-3 px-4 py-4 sm:grid-cols-3">
            <label className="block text-xs text-soft sm:col-span-2">
              Trading name
              <input name="name" defaultValue={org?.name ?? "Multi Fasteners Building Materials Trading LLC"} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Legal name
              <input name="legalName" defaultValue={org?.legalName ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              TRN
              <input name="trn" defaultValue={org?.trn ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Email
              <input name="email" defaultValue={org?.email ?? ""} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Phone
              <input name="phone" defaultValue={org?.phone ?? ""} className={`${inputClass} mt-1`} />
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
            <label className="flex items-center gap-2 pt-5 text-xs text-soft">
              <input type="checkbox" name="taxEnabled" defaultChecked={org?.taxEnabled ?? false} />
              Apply tax on quotations
            </label>
            <label className="block text-xs text-soft">
              Tax label
              <input name="taxLabel" defaultValue={org?.taxLabel ?? "VAT"} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-soft">
              Tax rate (%)
              <input name="taxRatePct" type="number" step="0.01" defaultValue={org?.taxRatePct ?? 5} className={`${inputClass} mt-1 tabular`} />
            </label>
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
          Numbers and addresses listed here never create an enquiry, never start a supplier search and never receive an automated reply.
          Their message text is not retained.
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
                  <option value="TRUSTED_SUPPLIER">Trusted supplier</option>
                  <option value="CUSTOMER">Customer</option>
                  <option value="OTHER">Other</option>
                </select>
              </label>
              <label className="block text-xs text-soft">Name<input name="label" className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-soft">Note<input name="reason" className={`${inputClass} mt-1`} /></label>
              <div className="sm:col-span-2"><Button size="sm" variant="primary">Save contact rule</Button></div>
            </form>
          </Card>
          <Card>
            <CardHeader title="Excluded contacts" description="Messages from these contacts are ignored for business purposes." />
            {exclusions.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No excluded contacts yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {exclusions.map((contact) => (
                  <li key={contact.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <div>
                      <p className="text-xs text-ink">{contact.label ?? contact.identifier}</p>
                      <p className="text-[11px] text-muted">{contact.identifier} · {contact.category.toLowerCase()}{contact.reason ? ` · ${contact.reason}` : ""}</p>
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
          Applied when a customer quotation is prepared. Category rules win over the global rule. Supplier cost and margin never appear on the customer document.
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
                      {rule.scope === "GLOBAL" ? "All products" : rule.category} ·{" "}
                      {rule.type === "PERCENT_MARKUP" ? `${rule.value}% markup` : rule.type === "FIXED_MARKUP" ? `+${rule.value} fixed` : "manual price"}
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
                Value
                <input name="value" inputMode="decimal" defaultValue="15" className={`${inputClass} mt-1 tabular`} />
              </label>
              <div className="sm:col-span-4"><Button size="sm">Save rule</Button></div>
            </form>
          </details>
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
                    <p className="text-xs text-ink">{account.name} · {account.role === "OWNER" ? "Owner" : "Staff"}</p>
                    <p className="text-[11px] text-muted">{account.email} · {account.isActive ? "active" : "inactive"}
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
      </section>
    </div>
  );
}
