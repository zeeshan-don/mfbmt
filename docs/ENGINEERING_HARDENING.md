# Engineering hardening — 22 November 2026

This document records the implemented architecture and the evidence produced in
this tree. It distinguishes verified behaviour from external services that could
not be exercised without credentials. Nothing here was tested against production
data, and no production migration or deployment was performed.

## 1. Units and packaging

Files: `src/lib/catalog/units.ts`, `src/lib/catalog/packaging.ts`,
`prisma/schema.prisma` (`ProductPackaging`).

- Fixed dimensions: length (base m), mass (kg), volume (l), area (m²).
- Atomic counts only: `pcs`, `pc`, `piece(s)`, `each`, `ea`.
- Packaging/grouping units (`box`, `pair`, `set`, `roll`, `coil`, `bundle`,
  `carton`, `drum`, `bag`, `pack`, `pallet`, `lot`, `length`) have **no built-in
  factor**. They convert only through an explicit `ProductPackaging` row, e.g.
  `1 box = 20 pcs`. An unconfigured product stays unknown.
- Validation rejects zero/negative/NaN/infinite factors, unknown units,
  duplicate factors for one unit, cycles and incomplete chains.
- No rounding is applied to converted quantities.
- `tests/units.test.ts` covers valid conversions, unsupported packaging,
  incompatible dimensions, decimals, precision, configured chains, invalid
  configuration and product-specific roll/drum factors.

## 2. Inventory reservation lifecycle

Files: `src/lib/inventory/reservations.ts`,
`src/lib/workflow/approvals.ts`, `prisma/schema.prisma`
(`StockReservation`).

States: `ACTIVE` (temporary hold) → `RELEASED` / `EXPIRED` / `COMMITTED`.
`COMMITTED` exists to distinguish an accepted commitment, but no purchase order
is created by this application.

- Reservation rows are linked to the quotation, quotation line, enquiry item and
  product, and carry a per-line idempotency key.
- Stock is aggregated across every eligible location of the **same tenant**;
  rows are locked with `SELECT … FOR UPDATE` before allocation.
- The approval claim, reservation and quotation status update commit together.
  Insufficient stock throws and rolls the approval claim back.
- An owner override requires a recorded reason, creates an audit entry, and does
  not invent reserved units for the uncovered quantity.
- Rejection releases active holds. A second release is a no-op. Expired holds
  are released by `expireStaleReservations()`.
- Expiry policy: 7 days from creation by default.
- `tests/reservations.test.ts` exercises real PostgreSQL concurrency (two
  quotations racing for the same stock), aggregation, idempotency, release
  safety, expiry, approval blocking/override and cross-tenant isolation.

## 3. Outbound message ledger

Files: `src/lib/outbound/messages.ts`, `src/lib/workflow/supplierQuotes.ts`,
`src/lib/workflow/quotations.ts`, `src/lib/email/send.ts`,
`src/lib/intake/whatsapp.ts`.

The guarantee is **at-most-one automatic transmission**, not exactly-once
delivery (providers do not offer that).

- Unique key: `(organizationId, operationKey)`.
- `claimOutbound()` inserts the row and conditionally moves it to `SENDING` with
  a lease and claim token. Only the successful claim calls the provider.
- `SENT` records provider message/thread ids when returned.
- `FAILED_SAFE` means the provider definitely did not accept the message; it may
  be retried after backoff, up to `maxAttempts`.
- `UNKNOWN` means the outcome is ambiguous (timeout, network error, 5xx). It is
  **never retried automatically** and requires `reconcileOutbound()` by an
  operator/human.
- A stale `SENDING` lease becomes `UNKNOWN`; a crashed worker cannot cause a
  blind resend.
- Email: 4xx and validation errors are safe; 5xx/408 and network failures are
  uncertain. WhatsApp: HTTP 4xx/outside-window are safe; 5xx/timeouts are
  uncertain. A failed-but-safe WhatsApp document upload may fall back to a text
  message; an uncertain document outcome never falls back.
- Supplier RFQs, supplier reminders, customer quotations and approval
  notification emails/WhatsApp alerts all use this ledger. A reminder also
  requires its own `SUPPLIER_REMINDER` approval row; the scheduled ops check
  only creates that pending approval.
- `tests/outbound.test.ts` races eight workers for one message, verifies one
  provider call, blocks unknown/stale outcomes, retries only safe failures after
  backoff, reconciles, and proves tenant-scoped key isolation.

## 4. Scheduling architecture

Files: `src/lib/scheduling.ts`, `src/scripts/setup-qstash.ts`,
`src/worker.ts`, `src/app/api/cron/*`.

- The long-running worker is the primary processor.
- Once per minute it iterates active tenants and enters `runWithTenant(...)`
  before planning/polling that tenant's mailbox.
- QStash has **one** schedule: `/api/cron/process-jobs` every 5 minutes. It is a
  signed watchdog and claims jobs safely with `SKIP LOCKED`.
- The former `/api/cron/email-sync` QStash schedule was removed. The route now
  requires `?organization=<slug>` or `?organizationId=<id>` (or the same fields
  in a POST JSON body) and runs inside that explicit tenant. Without a tenant it
  returns HTTP 400. Routine mailbox sync must not be called from a tenant-less
  scheduler.
- No Vercel cron is used, so the Hobby plan is not asked for unsupported
  frequent schedules.

## 5. Operator onboarding

Files: `src/lib/onboarding/provision.ts`, `src/scripts/operator.ts`.

```bash
npm run operator -- create-org \
  --name "OGS & Chemicals FZC" --slug ogs \
  --owner-email owner@example.com --owner-name "OGS Owner"
```

- The organization and a one-time `OwnerInvitation` are created in one
  transaction. The owner account is created later by `acceptOwnerInvitation`.
- No password argument/env var is accepted by `create-org`; a password-looking
  argument is rejected before any write.
- Only the token hash is stored. The invitation URL is printed once and is not
  recoverable from the database.
- Duplicate slugs and emails already used in another workspace are refused with
  no partial organization left behind.
- `suspend-org`, `reactivate-org` and `export-usage` remain available.
- `tests/operator-onboarding.test.ts` covers success, single-use acceptance,
  duplicate slug, cross-tenant email rollback and invalid input.

## 6. Database migration

`20261122120000_engineering_hardening` is additive:

- `ProductPackaging`
- `StockReservation`
- `OutboundMessage`

It creates three tables, their indexes and foreign keys. It does not drop or
rewrite existing tables or rows. It was applied to an isolated Docker PostgreSQL
16 database via a full `prisma migrate reset --skip-seed`, not to production.

## 7. Verification actually run

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — 0 errors |
| `npm test` | PASS — 42 files, 284/284 tests |
| `npm run build` | PASS |
| `npm run lint` | PASS — 0 errors, 25 warnings (pre-existing) |
| Focused hardening suites | PASS — 27/27 |
| PostgreSQL migration on isolated DB | PASS |
| `npm run stress` (isolated PostgreSQL) | PASS — measured below |
| `npm run test:e2e` (Chrome, desktop + mobile) | PASS — 14/14 against isolated `mfbmt_e2e` |

Measured concurrency harness (`npm run stress`, Node 24.18, Windows, Docker
PostgreSQL 16, isolated `mfbmt_test`):

- 30 concurrent independent quotation reservations: **30/30** succeeded in
  **189 ms** (~159/s); 0 failed.
- Contended stock: 10 concurrent quotations requesting 2 units each against 10
  available → **5 succeeded, 5 rejected as insufficient**, final reserved units
  **exactly 10** in 72 ms.
- Queue: **300/300** jobs enqueued and completed by 4 workers; enqueue 1,583 ms,
  claim+complete 841 ms; no duplicates or leftovers.
- Outbound: 60 messages with **120 concurrent duplicate attempts** → **60
  provider calls, 0 duplicate calls, 60 SENT rows** in 142 ms.
- Uncertain outcomes: 5 simulated provider timeouts → 5 provider calls and
  **5/5 automatic retries blocked** (reconciliation required).

Not run in this pass:

- A sustained 60/hour full RFQ pipeline with attachments. The harness measures
  the concurrency-critical paths, not end-to-end throughput; no production
  capacity guarantee is claimed.
- Any live provider call (Meta, Gmail, Microsoft Graph, AI, search, FX, S3/R2).

## 8. Final release-candidate hardening (22 November 2026)

Additional defects found and fixed during the final audit:

- Outbound reconciliation now accepts only `UNKNOWN`. A live `SENDING` claim is
  never reconciled; `recoverStaleOutboundClaims()` must sweep it to `UNKNOWN`
  first. `runNextJob()` calls that sweep before claiming work, so both the
  worker and the QStash watchdog expose stale claims.
- Human "provider confirmed not sent" now resets `attempts` to 0 and records an
  `outbound.reconciled_not_sent` audit entry, so an exhausted message can be
  retried.
- Provider IDs are preserved during reconciliation and the message is tenant
  scoped.
- Owner-only `/observability` lists `UNKNOWN` messages and requires a
  mandatory audit note before reconciliation. Staff are denied by `requireOwner`.
- A concurrent repeat reservation for the same quotation is now idempotent after
  the stock lock instead of reporting false insufficient stock.
- A `RELEASED` or `EXPIRED` reservation is atomically reopened on re-approval
  and stock is reserved again.
- Unit conversion rejects non-finite (`Infinity`) results. Packaging
  configuration can no longer redefine a fixed unit such as `m`.
- DOCX parsing checks declared uncompressed sizes and per-entry limits before
  inflation; ZIP parsing checks declared per-entry size, total size, entry count,
  nesting and traversal.
- Maintenance scripts refuse non-local or non-test/attack/e2e/stress/restore/
  backup databases through `src/scripts/safety.ts`.
- `backup-db.ts` is guarded; `restore-db.ts` was added. `attack-fixtures.ts`
  provides synthetic tenant-only fixtures and race checks.
- The Playwright fixture's stock line is now explicitly a sourced line, not a
  product bypass.
- Tests: units 14, reservations 9, outbound 10. Full suite 42 files / 297 tests.
- Backup/restore drill passed on isolated PostgreSQL 16: 11 table counts matched.
  The dump contained 0 attachments, so attachment availability after restore was
  not proven; a database dump never includes S3/R2 objects.
- Attack race passed: 1 created + 1 duplicate, exactly 4 units reserved.

## 9. Remaining known gaps

- Legacy `.xls`, `.xlsb` and `.doc` parsing. Their content is not guessed; users
  are told to re-save as `.xlsx`, `.docx` or PDF.
- WhatsApp approved-template management (name, language, variable mapping) and
  template sending outside the 24-hour window are not implemented. Free-form
  sends fail visibly with the service-window reason.
- Live OAuth expiry/reconnect notifications are surfaced through integration
  status and sync errors, but no separate reconnect email campaign is claimed.
- The optional second AI extraction pass is still not implemented.
- Sustained end-to-end throughput is not measured. The targeted reservation,
  queue and outbound concurrency harness is implemented and has been executed
  once on an isolated database. Browser flows pass 14/14 but are functional
  checks, not load tests.
- All external integrations still require live credential verification.

## 10. External setup still required

- PostgreSQL production URL, migrations and a production backup/restore drill.
- Private S3-compatible bucket and credentials (or explicit self-hosted volume).
- Meta WhatsApp app/business verification, number and approved templates.
- Google OAuth and/or Microsoft app registration with mailbox consent.
- AI, web-search and FX provider accounts and keys.
- Vercel project, QStash token/signing keys and `APP_URL`.
- Real inventory, suppliers, letterhead, terms and approval users from OGS.

- Legacy `.xls`, `.xlsb` and `.doc` parsing. Their content is not guessed; users
  are told to re-save as `.xlsx`, `.docx` or PDF.
- WhatsApp approved-template management (name, language, variable mapping) and
  template sending outside the 24-hour window are not implemented. Free-form
  sends fail visibly with the service-window reason.
- Live OAuth expiry/reconnect notifications are surfaced through integration
  status and sync errors, but no separate reconnect email campaign is claimed.
- The optional second AI extraction pass is still not implemented.
- Sustained end-to-end throughput is not measured. The targeted reservation,
  queue and outbound concurrency harness is implemented and has been executed
  once on an isolated database. Browser flows pass 14/14 but are functional
  checks, not load tests.
- All external integrations still require live credential verification.

## 9. External setup still required

- PostgreSQL production URL, migrations and a backup/restore drill.
- Private S3-compatible bucket and credentials (or explicit self-hosted volume).
- Meta WhatsApp app/business verification, number and approved templates.
- Google OAuth and/or Microsoft app registration with mailbox consent.
- AI, web-search and FX provider accounts and keys.
- Vercel project, QStash token/signing keys and `APP_URL`.
- Real inventory, suppliers, letterhead, terms and approval users from OGS.
