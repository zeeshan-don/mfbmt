import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { env, integrationEnv, whatsAppSignupConfig } from "@/lib/env";
import { aiStatus } from "@/lib/ai/provider";
import { getWhatsAppConnection } from "@/lib/integrations/whatsapp";
import { emailSyncState } from "@/lib/email/sync";
import { storageDriver } from "@/lib/storage";
import { workerLiveness } from "@/lib/workflow/jobs";
import { JOB_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, statusTone } from "@/components/ui";
import { completeOnboardingAction } from "@/app/actions/settings";

export const dynamic = "force-dynamic";

type Step = {
  title: string;
  required: boolean;
  done: boolean;
  status: string;
  detail: string;
  href: string;
  action: string;
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;

  const [org, whatsapp, gmail, microsoft, ai, products, suppliers, exclusions, rules, jobs, worker] = await Promise.all([
    db.organization.findFirst(),
    getWhatsAppConnection(),
    db.integration.findUnique({ where: { key: "GMAIL" } }),
    db.integration.findUnique({ where: { key: "MICROSOFT365" } }),
    db.integration.findUnique({ where: { key: "AI_PROVIDER" } }),
    db.product.count(),
    db.supplier.count(),
    db.excludedContact.count(),
    db.pricingRule.count({ where: { isActive: true } }),
    db.backgroundJob.groupBy({ by: ["status"], _count: { _all: true } }),
    workerLiveness(),
  ]);

  const aiState = aiStatus();
  const waSignup = whatsAppSignupConfig();
  const emailState = emailSyncState(gmail?.configJson ?? microsoft?.configJson ?? null);
  const mailConnected = gmail?.status === "CONNECTED" || microsoft?.status === "CONNECTED";
  const failedJobs = jobs.find((row) => row.status === JOB_STATUS.FAILED)?._count._all ?? 0;
  const pendingJobs = jobs
    .filter((row) => row.status === JOB_STATUS.QUEUED || row.status === JOB_STATUS.PROCESSING)
    .reduce((total, row) => total + row._count._all, 0);
  const sourcingFirst = org?.inventoryMode === "SOURCING_FIRST";
  const workerHealthy = worker.status === "HEALTHY";

  const companyComplete = Boolean(org?.address && org?.email && (org?.trn || org?.legalName));
  const inventoryConfigured = sourcingFirst || Boolean(org?.inventoryConfiguredAt) || products > 0;

  const steps: Step[] = [
    {
      title: "1. Company details and quotation settings",
      required: true,
      done: companyComplete,
      status: companyComplete ? "CONNECTED" : "NEEDS_ATTENTION",
      detail: companyComplete
        ? `${org?.name ?? ""} · ${org?.defaultCurrency ?? "AED"} · ${org?.taxEnabled ? `${org?.taxLabel} ${org?.taxRatePct}%` : "tax off"}`
        : "Add the legal name, address, email, TRN and quotation terms. Nothing is pre-filled with invented company data.",
      href: "/settings#company",
      action: "Edit company details",
    },
    {
      title: "2. Owner account",
      required: true,
      done: true,
      status: "CONNECTED",
      detail: "This account is the owner. Staff accounts can be added at any time; they cannot approve suppliers or release quotations.",
      href: "/settings#team",
      action: "Manage people",
    },
    {
      title: "3. WhatsApp Business",
      required: true,
      done: Boolean(whatsapp?.connected),
      status: whatsapp?.status ?? "NOT_CONFIGURED",
      detail: whatsapp?.connected
        ? `${whatsapp.businessName ?? "Connected business"} · ${whatsapp.phoneNumber ?? ""}`
        : waSignup.configured
          ? "Use Connect WhatsApp to run Meta Embedded Signup for MFBMT's own number."
          : `Meta app configuration is incomplete (${waSignup.missing.join(", ")}).`,
      href: "/settings#whatsapp",
      action: "Connect WhatsApp",
    },
    {
      title: "4. Email intake",
      required: false,
      done: mailConnected,
      status: mailConnected ? "CONNECTED" : "NOT_CONFIGURED",
      detail: mailConnected
        ? `${gmail?.status === "CONNECTED" ? "Gmail" : "Microsoft 365"} · ${emailState.mode === "push" ? "push notifications" : `polling every ${Math.round(env.EMAIL_POLL_INTERVAL_MS / 1000)}s`}${emailState.lastSuccessAt ? ` · last sync ${new Date(emailState.lastSuccessAt).toLocaleString()}` : ""}`
        : "Connect a mailbox or forward enquiries to the inbound-email endpoint. Recommended: a dedicated enquiries mailbox.",
      href: "/settings#email",
      action: "Connect email",
    },
    {
      title: "5. AI document reading",
      required: false,
      done: Boolean(aiState.configured && ai?.status === "CONNECTED"),
      status: aiState.configured ? (ai?.status === "CONNECTED" ? "CONNECTED" : "NEEDS_ATTENTION") : "NOT_CONFIGURED",
      detail: aiState.configured
        ? `${aiState.provider} · ${aiState.model}${ai?.lastSuccessAt ? ` · last verified ${new Date(ai.lastSuccessAt).toLocaleString()}` : " · not tested yet"}. Reads descriptions; never invents quantities, specifications or prices.`
        : `${aiState.reason ?? "Not configured."} Requests are read with the built-in parser and flagged for review.`,
      href: "/settings#integrations",
      action: "Configure AI",
    },
    {
      title: "6. Supplier web search",
      required: false,
      done: Boolean(integrationEnv.webSearch()),
      status: integrationEnv.webSearch() ? "CONNECTED" : "NOT_CONFIGURED",
      detail: integrationEnv.webSearch()
        ? `Providers: ${[env.TAVILY_API_KEY ? "Tavily" : null, env.SERPER_API_KEY ? "Serper" : null, env.BRAVE_SEARCH_API_KEY ? "Brave" : null].filter(Boolean).join(" → ")}. Tavily tried first, falls back on quota/auth errors.`
        : "Without a search provider you can still add suppliers and record their quotations manually.",
      href: "/settings#integrations",
      action: "Configure search",
    },
    {
      title: "7. Inventory import or sourcing-first",
      required: true,
      done: inventoryConfigured,
      status: inventoryConfigured ? "CONNECTED" : "NOT_CONFIGURED",
      detail: inventoryConfigured
        ? `${products} product(s). Policy: ${sourcingFirst ? "sourcing-first" : "stock first, source the shortage"}.`
        : "Import a stock spreadsheet, or set the sourcing-first policy if MFBMT normally outsources goods.",
      href: "/inventory",
      action: "Import inventory",
    },
    {
      title: "8. Supplier directory",
      required: false,
      done: suppliers > 0,
      status: suppliers > 0 ? "CONNECTED" : "NOT_CONFIGURED",
      detail: suppliers > 0 ? `${suppliers} supplier(s) recorded.` : "Add known suppliers so they are searched first.",
      href: "/suppliers",
      action: "Add suppliers",
    },
    {
      title: "9. Pricing and markup rules",
      required: true,
      done: rules > 0,
      status: rules > 0 ? "CONNECTED" : "NEEDS_ATTENTION",
      detail: rules > 0 ? `${rules} active rule(s).` : "Without a rule, every quotation price must be entered manually — no default margin is assumed.",
      href: "/settings#pricing",
      action: "Set pricing",
    },
    {
      title: "10. Family and personal contacts",
      required: false,
      done: exclusions > 0,
      status: exclusions > 0 ? "CONNECTED" : "NOT_CONFIGURED",
      detail:
        exclusions > 0
          ? `${exclusions} contact(s) excluded before storage or AI processing.`
          : "Add the personal numbers that share this WhatsApp line so their messages are never stored or processed.",
      href: "/settings#contacts",
      action: "Manage exclusions",
    },
    {
      title: "11. Background worker",
      required: true,
      // An empty failed count proves nothing. Only a fresh worker heartbeat does.
      done: workerHealthy,
      status: workerHealthy ? "CONNECTED" : "NEEDS_ATTENTION",
      detail: workerHealthy
        ? `Worker last checked in ${worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleTimeString("en-GB") : "just now"} · ${pendingJobs} job(s) queued or running${failedJobs > 0 ? ` · ${failedJobs} failed` : ""}.`
        : worker.status === "STALE"
          ? `The worker last checked in ${worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString("en-GB") : "never"} and is not responding. Start it with npm run worker.`
          : "No worker has ever checked in. Start it with npm run worker; queued work will not move until then.",
      href: "/activity",
      action: "Open activity",
    },
  ];

  const requiredOutstanding = steps.filter((step) => step.required && !step.done);
  const nonRequiredOutstanding = steps.filter((step) => !step.required && !step.done);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setup checklist"
        description="Everything below reflects the real state of this installation. Nothing is marked complete until the underlying provider or data actually works."
        actions={
          org?.onboardingCompletedAt ? (
            <Badge tone="ok" dot>
              Setup marked complete
            </Badge>
          ) : null
        }
      />

      {flags.done ? <Notice tone="ok">Setup marked complete.</Notice> : null}

      <Notice tone={requiredOutstanding.length === 0 ? "ok" : "warn"} title={
        requiredOutstanding.length === 0
          ? "Required steps are complete"
          : `${requiredOutstanding.length} required step(s) still open`
      }>
        {requiredOutstanding.length === 0
          ? "Optional connections can be added later without blocking manual enquiries, supplier entry or quotations."
          : `Still needed: ${requiredOutstanding.map((step) => step.title.replace(/^\d+\.\s*/, "")).join(", ")}.`}
      </Notice>

      <Card>
        <CardHeader title="Steps" description="Required steps gate a live workflow; optional steps improve automation." />
        <ul className="divide-y divide-line">
          {steps.map((step) => (
            <li key={step.title} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-[240px] flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-ink">{step.title}</p>
                  {!step.required ? <span className="text-[10px] uppercase tracking-wide text-muted">optional</span> : null}
                </div>
                <p className="mt-0.5 text-[11px] text-muted">{step.detail}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(step.status)} dot>
                  {step.status === "CONNECTED" ? "Done" : step.status === "NOT_CONFIGURED" ? "Not configured" : "Needs attention"}
                </Badge>
                <a
                  href={step.href}
                  className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-xs text-ink hover:bg-elevated"
                >
                  {step.action}
                </a>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Readiness"
          description="Required steps must be complete before the system runs the live workflow end to end."
        />
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-soft">
            Webhook URL: <code className="rounded bg-elevated px-1">{env.APP_URL.replace(/\/$/, "")}/api/webhooks/whatsapp</code>
          </p>
          <p className="text-xs text-soft">
            Storage: <code className="rounded bg-elevated px-1">{storageDriver}</code>
            {storageDriver === "local" ? " — must be a persistent volume in production." : " — private bucket with expiring links."}
          </p>
          {nonRequiredOutstanding.length > 0 ? (
            <p className="text-[11px] text-muted">
              Optional steps still open: {nonRequiredOutstanding.map((step) => step.title.replace(/^\d+\.\s*/, "")).join(", ")}.
            </p>
          ) : null}
          <form action={completeOnboardingAction}>
            <Button variant="primary" size="sm" disabled={requiredOutstanding.length > 0}>
              Mark setup complete
            </Button>
          </form>
          {requiredOutstanding.length > 0 ? (
            <p className="text-[11px] text-muted">Finish the required steps above to enable this button.</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
