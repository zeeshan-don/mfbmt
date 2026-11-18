# Implementation audit — production hardening pass

Date: 2026-11-18. This is the baseline that was verified against the repository and a local
PostgreSQL 14+ instance, not against README claims. It is kept as a record of what changed and why.

## Verified starting point

- Prisma datasource is **PostgreSQL** (`prisma/schema.prisma`, `prisma/migrations/20261117191151_init_postgres`).
  The `prisma/migrations-sqlite-legacy` folder is history only and is not part of the active migration
  path. Documentation claiming SQLite was stale and has been corrected.
- The isolated test database (`mfbmt_test`) migrates and the suite passed before changes:
  **9 files / 98 tests**.
- Demo data is guarded in `src/scripts/seed.ts`, but the guard failed **open** when both flags were
  unset (it only rejected the literal string `"false"`). The script also reset supplier catalogue rows
  and reset stock quantities on every run.
- `BackgroundJob` states are `QUEUED | PROCESSING | COMPLETED | FAILED | CANCELLED`. Onboarding checked
  `PENDING | RUNNING | RETRYING`, which never matched, so the counts were always zero.
- Worker liveness was inferred from `BackgroundJob.heartbeatAt`, which `completeJob()` clears. A healthy
  idle worker therefore looked dead, and a queue with zero failures was treated as a running worker.
- `src/app/(app)/layout.tsx` always rendered a green “System running” dot.
- `releaseExpiredJobs()` used a hard-coded attempt limit of 4 and a hard-coded 10-minute fallback, while
  `failJob()` read then wrote without a compare-and-set. A worker whose lease expired could overwrite a
  job reclaimed by another worker.
- `enqueueJob()` swallowed every error and then looked the key up, which could mask connection failures.
- `/enquiries` empty state linked to `/settings/integrations`, a route that does not exist.
- `AUTH_SESSION_DAYS` was validated but unused (hard-coded 7 days). `MAX_UPLOAD_MB` advertised 15 MB while
  the Server Action limit was 12 MB.
- The industrial fastener category used only generic `size/material/grade` text matching. Pitch, thread
  system, length, head/drive, property class, finish, exact standard and certification were not represented,
  so an M10 × 1.5 × 30 bolt could be compared only by a coarse size token.

## Fixed in this pass

1. Fastener specification: typed, validated model stored on enquiry lines/products/offers; deterministic
   matching that returns `NO_MATCH` for any critical conflict and `INSUFFICIENT` for any unstated required
   attribute. Generic categories keep the previous matcher.
2. Queue: atomic claim/complete/fail, per-job attempt limits, lease-aware reclamation, duplicate detection
   limited to the actual unique violation.
3. Worker: durable `WorkerHeartbeat` registry; health and the app shell report verified/stale/unknown.
4. Demo safety: explicit opt-in required (`DEMO_MODE=true` **and** `SEED_DEMO_DATA=true`), production always
   rejected, idempotent inserts that never reset stock or owner edits.
5. Navigation/roles: verified destinations only, owner-only items hidden from staff, mobile menu includes
   profile/logout.
6. Configuration: session expiry honours `AUTH_SESSION_DAYS`; upload cap is a single 12 MB value shared by
   the Server Action limit, the storage validator and `.env.example`.

## Not verifiable in this environment

- No live Meta/WhatsApp, Gmail/Microsoft 365, AI provider, web-search or FX credentials were available.
  Those paths are exercised only through their unconfigured/error handlers and mocks.
- Browser-driven screenshots/end-to-end UI runs were not performed; route integrity is checked
  statically and by server-rendered tests where possible.
- Only local PostgreSQL was used. Production-like managed PostgreSQL (with connection pooling) was not
  available.
