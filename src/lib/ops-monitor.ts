import { db } from "./db";
import { activeTenantIds, enqueueJob, workerLiveness } from "./workflow/jobs";
import { getTenantId, runWithTenant } from "./tenant";
import { getSettingJson, setSettingJson } from "./settings";
import { notifyOwner } from "./audit";
import { sendEmail } from "./email/send";
import { JOB_TYPES } from "./constants";
import { aiBudgetStatus, enquiryAllowanceStatus } from "./limits";

/**
 * Operational alerts live in the same durable queue as business work, so a cron
 * request can detect a dead worker even when the daemon is gone. Emails are
 * best-effort (a company may not have a mailbox connected); the in-app
 * notification is always recorded first.
 */

const CHECK_KEY = "ops.lastCheckAt";
const DEAD_LETTER_KEY = "ops.lastDeadLetterAlertAt";
const WORKER_KEY = "ops.lastWorkerAlertAt";
const INTEGRATION_KEY = "ops.lastIntegrationAlertAt";
const DIGEST_KEY = "ops.lastDigestDate";
const LIMIT_WARNING_KEY = "ops.lastLimitWarning";

async function alertOwner(input: {
  type: string;
  title: string;
  body: string;
  link?: string;
}) {
  await notifyOwner(input);
  try {
    const owners = await db.user.findMany({
      where: { role: "OWNER", isActive: true },
      select: { email: true, name: true },
    });
    for (const owner of owners) {
      await sendEmail({
        to: owner.email,
        subject: `[Procurement] ${input.title}`,
        text: [
          `Hello ${owner.name},`,
          "",
          input.body,
          input.link ? `Open: ${input.link}` : "",
          "",
          "This is an automated operational alert. No customer or supplier message was sent by this alert.",
        ]
          .filter(Boolean)
          .join("\n"),
      }).catch(() => undefined);
    }
  } catch {
    // In-app notification is the durable fallback; never fail the job for email.
  }
}

function hourIn(timeZone: string, date = new Date()): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(date),
    );
  } catch {
    return date.getUTCHours();
  }
}

function localDate(timeZone: string, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export async function ensureOpsJobs(now = Date.now()): Promise<void> {
  const checkKey = `ops-check:${Math.floor(now / 600_000)}`;
  const date = new Date(now).toISOString().slice(0, 10);
  for (const organizationId of await activeTenantIds()) {
    await runWithTenant({ organizationId, source: "internal" }, async () => {
      await enqueueJob({
        type: JOB_TYPES.OPS_CHECK,
        payload: {},
        idempotencyKey: checkKey,
        maxAttempts: 1,
      });
      // The digest job is due once per business day. It is safe to enqueue a
      // future job repeatedly: the idempotency key keeps exactly one row.
      const runAfter = new Date(`${date}T07:00:00.000Z`);
      if (runAfter.getTime() < now) runAfter.setTime(now);
      await enqueueJob({
        type: JOB_TYPES.OPS_DIGEST,
        payload: {},
        idempotencyKey: `ops-digest:${date}`,
        runAfter,
        maxAttempts: 2,
      });
    });
  }
}

export async function runOpsCheck(): Promise<{ alerted: string[] }> {
  const now = new Date();
  const alerted: string[] = [];
  const lastDead = await getSettingJson<string>(DEAD_LETTER_KEY, "");
  const since = lastDead ? new Date(lastDead) : new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const deadLetters = await db.backgroundJob.findMany({
    where: { status: "FAILED", deadLetteredAt: { gte: since } },
    orderBy: { deadLetteredAt: "desc" },
    take: 20,
    select: { id: true, type: true, lastError: true, deadLetteredAt: true },
  });
  if (deadLetters.length > 0) {
    await alertOwner({
      type: "OPS_DEAD_LETTER",
      title: `${deadLetters.length} job${deadLetters.length === 1 ? "" : "s"} need a retry`,
      body: deadLetters
        .slice(0, 5)
        .map((job) => `${job.type}: ${(job.lastError ?? "no error recorded").slice(0, 160)}`)
        .join("\n"),
      link: "/activity",
    });
    await setSettingJson(DEAD_LETTER_KEY, now.toISOString());
    alerted.push("dead-letter");
  }

  const worker = await workerLiveness();
  if (worker.status !== "HEALTHY") {
    const lastWorker = await getSettingJson<string>(WORKER_KEY, "");
    if (!lastWorker || now.getTime() - new Date(lastWorker).getTime() > 60 * 60 * 1000) {
      await alertOwner({
        type: "OPS_WORKER_STALE",
        title: worker.status === "UNKNOWN" ? "Background worker has never checked in" : "Background worker is not responding",
        body: worker.lastSeenAt
          ? `Last heartbeat: ${worker.lastSeenAt.toISOString()}. Check the worker process and its logs.`
          : "No worker heartbeat exists. Start the worker or check its deployment.",
        link: "/activity",
      });
      await setSettingJson(WORKER_KEY, now.toISOString());
      alerted.push("worker");
    }
  }

  const integrations = await db.integration.findMany({
    where: { status: "NEEDS_ATTENTION" },
    select: { key: true, lastError: true, lastCheckedAt: true },
  });
  const failing = integrations.filter((integration) => integration.lastError);
  if (failing.length > 0) {
    const lastIntegration = await getSettingJson<string>(INTEGRATION_KEY, "");
    if (!lastIntegration || now.getTime() - new Date(lastIntegration).getTime() > 60 * 60 * 1000) {
      await alertOwner({
        type: "OPS_INTEGRATION_FAILING",
        title: `${failing.length} integration${failing.length === 1 ? "" : "s"} need attention`,
        body: failing
          .map((integration) => `${integration.key}: ${(integration.lastError ?? "").slice(0, 160)}`)
          .join("\n"),
        link: "/integrations",
      });
      await setSettingJson(INTEGRATION_KEY, now.toISOString());
      alerted.push("integration");
    }
  }

  const [allowance, budget] = await Promise.all([enquiryAllowanceStatus(), aiBudgetStatus()]);
  const warningKey = `${allowance.warning}:${budget.warning}`;
  const lastLimitWarning = await getSettingJson<string>(LIMIT_WARNING_KEY, "");
  if ((allowance.warning !== "NONE" || budget.warning !== "NONE") && lastLimitWarning !== warningKey) {
    await alertOwner({
      type: "OPS_LIMIT_WARNING",
      title: allowance.warning === "100" || budget.warning === "100" ? "A monthly usage limit was reached" : "A monthly usage limit is at 80%",
      body: [
        `Enquiries: ${allowance.used} of ${allowance.allowance}.`,
        `AI budget: ${budget.spentAed == null ? "rate unavailable" : `${budget.spentAed.toFixed(2)} of ${budget.budgetAed} AED`}.`,
        "Review Settings → Cost and volume limits. Sourcing and AI fall back safely; no work is silently discarded.",
      ].join("\n"),
      link: "/usage",
    });
    await setSettingJson(LIMIT_WARNING_KEY, warningKey);
    alerted.push("limits");
  }

  await setSettingJson(CHECK_KEY, now.toISOString());
  return { alerted };
}

export async function sendDailyDigest(): Promise<{ sent: boolean }> {
  const now = new Date();
  const organization = await db.organization.findUnique({ where: { id: getTenantId() ?? "" } });
  const timeZone = organization?.timezone ?? "Asia/Dubai";
  const date = localDate(timeZone, now);
  const last = await getSettingJson<string>(DIGEST_KEY, "");
  if (last === date) return { sent: false };
  if (hourIn(timeZone, now) < 7) return { sent: false };

  const [pendingApprovals, needsReview, failedJobs, awaitingSuppliers] = await Promise.all([
    db.approval.count({ where: { status: "PENDING" } }),
    db.enquiry.count({ where: { status: "NEEDS_REVIEW" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
    db.supplierQuote.count({ where: { status: { in: ["SENT", "REQUESTED"] } } }),
  ]);
  const lines = [
    `${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}`,
    `${needsReview} enquir${needsReview === 1 ? "y" : "ies"} needing review`,
    `${awaitingSuppliers} supplier request${awaitingSuppliers === 1 ? "" : "s"} waiting`,
    `${failedJobs} failed job${failedJobs === 1 ? "" : "s"}`,
  ];
  await alertOwner({
    type: "OPS_DAILY_DIGEST",
    title: "Daily procurement digest",
    body: lines.join("\n"),
    link: "/approvals",
  });
  await setSettingJson(DIGEST_KEY, date);
  return { sent: true };
}
