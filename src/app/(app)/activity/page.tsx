import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { formatDateTime, timeAgo, truncate } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, statusTone } from "@/components/ui";
import { markNotificationsReadAction } from "@/app/actions/approvals";
import { retryJobAction } from "@/app/actions/settings";
import { Activity, CheckCircle2, ListChecks } from "lucide-react";

export const dynamic = "force-dynamic";

const JOB_LABELS: Record<string, string> = {
  INGEST_MESSAGE: "Reading an incoming message",
  EXTRACT_ENQUIRY: "Reading the requested products",
  CHECK_INVENTORY: "Checking stock",
  RUN_SOURCING: "Searching suppliers",
  SEND_SUPPLIER_RFQ: "Sending a supplier request",
  BUILD_QUOTATION: "Preparing a quotation",
};

export default async function ActivityPage() {
  const user = await requireUser();

  const [logs, jobs, notifications] = await Promise.all([
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
    db.backgroundJob.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    db.notification.findMany({
      where: user.role === "OWNER" ? {} : { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity"
        description="A permanent record of what happened, who did it and when. Staff work is visible here too."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Decision and work history" description="Audit trail — entries cannot be edited or deleted in the app." />
            {logs.length === 0 ? (
              <EmptyState
                icon={<Activity size={18} aria-hidden />}
                title="No activity yet"
                description="Approvals, supplier searches, imports and quotation changes are recorded here automatically."
              />
            ) : (
              <ul className="divide-y divide-line">
                {logs.map((log) => (
                  <li key={log.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs text-ink">
                        <span className="font-medium">{log.actorLabel}</span>{" "}
                        {log.action.replaceAll("_", " ").replaceAll(".", " · ")}
                      </p>
                      <p className="text-[11px] text-muted">
                        {log.entityType}
                        {log.entityId ? ` · ${truncate(log.entityId, 22)}` : ""} · {formatDateTime(log.createdAt)}
                      </p>
                      {Object.keys(parseJson<Record<string, unknown>>(log.metaJson, {})).length > 0 ? (
                        <p className="mt-0.5 text-[10px] text-muted">{truncate(log.metaJson, 160)}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card id="notifications">
            <CardHeader
              title="Notifications"
              action={
                notifications.some((notification) => !notification.isRead) ? (
                  <form action={markNotificationsReadAction}>
                    <Button size="sm">Mark all read</Button>
                  </form>
                ) : null
              }
            />
            {notifications.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {notifications.map((notification) => (
                  <li key={notification.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-xs ${notification.isRead ? "text-soft" : "font-medium text-ink"}`}>
                        {notification.title}
                      </p>
                      {!notification.isRead ? <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
                    </div>
                    {notification.body ? <p className="text-[11px] text-muted">{notification.body}</p> : null}
                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
                      <span>{timeAgo(notification.createdAt)}</span>
                      {notification.link ? (
                        <Link href={notification.link} className="text-accent hover:underline">Open</Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Background work" description="Processing that runs outside the page." />
            {jobs.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No background work has run yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {jobs.map((job) => (
                  <li key={job.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-ink">{JOB_LABELS[job.type] ?? job.type}</p>
                      <Badge tone={statusTone(job.status)} dot>{job.status.toLowerCase()}</Badge>
                    </div>
                    <p className="text-[11px] text-muted">
                      {timeAgo(job.createdAt)}
                      {job.progress ? ` · ${truncate(job.progress, 70)}` : ""}
                    </p>
                    {job.status === "FAILED" && job.lastError ? (
                      <p className="mt-0.5 text-[11px] text-warn">{truncate(job.lastError, 120)}</p>
                    ) : null}
                    {job.status === "FAILED" || job.status === "DEAD_LETTER" ? (
                      <form action={retryJobAction} className="mt-1.5">
                        <input type="hidden" name="jobId" value={job.id} />
                        <Button size="sm">Retry this job</Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              Jobs retry automatically. A failed job keeps its reason so it can be fixed and rerun.
            </p>
          </Card>

          <Card>
            <CardHeader title="System" />
            <ul className="space-y-2 px-4 py-3 text-[11px] text-muted">
              <li className="flex items-center gap-2"><CheckCircle2 size={12} className="text-ok" aria-hidden /> Audit log active</li>
              <li className="flex items-center gap-2"><ListChecks size={12} className="text-accent" aria-hidden /> Background jobs persistent</li>
              <li className="flex items-center gap-2"><Activity size={12} className="text-accent" aria-hidden /> Database connected</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
