# Final engineering report — production hardening and OGS procurement automation

Date: 21 November 2026  
Repository HEAD: `8c4142eaa64e16125de7c842c8f4f46482ae6290` (branch `main`)  
Working tree: uncommitted changes; no commit, push or deployment was performed.

## A. Executive summary

The hardening work is implemented and locally verified, but the system is **not yet fully production-verified**. Completed work:

- Private S3-compatible storage (Cloudflare R2 / AWS S3) with fail-closed production behavior, tenant-scoped object keys, private uploads, signed short-lived downloads, and a storage self-test/readiness signal.
- OGS industrial extraction and matching for all six categories (Pipes, Valves, Flanges, Fittings, Chemicals, Industrial Spares), gated by `Organization.procurementProfile = INDUSTRIAL` so MFBMT's fastener behavior remains unchanged.
- Gmail and Microsoft 365 supplier reply ingestion, evidence-based RFQ correlation, attachment retention, idempotency, UNVERIFIED offer drafts, and owner review.
- Single-use OGS owner invitations with hashed tokens, expiry, masked password entry, and cross-tenant email conflict checks.
- Organization-scoped, non-destructive integration diagnostics at `/integrations` and `/api/integrations/diagnostics`.
- Concurrency hardening: a 30-request synthetic burst exposed a conversation-creation race (7/30 failures); it was fixed and covered by a regression test.
- Documentation and operational guides updated; additive migration prepared but **not applied to production**.

No production migration, production environment-variable change, real supplier/customer message, real OGS owner provisioning, `main` push or `vercel --prod` deployment was performed. Live provider checks remain unverified.

## B. Files changed, grouped by feature

### Persistent storage and tenant isolation
- `src/lib/storage-config.ts` (new): driver validation, R2/AWS region rules, tenant key construction/classification.
- `src/lib/storage.ts`: fail-closed drivers, private S3 puts, tenant keys, readiness and write/read/delete self-test.
- `src/lib/env.ts`, `src/app/api/health/route.ts`, `src/app/api/files/[id]/route.ts`.
- `src/lib/workflow/enquiry.ts`: tenant-scoped attachment saving and storage readiness.
- `src/lib/workflow/quotations.ts`: tenant-scoped quotation PDF keys.
- `src/scripts/audit-attachments.ts` (new), `package.json` (`audit:attachments`).
- `.env.example`, `.env.production.example`, `docs/STORAGE.md`.

### Industrial extraction and matching
- `src/lib/catalog/industrialSpec.ts`, `src/lib/ai/extract.ts`, `src/lib/validation/extraction.ts`.
- `src/lib/workflow/enquiry.ts`, `src/lib/workflow/itemEdit.ts`.
- `src/lib/inventory/check.ts`, `src/lib/inventory/matching.ts`, `src/lib/sourcing/engine.ts`.
- `src/app/(app)/enquiries/[id]/page.tsx`, `src/app/actions/enquiries.ts`.
- `prisma/schema.prisma`, additive migration, `docs/INDUSTRIAL_SPECS.md`.

### Supplier email replies
- `src/lib/workflow/supplierReply.ts` (new correlation, extraction and offer-draft pipeline).
- `src/lib/email/sync.ts`, `src/lib/email/send.ts`, `src/lib/workflow/supplierQuotes.ts`.
- `src/app/(app)/suppliers/replies/page.tsx`, `src/app/actions/supplierReplies.ts`.
- `prisma/schema.prisma`, additive migration, `docs/SUPPLIER_EMAIL_INGESTION.md`.

### Owner onboarding
- `src/lib/onboarding/invite.ts` (new), `src/scripts/provision-owner.ts`.
- `src/app/accept-invite/page.tsx`, `src/app/actions/invite.ts`.
- `prisma/schema.prisma`, additive migration, `docs/ONBOARDING.md`.

### Diagnostics and UI
- `src/lib/integrations/diagnostics.ts`, `src/app/api/integrations/diagnostics/route.ts`.
- `src/app/(app)/integrations/page.tsx`, `src/app/actions/diagnostics.ts`, `src/components/nav.tsx`.
- `docs/INTEGRATION_DIAGNOSTICS.md`.

### Reliability, tests and docs
- `tests/concurrent-intake.test.ts` (new), `src/scripts/load-test.ts` (new), `src/lib/workflow/enquiry.ts` race fix.
- New test files: `storage-hardening`, `industrial-extraction`, `supplier-reply-correlation`, `supplier-email-ingest`, `onboarding-invite`, `integration-diagnostics`, `concurrent-intake`.
- Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/MULTITENANCY.md`, `docs/ONBOARDING.md`, `docs/EMAIL.md`, `docs/WHATSAPP.md`, `docs/SUPPLIERS.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/LIMITATIONS.md`, `docs/RELEASE_REPORT.md`, `docs/PRODUCTION_MIGRATION_AUDIT.md`, `docs/LOAD_TESTING.md`, `docs/PRODUCTION_RELEASE_CHECKLIST.md`, `docs/WORKER_OPERATIONS.md`, `docs/BACKUP_RESTORE.md`.

## C. Database changes

Migration: `prisma/migrations/20261121120000_ogs_procurement_hardening/migration.sql`.

Additive changes only:

- `Organization.procurementProfile` (`GENERAL` default; `INDUSTRIAL` enables OGS schemas).
- `EnquiryItem.industrialSpecJson`, `Product.industrialSpecJson`.
- `SupplierQuote.correlationToken`, `providerThreadId`, `providerMessageId` and a unique index on the token.
- `SupplierEmailReply` table with organization/provider/message idempotency, correlation headers, extraction/review state and timestamps.
- `Attachment.supplierReplyId` with index and foreign key.
- `OwnerInvitation` table with hashed token, expiry and single-use timestamp.

No column, table or row is dropped or rewritten. No existing migration was edited. No production migration was applied. The migration was applied only to isolated local `mfbmt_test` and `mfbmt_e2e` databases for verification; load tests created synthetic rows in the local test database. Production schema and data were untouched.

## D. Storage

Supported drivers: `local` and `s3` (R2, AWS S3 and compatible providers). Production defaults to `s3` in the example configuration; local disk is refused in production unless `STORAGE_ALLOW_LOCAL_VOLUME=true` explicitly acknowledges a persistent volume.

New attachment keys: `organizations/{organizationId}/attachments/{yyyy-mm}/{random}`. Quotation PDFs: `organizations/{organizationId}/quotations/{quote}-v{version}.pdf`. Keys are derived from server-side tenant context; traversal and unsafe extensions are validated. Legacy `attachments/...` keys remain readable only after database ownership verification and are not rewritten.

Security: buckets remain private; no public ACL is sent; AWS puts request server-side encryption; MIME is detected from content; server-side size limits remain; filenames are sanitized; signed downloads are short-lived; storage errors do not expose credentials. The storage self-test performs write/read/delete and never exposes secrets. Health reports storage readiness separately and file operations fail closed when storage is unavailable.

Tests: 12 storage-hardening tests cover tenant keys, cross-tenant ownership, legacy keys, driver rules and validation. The production attachment inventory/count was **not measured** (no production access); run `npm run audit:attachments` under authorization before migration.

Manual configuration still required: create a private bucket and supply `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (and `STORAGE_DRIVER=s3`) to both web and worker. No S3 credentials were configured or live-tested in this work.

## E. Industrial extraction

All six OGS categories are connected to the real extraction path:

| Category | Schema | Enquiry extraction/persistence | Matching |
| --- | --- | --- | --- |
| Pipes | yes | yes | yes |
| Valves | yes | yes | yes |
| Flanges | yes | yes | yes |
| Fittings | yes | yes | yes |
| Chemicals | yes | yes | yes |
| Industrial Spares | yes | yes | yes |

The AI interprets source text/documents; deterministic validation decides whether required attributes are present. Missing critical specifications are stored as uncertain and generate clarification questions. The comparator distinguishes exact, equivalent, insufficient-information and non-match outcomes; missing required attributes prevent an exact result. Unit normalization and conflicting grades/standards are handled. MFBMT remains on its existing fastener specification engine because its `procurementProfile` is `GENERAL`.

Tests: `industrial-extraction` (9), `industrial-spec` (10), `matching` (11), plus existing `fasteners` (22) and `fastener-inventory` (4) confirming no fastener regression.

## F. Supplier replies

Gmail and Microsoft 365 synchronization now ingests supplier replies. Correlation order is:

1. Exact provider message/thread identifiers.
2. `In-Reply-To` / `References`.
3. Stored opaque `RFQ-` correlation token.
4. Sender identity against the intended supplier.
5. Additional contextual evidence.

Subject similarity alone never attaches a reply. Ambiguous replies become `NEEDS_REVIEW` with possible matches at `/suppliers/replies`; unmatched supplier mail is retained. Accepted PDF/Excel/CSV/data-sheet attachments are stored privately under tenant-scoped keys and linked to the supplier reply and matched enquiry. Extracted offers are created as UNVERIFIED and require owner review; unknown shipping, tax or other charges remain null and are never treated as zero. Provider message id uniqueness prevents duplicate offers on repeated synchronization.

Tests: `supplier-reply-correlation` (10), `supplier-email-ingest` (4), and existing supplier-document E2E coverage (9). Gmail/Microsoft live delivery and attachment parsing against real provider mail were **not** tested.

## G. OGS onboarding

Secure invitation flow implemented:

- High-entropy single-use token; only SHA-256 hash stored.
- 72-hour expiry; token is never printed, emailed automatically, or recoverable later.
- Invite URL written to a `0600` file (default `owner-invite-ogs.txt`) for approved handoff.
- Invitee sets their own password at `/accept-invite`.
- Masked interactive password prompt; password is never accepted from command-line arguments or `OWNER_PASSWORD`; file-based password mode requires `0600`.
- Explicit `ORG_SLUG` and matching `CONFIRM_ORGANIZATION`; organization must exist and be ACTIVE.
- Refuses to reset an existing owner by default; refuses an email already used in another tenant (including MFBMT). No global MFBMT owner is touched.
- Successful invitation creation/acceptance writes an audit record.

Exact command (not executed for the real owner):

```bash
ORG_SLUG=ogs \
CONFIRM_ORGANIZATION=ogs \
OWNER_EMAIL='<approved-ogs-owner-email>' \
OWNER_NAME='<approved-ogs-owner-name>' \
npm run provision:owner:invite
```

## H. Integrations status

| Provider | Implemented | Configured in this work | Authenticated / live-tested |
| --- | --- | --- | --- |
| WhatsApp Business / Meta | yes | not verified | no; no message sent |
| Gmail OAuth | yes | not verified | no |
| Microsoft 365 / Graph | yes | not verified | no |
| AI provider | yes | not verified | no (minimal diagnostic exists) |
| Web search | yes | not verified | no |
| Exchange rate | yes | not verified | no |
| OCR | yes | not verified | no |
| S3-compatible storage | yes | local test driver only | S3 not configured/live-tested |

Diagnostics are owner-only, tenant-scoped and non-destructive. They report `NOT_CONFIGURED` or `NOT_VERIFIED` honestly; stored credentials alone are never reported as CONNECTED. No provider secret is returned or displayed. No real WhatsApp message, email, supplier RFQ, follow-up, purchase order or customer quotation was sent.

## I. Test results

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0; 0 errors, 24 warnings |
| `npm test` | 24 files passed, 206/206 tests passed (95.44s) |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` | 7/7 Playwright tests passed (1.7m), isolated `mfbmt_e2e` |
| `npm run build` | exit 0 |
| Local synthetic load | 30/30 ingested; 60/60 jobs completed; 0 failed |

New regression coverage includes tenant-scoped storage, industrial extraction, supplier correlation/ingestion, invitation conflicts, diagnostics isolation, and concurrent same-sender intake. No test assertion was weakened.

## J. Load-test results

Executed against isolated local `mfbmt_test` with all external providers mocked/disabled, one worker, 30 unique synthetic RFQs mixing WhatsApp-like and email-like intake across all six categories:

- Ingest latency: p50 214.2 ms, p95 261 ms, max 270 ms.
- 30/30 ingested, 0 failures.
- 60/60 jobs completed, 0 failed, 0 queued/processing.
- Worker wall time: 1,535 ms; queue wait/completion percentiles rounded to 0 ms at this volume.
- No external request was made.

The first run exposed a real race in conversation creation and failed 7/30 ingests. The race was fixed with an atomic constraint plus unique-violation fallback and is covered by `tests/concurrent-intake.test.ts`; the clean rerun produced the figures above.

Limitations: local machine-specific timings, one worker, no 300-request headroom run, no attachment-processing workload, and no production capacity claim. The 30-enquiry workload is functional/concurrency evidence only.

## K. Remaining blockers

1. **Production migration authorization** — backup and separately authorized `prisma migrate deploy` are still required; the migration is not applied.
2. **Storage configuration** — private S3/R2 bucket and credentials, set for both web and worker; verify storage diagnostics and run the attachment audit.
3. **OGS owner details and authorization** — approved owner email/name and explicit permission to create the real invitation; no owner was provisioned.
4. **Provider credentials/dashboard actions** — Meta/WhatsApp, Google OAuth, Microsoft OAuth, AI, web search and exchange-rate checks; these remain NOT_VERIFIED.
5. **Real-message approvals** — supplier RFQ, follow-up, purchase order and customer quotation sends were deliberately not performed.
6. **Production deployment** — no push to `main`, no `vercel --prod`, no production env changes.
7. **Extended load coverage** — 300-request headroom and attachment-failure workload were not executed.
8. **Production attachment inventory** — count and legacy-key accessibility were not measured without production access.

## L. Deployment plan

1. Take a verified Neon backup/PITR checkpoint and enable object-storage versioning.
2. Create a private bucket. Configure both web and worker with:
   - `STORAGE_DRIVER=s3`
   - `S3_ENDPOINT` (R2 only; omit for AWS S3)
   - `S3_REGION` (`auto` for R2; the real region for AWS)
   - `S3_BUCKET`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `S3_FORCE_PATH_STYLE` (`true` for R2 typically, `false` for AWS)
   - `STORAGE_ALLOW_LOCAL_VOLUME=false`
3. Confirm `/api/health` reports storage ready, then run an owner storage diagnostic and `npm run audit:attachments`.
4. In a separately authorized deployment, apply `20261121120000_ogs_procurement_hardening` to production after the backup, then deploy the app and worker with the same storage configuration.
5. Verify worker heartbeat, queue depth, `/activity`, and a synthetic non-messaging job.
6. Provision the OGS owner only after receiving approved details, using the invitation command above; deliver the 0600 invite file through an approved channel and delete it after acceptance.
7. Run `/integrations` live checks after provider credentials are configured. Do not send real supplier/customer messages without the existing explicit approval gates.
8. Keep `npm run db:seed` out of production.

**Conclusion:** implementation is complete for the requested code paths and passes all local verification available without production credentials. Controlled OGS onboarding still requires the production migration, storage credentials, owner details, and live provider authorization. Do not represent the deployment as fully production-verified until those checks pass.
