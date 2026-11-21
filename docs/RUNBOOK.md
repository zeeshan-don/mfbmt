# Runbook

## Deploy

1. Back up the production database and confirm the restore command works on a scratch database.
2. Set the production environment from `.env.production.example`; never commit secrets.
3. Run `npm ci`, `npx prisma migrate deploy`, `npm run check`, and `npm run check:golive`.
4. Deploy the web app and worker daemon. Confirm `/api/health` and the worker `/health` probe are 200.
5. Run a live integration diagnostic for every connected provider.
6. Send one supervised test enquiry through the real channel and approve it end to end.

## Rollback

- Application: redeploy the previous known-good build.
- Database: migrations are additive and forward-only. Do **not** reverse them blindly. Restore the pre-deploy backup only after stopping writers and recording the incident.
- Worker: stop the new worker, release leases through the normal shutdown grace period, then start the previous worker.

## Incident steps

### Worker unhealthy or queue growing
1. Check the Vercel daemon logs and `/health`.
2. Verify `WORKER_SECRET`, database reachability and migrations.
3. Restart the daemon. Jobs are claimed with `FOR UPDATE SKIP LOCKED`; a second worker is safe.
4. Inspect dead-letter jobs in Activity/Settings and retry only after the cause is fixed.
5. Confirm the daily digest and owner alerts are arriving.

### Integration rejected / token expired
1. Open Settings → connection state and read the recorded provider error.
2. Reconnect the mailbox or WhatsApp account; a key alone never marks it connected.
3. Run the live test. If it still fails, use the email path or manual channel and record the limitation.

### Suspected tenant data exposure
1. Treat it as a security incident; stop affected sessions and preserve audit logs.
2. Do not delete evidence. Identify the organization and objects involved.
3. Rotate `AUTH_SECRET`, `WORKER_SECRET`, `CRON_SECRET` and provider credentials as appropriate.
4. Follow the contractual notification process.

## Backup and restore

Use `docs/BACKUP_RESTORE.md`. Take a `pg_dump` before every migration window. Run a restore drill into a scratch database and record the date and result in STATUS.md.

## Routine checks

- Daily: worker heartbeat, failed jobs, needs-review queue, pending approvals.
- Weekly: integration tests, storage round trip, stale stock, mailbox reconnect state.
- Monthly: `/usage` export, AI/search spend, quotation outcomes, backup restore sample.
