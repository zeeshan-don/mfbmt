/**
 * Scheduling architecture.
 *
 *  - The long-running worker (`npm run worker`) is the primary processor. It
 *    iterates active tenants, enters each tenant's context and polls that
 *    tenant's own mailbox. It is the only routine mailbox scheduler.
 *  - QStash keeps one watchdog schedule for background jobs, so queued work is
 *    processed even if the long-running worker is briefly unavailable. The
 *    watchdog claims jobs with SKIP LOCKED and is safe to overlap.
 *  - There is deliberately NO scheduled email-sync endpoint. Tenant-scoped
 *    mailbox sync cannot be invoked from a tenant-less scheduler: doing so would
 *    run one tenant's sync with another tenant's context (or no context at all).
 */

export type QStashSchedule = {
  scheduleId: string;
  path: string;
  cron: string;
};

export const QSTASH_SCHEDULES: QStashSchedule[] = [
  {
    scheduleId: "mfbmt-process-jobs",
    path: "/api/cron/process-jobs",
    cron: "*/5 * * * *",
  },
];

export const EMAIL_SYNC_SCHEDULE_REMOVED = true;
