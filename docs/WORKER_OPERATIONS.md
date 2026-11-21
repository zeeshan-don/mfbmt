# Worker operations

The worker is a separate process (`npm run worker`) that polls the database-backed job queue. Vercel hosts one instance; it must receive the same `DATABASE_URL`, storage and provider configuration as the web app.

## Health and recovery

- `WorkerHeartbeat` is written on every poll and during long jobs. A stale heartbeat means the process is not running, not that jobs are lost.
- Jobs use leases. Expired leases are reclaimed; a worker that loses its lease discards the result rather than overwriting the reclaimed job.
- Jobs are idempotent by payload/idempotency key. Inbound messages dedupe by provider message id; supplier replies dedupe by provider message id.
- Retryable failures return the job to the queue; non-retryable failures are marked FAILED with an error. Check `/activity` and the queue counters.
- Every job runs inside the organization context stored on the job; the worker never processes a job under another tenant's context.

## Safe operation

Restarting the worker is safe: queued work remains in the database, and expired leases are reclaimed. Do not run a second worker against a database you have not capacity-tested. Approvals are not bypassed by the worker: supplier RFQs and follow-ups still require owner approval, and no job sends a purchase order automatically.

## Verification

Run the concurrency and tenant-isolation Vitest files and a local load test (`docs/LOAD_TESTING.md`) after changes to queue, lease or job-handler logic. Never point a load test at production.
