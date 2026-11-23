# STATUS — OGS production readiness

Last updated: 22 November 2026 (engineering hardening)
Working tree: critical-defect fixes and regression suites. No production env, database, credentials or deployment was touched.

## Engineering hardening — 22 November 2026

This section supersedes older rows below for units, reservations, outbound sends, scheduling and operator onboarding.

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS** — 0 errors |
| `npm test` | **PASS** — 42 files, **297/297 tests** |
| `npm run build` | **PASS** — production build compiled |
| `npm run lint` | **PASS** — 0 errors, 27 warnings (pre-existing) |
| Focused hardening tests | **39/39** — units 14, reservations 9, outbound 10, onboarding 4, scheduler 2 |
| PostgreSQL | Isolated Docker PostgreSQL 16 (`mfbmt_test`); migration `20261122120000_engineering_hardening` applied by full reset + deploy |
| Live providers | **NOT VERIFIED** — no Meta/Gmail/Microsoft/AI/search/FX credentials used |
| `npm run stress` (isolated PostgreSQL) | **PASS** — 30/30 concurrent reservations in 189 ms; 10-way contention 5 success/5 insufficient with exactly 10 units reserved; 300/300 jobs drained by 4 workers in 841 ms; 60 messages with 120 duplicate attempts → 60 provider calls, 0 duplicates; 5/5 simulated timeouts blocked from automatic retry |
| `npm run test:e2e` (Chrome, desktop + mobile) | **PASS** — 14/14 against isolated `mfbmt_e2e`; full approval/quotation/PDF flow, role guards, direct server-action denial, mobile layout and PDF cost-leak checks |
| `npm run check:config` | **PASS** — no missing required variables reported; **not** provider proof |
| Backup/restore drill | **PASS** — isolated `mfbmt_test` dump restored into `mfbmt_restore`; 11 table counts matched (Organization 2, User 1, Product 1, InventoryStock 1, Supplier 0, CustomerQuotation 0, StockReservation 4, AuditLog 3, Attachment 0, BackgroundJob 20, OutboundMessage 32) |
| `npm run attack:seed` / `attack:race` | **PASS** — synthetic attack-mfbmt/attack-ogs; race produced 1 created + 1 duplicate, exactly 4 reserved |

### Final RC audit — additional defects found and fixed

1. Reconciliation accepted a live `SENDING` claim, which could race an in-flight provider call. It now accepts only `UNKNOWN`; stale leases must first be swept.
2. A human “provider confirmed not sent” decision left an exhausted message above `maxAttempts`, so it could never retry. `NOT_SENT` now resets attempts to 0 and records an audit entry.
3. Stale `SENDING` outbound claims were not swept automatically. `runNextJob()` now calls `recoverStaleOutboundClaims()` for both the worker and the QStash watchdog.
4. There was no operator UI for uncertain messages. Added owner-only `/observability` visibility and a mandatory-note reconciliation form backed by a server action.
5. A concurrent repeat reservation for the same quotation could report “insufficient stock” when the line already owned an `ACTIVE` reservation and stock was exact. It is now idempotent after the stock lock.
6. A `RELEASED`/`EXPIRED` reservation could not be reopened after re-approval, leaving a re-approved quotation without stock. The old row is now conditionally reopened and stock is reserved again.
7. Unit conversion could overflow to `Infinity`; non-finite results now return null. Packaging configuration can no longer redefine a fixed unit such as `m`.
8. DOCX/ZIP parsing now checks declared uncompressed size and per-entry limits before inflation, in addition to entry-count, nesting and traversal guards.
9. Backup had no isolation guard and there was no restore script. Added `safety.ts`, guarded `backup-db.ts`, `restore-db.ts`, and a synthetic attack toolkit.
10. The Playwright fixture cloned a stock line without a matched product; the reservation gate correctly blocked it. The fixture is now explicitly a sourced line (not a product bypass).

Five critical defects fixed:

1. **Units** — `box`, `pair`, `set`, `roll`, `coil`, `bundle`, `carton`, `drum`, `bag` no longer convert to one piece/metre/litre. Only fixed physical units and atomic counts convert; packaging needs an explicit per-product `ProductPackaging` factor. Unknown/ambiguous/incompatible conversions return null. No rounding.
2. **Reservations** — durable `StockReservation` rows are created in the same transaction as quotation approval, aggregate eligible locations under `FOR UPDATE`, never over-reserve, are idempotent per quotation line, release once, expire after 7 days and record an audited owner override for insufficient stock. A failed reservation rolls the approval claim back. A hold is not a purchase order.
3. **Duplicate external sends** — durable `OutboundMessage` ledger with unique operation keys, atomic pre-send claims, SENDING/SENT/FAILED_SAFE/UNKNOWN/CANCELLED states, provider ids, safe retry only, stale-claim recovery and explicit reconciliation. Supplier RFQs, reminders and customer quotations use it. Supplier reminders now require their own human approval; the scheduler only raises the approval.
4. **QStash/email sync** — the tenant-less email-sync QStash schedule was removed. The worker polls each active tenant inside `runWithTenant`. `/api/cron/email-sync` remains manual/diagnostic and **requires** an explicit organization; it returns 400 otherwise. `/api/cron/process-jobs` remains the signed watchdog.
5. **Operator onboarding** — `create-org` now provisions the organization and a one-time owner invitation in one transaction, reuses the invitation acceptance flow, refuses passwords on the command line, prevents duplicate slugs/emails and leaves no partial organization on failure.

Known gaps are recorded in `docs/ENGINEERING_HARDENING.md`, `docs/LIMITATIONS.md` and `docs/INTEGRATION_READINESS.md`. They include legacy `.xls/.xlsb/.doc` parsing, live WhatsApp template management, live provider verification, and a sustained full-RFQ-pipeline load run. The targeted concurrency harness has been executed; its numbers are not a production capacity guarantee. The restored dump contains 0 attachments, so attachment availability after restore was not proven; a database dump never includes S3/R2 objects. Use `docs/ATTACK_TESTING.md` for the reproducible manual matrix.

## Baseline verification (Phase 0)

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — typecheck, Vitest and production build |
| `tsc --noEmit` | 0 errors |
| `npm test` | 24 files, **206/206 tests passed** |
| `npm run build` | Compiled successfully (37 routes) |
| Lint (previous run in this tree) | 0 errors, 24 warnings |
| Playwright (previous run in this tree) | 7/7 passed against isolated `mfbmt_e2e` |
| Live providers | **NOT VERIFIED** — no credentials used |

The baseline check was run before behavior changes. `npm run check` does not include lint, Playwright or load tests; those are run separately.

## Doc/code disagreements found

1. **`vercel.json` vs cron routes** — RESOLVED: Vercel crons removed (Hobby plan). Scheduling moved to Upstash QStash via `npm run setup:qstash` (every 5 minutes). Endpoints accept QStash signatures or legacy bearer tokens. Daemon worker remains the primary continuous processor; QStash is a watchdog/fallback.
2. **Worker health** — `src/worker.ts` has durable heartbeats and SIGTERM/SIGINT flags, but no HTTP health server and no `livenessProbe`; it also cannot release a claimed job while blocking inside a handler.
3. **OCR packaging** — `Dockerfile.worker` does not bake Tesseract language data. `docs/INTEGRATIONS.md` correctly says language data is downloaded first use, which is unsafe on ephemeral Vercel storage.
4. **Deployment/storage docs** — `docs/DEPLOYMENT.md` and the storage section of `docs/INTEGRATIONS.md` still describe a writable local disk/`STORAGE_ROOT` as the normal deployment. Code now requires S3 in production unless `STORAGE_ALLOW_LOCAL_VOLUME=true`.
5. **README provisioning** — the setup example still shows `MBFMT_OWNER_*` and a password in the environment. The implemented flow is explicit `ORG_SLUG`/`CONFIRM_ORGANIZATION` plus a one-time invitation, and passwords are refused from the environment.
6. **RELEASE_REPORT stale status** — its main body says OGS extraction-screen wiring and automatic supplier-reply matching are not implemented; the 21 Nov addendum and code show both implemented. Current test count is 206, not 164.
7. **MULTITENANCY stale status** — it says OGS category wiring is pending; the industrial flow is now wired behind `procurementProfile=INDUSTRIAL`. Its statement that OGS is empty is a data statement, not a code limitation.
8. **`docs/LIMITATIONS.md`** — contains a truncated `## Current verific` heading, says “One organisation” despite multi-tenancy, and correctly lists missing MFA, email/WhatsApp alerts, `.xls/.docx` parsing, reservations and other gaps still to implement.
9. **No MFA** — resolved in Phase 1; `docs/LIMITATIONS.md` and `docs/SECURITY.md` still need their stale statements updated in Phase 8.
10. **No AI metering/limits/search cache/usage report** — resolved in Phase 2; docs still need updating.
11. **No `check:storage`, `eval:extraction`, `verify:live` or `check:golive` scripts** — `check:storage` now exists; the other three remain missing.
12. **No supplier prospect/outreach layer** — web search produces search results and offers, but no unverified prospect record, contact extraction, drafted-RFQ queue or auto-send-to-verified path.
13. **No quotation revisions/Excel/outcome tracking/customer master** — the existing quote flow has versions and PDF, but not the full Phase 5 surface.
14. **`docs/LIMITATIONS.md` is honest about file parsing** — `.xls`, `.xlsb`, `.doc`, `.docx` and archives are not parsed. This matches the code at baseline.

## Feature state legend

- **Built + tested** — code exists and automated tests cover the behavior.
- **Built** — code exists; no dedicated test or live proof yet.
- **Needs live credentials** — code path exists; provider behavior cannot be proven here.
- **Not built** — no honest implementation yet; must be built or listed in LIMITATIONS.

## Phase 1/2 verification

| Command | Result |
| --- | --- |
| `npm run check` (Phase 2) | **PASS** — typecheck 0 errors, 27 test files / **218 tests**, production build compiled |
| Focused MFA tests | 4/4 passed, including RFC 6238 vector, one-use challenge and recovery-code replay |
| Focused Phase 2 tests | 5/5 passed: metering, limits, budget/allowance, monthly report, cache tenant isolation |
| Worker health tests | 3/3 passed: stale loop, in-flight job, missing cron secret |
| `check:storage` | **NOT RUN** — local storage is configured; S3/R2 round trip needs credentials |
| Baked OCR image | **NOT BUILT** — Dockerfile changed; daemon image build needs a Docker host |
| `npm run lint` | **NOT RUN in this phase** |

## Phase 4 verification

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — typecheck, Vitest and production build |
| Focused supplier tests | 15/15 passed: contact extraction/ranking, outreach safeguards, supplier reply ingestion |
| Additive migrations | `20261121150000_supplier_outreach`, `20261121160000_supplier_currencies` applied with `prisma migrate deploy`; no reset |
| Live providers | **NOT VERIFIED** — no AI/search/FX/email/WhatsApp credentials |

Prospect discovery creates unverified supplier records only from a public result and visibly extracted contacts. The RFQ sender now enforces do-not-contact, contact exclusions, bounced-address suppression, one request per supplier/item and a per-organization daily cap. Drafts are never sent without an approval row; optional auto-send is off by default and only applies to owner-verified suppliers.

## Phase 5 verification

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — 34 test files / **243 tests**, typecheck, production build |
| Focused quotation tests | 24/24 passed (margin floor, customer linkage/outcome, production release controls) |
| `npm run build` | PASS — `/customers`, `/customers/[id]`, `/reports` and `/api/quotations/[id]/excel` compiled |
| Additive migrations | `20261121170000_phase5_quotation_quality`, `20261121180000_customer_master` applied with `prisma migrate deploy` |
| Live providers | **NOT VERIFIED** — no credentials |

Phase 5 adds per-line origin/certification/lead-time/delivery/validity terms, revision summaries, customer-tier pricing, margin floors with recorded owner exceptions, won/lost/no-response outcomes, an Excel export and a customer master linked to enquiry/quote history. The report uses only recorded quotations and outcomes.

## Phase 4/7/10 verification

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — 30 test files / **230 tests**, typecheck and build |
| `npm run eval:extraction` | **PASS (rules-only)** — 60 synthetic cases, 56 RFQs, 100% classification and field accuracy; 0 wrong-but-confident; $0 AI cost |
| `npm run check:golive` | **EXPECTED FAIL locally** — missing CRON_SECRET, production S3, OGS org/migrations, integrations, worker. Prints a human step for each. |
| Live provider tests | **NOT RUN** — no credentials |
| 60/hour load test with attachments | **NOT RUN** — previous 30-request burst only |

The evaluation corpus is deliberately simple, one-line synthetic text. The 100% result is a regression baseline, **not** evidence of real OGS accuracy. AI-mode evaluation and Arabic/mixed-language cases are not run.

## Phase 3 verification

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — typecheck 0 errors, 28 test files / **225 tests**, production build compiled |
| Focused Phase 3 suite | 7/7 passed plus existing fastener/industrial suites (48 tests total) |
| Gaskets/insulation | Deterministic schemas, extraction and comparison tests pass |
| Bolting | A194 2H/2HM/8/8M/7/4 and A193 B7M tests pass; U-bolt type added |
| Services | Service item is marked manual and creates no search session in test |

## Current feature states (after Phase 2)

| Area | State | Evidence / gap |
| --- | --- | --- |
| Multi-tenant scoping | Built + tested | Tenant guard, 6 tenant-isolation tests, overlapping data |
| MFBMT fastener engine | Built + tested | 22 fastener tests + matching/inventory tests |
| OGS industrial schemas | Built + tested (9 categories) | Pipes, valves, flanges, fittings, gaskets, insulation kits, chemicals, spares, services |
| OGS review wiring | Built | Enquiry review displays/edits industrial spec; add Phase 3 categories/service/bolting |
| Supplier reply correlation | Built + tested | Provider/header/token correlation; 10+4 tests; live providers unverified |
| Supplier web discovery/outreach | Built + tested | Prospects deduplicated by domain, public contacts retained with source/time, draft queue, batch approval, send limits, DNC/bounce suppression |
| Storage S3 + tenant keys | Built + tested; S3 live unverified | 12 storage tests; no S3 credentials |
| Production local-storage refusal | Built + tested | `storage-config.ts`; check:storage script missing |
| Cron scheduling | Built + tested | Upstash QStash schedules both routes every 5 minutes; QStash signature + bearer auth tested; daemon worker is primary processor |
| Two-runner job safety | Built + tested | `FOR UPDATE SKIP LOCKED` claim path covered by 9 jobs-concurrency tests |
| Worker HTTP health | Built + tested | `/health` on 3001, stale-loop/in-flight tests, `livenessProbe` |
| Graceful worker shutdown | Built | SIGTERM drains, 25s deadline releases lease; no process-level integration test |
| OCR packaging/loud failure | Built | Docker bakes eng/ara; OCR errors remain explicit; image unbuilt here |
| Owner alerts/failure digest | Built + tested | Dead-letter/worker/integration/limit alerts and daily digest via durable jobs |
| TOTP MFA | Built + tested | RFC 6238, hashed single-use challenges, hashed recovery codes, enrolment UI |
| AI usage metering/budget | Built + tested | Provider usage recorded; deterministic cost; budget blocks new spend |
| Organization limits | Built + tested | Item cap, query cap, web toggle, allowance; 80/100 warnings |
| Search/page cache | Built + tested | Organization-scoped 7-day default cache with overlapping-tenant test |
| Usage report | Built | `/usage` + CSV/PDF; export route not integration-tested |
| Optional second AI pass | Not built | No second-pass path; configuration checkbox exists but does not yet change extraction |
| OGS eval corpus/harness | Built + tested (rules-only) | 60 synthetic cases; AI mode needs a key; not real-world proof |
| Go-live gate | Built | `npm run check:golive`; local failures are expected human tasks |
| Human hand-off docs | Built | OGS_ONBOARDING, RUNBOOK, SERVICE_SCOPE, HUMAN_TASKS, DEMO_SCRIPT |
| Gaskets/insulation/bolting/services | Built + tested | Gasket/insulation/service schemas; bolting deliberately stays in the fastener engine; service sourcing blocked |
| Units/conversions | Partial | Basic units only; no stated/configured quantity conversion yet |
| Chemical SDS checklist | Done | SDS/COA fields exist; missing SDS flagged in quotation approval |
| Supplier directory/ranking/CSV | Built + tested | Categories, countries, currencies, payment terms, lead time, ranking and CSV import |
| Price memory | Built | Previous supplier/customer prices with date and currency on the sourcing screen |
| FX multi-currency | Partial | Provider supports arbitrary pairs; CNY/KRW price parsing and daily cache tested; live FX unverified; no fixed non-USD/AED rates |
| Quotation technical fields/revisions/Excel | Built + tested | Per-line origin/certification/lead time/delivery/validity, visible revision summary, PDF/Excel, outcome, margin floor |
| Customer master | Built + tested | Customer/contact records, tier, enquiry and quote history, automatic linking on draft |
| Approval notifications/digest | Not built | In-app notifications only |
| Inbox/SLA/dashboard | Partial | Inbox views, SLA highlighting and tenant-configurable overdue threshold built; dashboard shows median time to quote and spend vs monthly limits. WhatsApp approval notification and safe bulk actions remain open. |
| Golden dataset/eval | Not built | No dataset/harness |
| Live verification harness | Partial | Diagnostics module exists; no `verify:live` script |
| Load test | Built (local) | 30-request burst; 60/hour with attachments missing |
| OGS demo seed | Partial | Demo seed exists; 10-enquiry OGS pipeline missing |
| File parsers | Partial | PDF/XLSX/CSV/image/text; `.xls/.docx/.zip/.doc/.xlsb` missing |
| WhatsApp templates | Not built | Plain text only; window failure is visible |
| Mailbox token resilience | Partial | Sync errors recorded; no reconnect banner/alert |
| Stock reservations | Not built | Recorded but not enforced |
| Arabic/mixed input | Partial | AI handles; rules parser Latin-only |
| Retention/export/delete | Not built | Audit retention unlimited; no tenant export/delete |
| CI/Playwright phone viewport | Partial | Playwright exists; no GitHub Actions/phone spec |
| Observability page | Partial | `/api/health`, Activity; no queue/heartbeat page |
| Backup/restore drill | Partial | Docs only; no pg_dump script/drill |
| Operator CLI | Partial | provision org/owner exists; suspend/rotate/export needs completion |
| check:golive/human tasks/demo docs | Not built | Phase 10 |

## Unverified / blocked

- **Phase 2 second AI pass is not built.** The Settings checkbox is stored but no second extraction pass runs. It is off by default; do not sell it as available.
- **Supplier reply attachments are read deterministically only.** PDF/XLSX/CSV/DOCX/image text and OCR go through `extractDocument()` and are merged into the offer with page/sheet provenance, but no vision or LLM pass runs over supplier price lists yet. Live Gmail/Microsoft reply ingestion remains unverified without credentials.
- Worker SIGTERM release and Docker OCR image were not exercised process-by-process in this environment.
- All live provider integrations (Meta, Gmail, Microsoft, AI, search, FX): **needs live credentials**; no provider call was made.
- S3/R2 round trip: **needs credentials**; local storage tests only.
- Production database migration: **not applied**; no production access used.
- Real OGS owner/account, client inventory/suppliers/letterhead/terms: **human tasks**.
- Production deployment, `main` push, real messages: **not performed**.

## Phase log

- Phase 0: baseline check PASS; docs read/compared; BACKLOG.md and STATUS.md created. No behavior changed.
- Phase 1: crons, authenticated cron calls, worker health/graceful release, storage round-trip command, baked OCR assets, operational alerts/digest and TOTP MFA with recovery codes implemented. `npm run check` PASS (27 files, 218 tests). Live S3/OCR-image checks remain unverified.
- Phase 2: AI usage table/cost, budget refusal, per-org limits and warnings, item/query caps, search cache and monthly usage page/CSV/PDF implemented. `npm run check` PASS. Optional second pass remains **not built** and is called out above.
- Phase 3: added gasket/insulation/service schemas, NACE/length vocabulary, A194 nut grades and U-bolt parsing, and a deterministic service-sourcing block. `npm run check` PASS (28 files, 225 tests). Unit conversions and the chemical SDS quotation checklist remain open.
- Phase 5: added quotation technical terms, revision summaries, customer-tier pricing, customer master, margin floor with owner exception, outcomes, Excel export and the quotation report. `npm run check` PASS (34 files, 243 tests).
- Phase 4: added prospect discovery and public-contact evidence, domain deduplication, drafted RFQ queue with batch approval, daily/DNC/bounce safeguards, reminders, supplier ranking/CSV fields and recorded price memory. `npm run check` PASS. AI+zod supplier-reply extraction and live FX remain open.
- Phase 7 evidence: added a 60-case synthetic OGS corpus, `npm run eval:extraction`, and rules-only results (100% on this simple corpus; 0 wrong-but-confident; $0 AI). AI-mode, real-mail and attachment/OCR evaluation remain unverified.
- Eval hardening: expanded synthetic corpus to 104 cases (60 standard + 44 harder: multi-line, tables, mixed units, typos, forwarded chains, signature blocks, Arabic/English mixtures), added folder mode with `labels.json`, anonymised real-enquiry template/docs, and separate rules/AI reporting with cost. `npm run check` PASS (34 test files / 243 tests); `npm run typecheck` PASS; `tests/eval-dataset.test.ts` PASS. AI-mode still unverified (no key).
- Partial Phase 8/10: added OGS onboarding, runbook, service scope, human-task list, demo script and `npm run check:golive`. The gate fails closed locally on missing production credentials/data as expected.
- 24 November 2026 — Supplier reply attachment reading: `ingestSupplierReply()` now reads every stored supplier attachment through `extractDocument()` (PDF text, OCR when enabled, XLSX/CSV/DOCX, image), persists `textExtract`/`pageCount`/`extractionStatus`/`extractionNote` per `Attachment`, and merges attachment-stated terms into the offer only where the email body left them null. Provenance is stored in `SupplierOffer.evidenceJson.attachmentProvenance` / `attachmentEvidence`. An unreadable file records a structured failure, stays visible on the review screen and does not block the reply or the offer. Added `tests/supplier-reply-attachments.test.ts` (4 tests). `npx tsc --noEmit` PASS; full suite and build results recorded in the change report.
