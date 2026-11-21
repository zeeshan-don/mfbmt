# Release report — 2026-11-19

## Classification

**MULTI-COMPANY FOUNDATION READY FOR STAGING. NOT LIVE-VERIFIED WITH PROVIDERS.**

MFBMT functionality and historical data ownership are preserved and the full local regression suite passes.
OGS exists as an independent, empty tenant with its own configuration surface. The app must not be described
as production-verified until live WhatsApp, Gmail/Microsoft, AI, search and FX credentials are connected,
each provider test succeeds, and the managed database/backups/monitoring are in place.

## 1. Architecture changes

- Added a fail-closed tenant guard. `src/lib/db.ts` scopes tenant queries in the caller's async context,
  immediately before dispatch. It deliberately does **not** use a Prisma query extension: Prisma 6 runs
  extension callbacks outside the caller's `AsyncLocalStorage`, so the first implementation silently
  fell back to MFBMT for explicit webhook/job tenants. `tests/tenant-isolation.test.ts` caught this and
  now proves both directions.
- Tenant context comes from the server-side session row or trusted evidence: WhatsApp Phone Number ID,
  Gmail mailbox address, signed Graph `clientState`, supplier response token, job row, or explicit
  `runWithTenant`. Browser-supplied organization IDs are never used for authorization.
- `db.$transaction` wraps the callback's `tx` with the same scoping rules. Global models
  (`Organization`, `WorkerHeartbeat`) and raw SQL pass through; raw code must supply the tenant itself.
- Worker claims run unscoped, then execute each job inside its own tenant context. Jobs, integration
  lookups, file access, audit entries and retries are tenant-scoped.
- Login is workspace-aware (`/login?org=<slug>`), sessions are organization-bound, suspended tenants are
  refused and their sessions are deleted. `OWNER`/`STAFF` roles remain per company. Password reset
  tokens are tenant-bound.
- WhatsApp webhooks route by receiving Phone Number ID; Gmail push routes by the connected mailbox;
  Microsoft subscriptions use `clientState = org:<organizationId>:<secret>`; inbound email forwarding
  requires `x-organization-slug`.
- PDFs, quotation numbers, tax/currency/terms, sender identity and supplier RFQ wording read the
  authenticated organization's configuration.

## 2. Database schema and migration

Migration: `prisma/migrations/20261119170000_multi_company_tenancy/migration.sql`.

- Additive and forward-only. No table is dropped, recreated or truncated.
- Every historical tenant row is backfilled to `org_mfbmt` before ownership becomes required.
- 36 tenant models carry `organizationId` with a foreign key and cascade delete.
- Global uniques became organization-scoped, including user email, integration key, enquiry reference,
  product SKU, conversation/message provider IDs, job idempotency key, quotation number, sequences and
  settings.
- `org_ogs` is provisioned empty. No MFBMT data, legal details, users, suppliers, prices or credentials
  were copied or invented.
- Database defaults use a deliberate `__unset__` sentinel; an unguarded create fails the foreign key
  instead of silently writing an unowned row.
- The migration was applied to the isolated `mfbmt_test` database and to the disposable local
  `mfbmt_e2e` database. It was **not** applied to the hosted database in `.env` during this work.

Backup and rollback: take a verified PostgreSQL backup first; rollback is restore of that backup. See
`docs/MULTITENANCY.md` and `docs/DEPLOYMENT.md`.

## 3. Files created and modified

**Created**
- `src/lib/tenant.ts` (tenant context, guard helpers, `runWithTenant`, `scopeTenantArgs`)
- `src/lib/db-base.ts` (explicit unscoped client)
- `src/lib/organization.ts`, `src/lib/email/routing.ts`
- `src/lib/catalog/industrialSpec.ts`
- `src/scripts/provision-organization.ts`
- `tests/tenant-isolation.test.ts`, `tests/industrial-spec.test.ts`
- `tests/e2e/prepare.ts`
- `docs/MULTITENANCY.md`

**Modified (principal)**
- `prisma/schema.prisma`, the tenancy migration, `src/lib/db.ts`, auth/account/integration/job/worker
  modules, WhatsApp/Gmail/Microsoft/inbound-email routes, supplier response and file download routes,
  quotation/PDF and supplier quote modules, inventory matching/checking, supplier reliability, sourcing
  adapters, settings/onboarding/dashboard copy, seed/demo/provisioning scripts.
- `tests/global-setup.ts`, `tests/e2e/seed-fixture.ts`, `playwright.config.ts`, `package.json`.
- `docs/ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `INTEGRATIONS.md`, `WHATSAPP.md`, `EMAIL.md`,
  `SUPPLIERS.md`, `DEPLOYMENT.md`, `ONBOARDING.md`, `LIMITATIONS.md`, this report.
- User-facing MFBMT copy was replaced with neutral/trading-company wording; company identity in
  documents and email is dynamic. Demo seed names remain MFBMT because they belong to the MFBMT demo
  tenant.

## 4. Organization isolation verification

`tests/tenant-isolation.test.ts` creates deliberately overlapping data in MFBMT and OGS and verifies:

- identical SKUs and emails can coexist, while each tenant sees only its own row;
- a record ID owned by the other tenant returns `null`;
- WhatsApp Phone Number IDs route to the owning company and credentials never cross;
- supplier offers and enquiries cannot be read by the other tenant;
- job idempotency keys and document number sequences are independent;
- audit entries do not leak.

The guard throws `TenantContextError` when no tenant can be established. It never falls back in
production.

## 5. MFBMT regression results

All existing fastener behaviour is intact: extraction, deterministic specification matching, approved
equivalence, inventory matching, sourcing, landed cost, supplier RFQ approval, quotation generation,
PDF privacy and authorization. **164/164 Vitest tests pass across 17 files** (up from the 148-test
baseline recorded before this work; the old docs' 142 was stale).

## 6. OGS feature results

- Independent tenant, organization configuration fields (identity, tax, currency, timezone, quotation
  prefix/validity/terms, logo, status) and workspace login.
- Configurable industrial schemas for Pipes, Valves, Flanges, Fittings, Chemicals and Industrial
  Spares, with required attributes and deterministic `EXACT` / `EQUIVALENT` / `INSUFFICIENT` /
  `NO_MATCH` comparison. Approved substitution is required for material equivalence. 10 unit tests.
- **Not yet wired:** every OGS category is not yet surfaced in the enquiry extraction UI, and the
  automated supplier-reply-to-RFQ matching path is not implemented. Existing secure supplier response
  forms and manual supplier quotation entry remain available. This is recorded as a limitation, not
  claimed as complete.

## 7. WhatsApp and email onboarding status

- **WhatsApp:** per-organization credential storage, encrypted secrets, Phone Number ID routing,
  duplicate webhook receipts, signed Embedded Signup state and failed-send reporting are implemented.
  Live Meta verification is **BLOCKED BY EXTERNAL CREDENTIALS**.
- **Gmail:** per-organization OAuth and mailbox-bound push routing implemented. **NOT LIVE-VERIFIED.**
- **Microsoft 365:** per-organization OAuth and signed `clientState` webhook routing implemented.
  Existing subscriptions must be recreated/renewed to carry the new state. **NOT LIVE-VERIFIED.**
- **Inbound forwarding:** shared-secret authentication plus mandatory workspace header/slug. Older
  forwarders without a workspace will be rejected. **NOT LIVE-VERIFIED.**

## 8. Supplier RFQ and reply handling

The owner approval gate before outreach, professional RFQ content, secure token response form, supplier
quotation comparison and landed-cost calculation are implemented and covered by existing tests. Email
sending and WhatsApp sending are tenant-scoped; real provider delivery is **NOT LIVE-VERIFIED**.
Automatic ingestion/matching of supplier email replies into the correct RFQ is **NOT IMPLEMENTED**;
the safe manual/secure-form path remains. No purchase orders or payments are created.

## 9. Security and cross-tenant testing

- Cross-tenant reads/writes, credentials, jobs, sequences and audit entries: PASS
  (`tests/tenant-isolation.test.ts`).
- Existing authorization, approval-replay, webhook idempotency, worker lease and production-safety
  tests: PASS.
- Secrets remain AES-256-GCM encrypted per organization; no secrets are logged or committed.
- Platform provisioning is a server-side CLI with no automatic customer-data access. A support-access
  workflow with explicit authorization and audit is **NOT IMPLEMENTED**.

## 10. Build and test results actually executed

| Check | Result |
|---|---|
| `npx prisma validate` | PASS |
| `npx tsc --noEmit` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors, 20 pre-existing warnings |
| `npm test` | PASS — 17 files / 164 tests |
| `npm run test:e2e` | PASS — 7 Playwright Chromium tests |
| `npm run build` | PASS — 37 routes |
| Live provider calls | NOT VERIFIED — no credentials |
| Hosted/production database migration | NOT APPLIED — deliberately untouched |

E2E now creates and seeds a disposable local `mfbmt_e2e` database on port 3100. It refuses any
non-local database or a database name without `e2e`, so it cannot accidentally touch the hosted database
configured in `.env`.

## 11. Remaining external credentials and manual configuration

- Meta app credentials, WhatsApp Business Account, Phone Number ID and access token per company.
- Google Gmail OAuth client or Microsoft Graph app registration, redirect URIs and mailbox consent.
- AI provider key, web search API key, FX provider key (optional).
- S3-compatible private bucket if not using local disk.
- Managed PostgreSQL with backups, HTTPS reverse proxy, worker supervision and monitoring.
- Apply the migration and create the OGS owner through the documented onboarding flow.

## 12. Production deployment

1. Back up the current database and verify the restore.
2. Set production `DATABASE_URL`, `APP_URL`, `AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`; keep
   `DEMO_MODE=false`, `SEED_DEMO_DATA=false`.
3. `npm ci && npx prisma migrate deploy && npm run build`.
4. Start the web process (`npm start`) and the supervised worker (`npm run worker`).
5. Terminate TLS in front; expose `/api/webhooks/*` and keep everything else authenticated.
6. `npm run provision:org` for a new tenant and `npm run provision:owner` for its first owner.
7. Connect each company's WhatsApp/email/AI/search credentials and press **Test connection**.
8. Verify `/api/health`, queue depth and worker heartbeat.
9. Do not run `db:seed` in production.

## 13. Known limitations

- No live provider verification; no hosted migration performed in this pass.
- OGS extraction-screen wiring and automatic supplier email reply matching remain open.
- No platform-administration web UI; tenant lifecycle is CLI-only.
- No support-access workflow with audited customer-data access.
- No billing/subscription implementation (out of scope; no fake billing state exists).
- No automated accessibility, penetration or load audit.
- Approvals are in-app only; the owner must sign in. The app never purchases or pays.

## Addendum — 21 November 2026 (production hardening)

Implemented private S3/R2 storage with tenant-scoped keys and fail-closed production behavior, OGS industrial extraction/matching behind `procurementProfile=INDUSTRIAL`, Gmail/Microsoft supplier-reply correlation with UNVERIFIED offer drafts and owner review, single-use owner invitations, organization-scoped integration diagnostics, and concurrency/idempotency fixes found by load testing. The two items listed under "Known limitations" as open above — OGS extraction-screen wiring and automatic supplier email reply matching — are now implemented; the original limitation list is retained as historical context.

Verification in this working tree: typecheck passed, 24 Vitest files / 206 tests passed, Playwright 7/7 passed, production build passed, and a 30-request local synthetic burst completed with 30/30 ingested and 60/60 jobs completed after the conversation-race fix. No production migration, production env change, real outbound message, owner provisioning or deployment was performed.
