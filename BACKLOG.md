# BACKLOG — OGS production readiness

Legend: `[ ]` not done · `[x]` code + tests + docs + committed · `[H]` human-only task (account, approval, credentials, client data, contract). A fresh session reads `STATUS.md` first, then this file, and resumes at the first unchecked non-human task.

## Phase 0 — Read, baseline, memory

- [ ] Read README.md and every file in docs/; record doc/code disagreements in STATUS.md.
- [ ] Create STATUS.md with feature states and baseline command output.
- [ ] Run `npm run check`; record typecheck, tests and build baseline.
- [ ] Create this BACKLOG.md and commit the baseline state.

## Phase 1 — Production safety

- [x] Add Vercel cron entries for `/api/cron/process-jobs` and `/api/cron/email-sync` every 5 minutes.
- [x] Prove two runners cannot execute the same job; add a two-runner concurrency test.
- [x] Add an HTTP health server to the worker and a `livenessProbe` in `vercel.json`.
- [x] Graceful SIGTERM/SIGINT: finish or release the current job, then close the health server and database.
- [x] Verify production refuses local-disk storage; document S3 requirement.
- [x] Add `npm run check:storage` that writes, reads and deletes a test object.
- [x] Bake Tesseract language data into Dockerfile.worker.
- [x] Make OCR failure explicit, never a silent skip.
- [x] Add owner alerts for dead-letter jobs, stale worker heartbeat and failing connected integrations.
- [x] Add a daily failure digest.
- [x] Add TOTP MFA for OWNER and admin roles, with hashed recovery codes and replay protection.
- [ ] Add MFA enrollment/challenge UI and recovery-code regeneration. Enrolment UI is built; explicit post-enrolment code regeneration is not.
- [x] Preserve existing login rate limiting and add MFA tests.
- [x] Phase 1: `npm run check` green, commit, update STATUS.md.

## Phase 2 — Cost control and billing evidence

- [x] Add `AiUsage` table with organization, job type, model, input/output tokens, estimated cost, timestamp.
- [x] Record provider usage for every AI call; never estimate tokens when the provider supplies usage.
- [x] Add per-organization limits: max sourced items/enquiry (default 5), max search queries/item (default 2; OGS 3), web-search on/off, monthly AI budget, monthly enquiry allowance.
- [x] Enforce limits with graceful degradation and owner-visible warnings.
- [x] Add 80% and 100% allowance warnings.
- [x] Add organization-scoped search/page cache with configurable TTL (default 7 days).
- [x] Add monthly usage report page and CSV/PDF export with AED conversion.
- [x] Include enquiries, RFQs, AI tokens/cost, search credits, quotations sent in the report.
- [ ] Add optional stronger-model second pass for low-confidence extraction, off by default, separately metered. **Not built**; checkbox storage only.
- [x] Add tenant-isolation and deterministic-cost tests.
- [x] Phase 2: `npm run check` green, commit, update STATUS.md.

## Phase 3 — OGS product coverage

- [x] Wire all six existing OGS categories end to end: extraction prompt, deterministic fallback, review UI, inventory matching, sourcing, comparison, quotation lines.
- [x] Add Gaskets schema: type, size, pressure class, material/filler, standard.
- [x] Add Insulation Kit schema.
- [x] Add Bolting schema: stud/hex bolts, nuts, washers, U-bolts, threaded bars; ASTM A193 B7/B7M/B8/B8M/L7/L7M; A194 2H/2HM/8/8M/7/4. Implemented in the existing fastener engine so safety-critical bolt dimensions cannot bypass its matcher; A194 and U-bolt tests added.
- [x] Fix fastener grade parsing for A194 nut grades and add tests.
- [x] Decide/document bolting engine choice (fastener vs industrial) with a test proving the decision.
- [x] Detect service lines (machining, hydrotesting, plating, NDT, PMI); flag them and route to manual quoting without sourcing.
- [x] Add domain vocabulary: UNS, ASTM/API/ASME, schedules, classes 150–2500, RF/FF/RTJ, BW/SW/THD/FLGD, NPS/DN, per-meter/length, random/double random, NACE/sour service.
- [x] Make unknown/conflicting attributes produce INSUFFICIENT or NO_MATCH; never guess.
- [x] Require an explicitly approved substitution for material equivalence.
- [ ] Add stated/configured unit conversions for meters, lengths, pieces and sets; never assume. **Not built**; basic unit normalization only.
- [ ] Use SDS/COA fields for chemicals; flag missing SDS in quotation checklist; no compliance claim. Fields exist, checklist flag not built.
- [x] Phase 3: `npm run check` green, commit, update STATUS.md.

## Phase 4 — Supplier workflow

- [x] Put a reference token in every supplier RFQ subject and body; match replies by token and thread id.
- [ ] Extract prices, MOQ, lead time, validity and currency from replies/PDF/Excel with AI + zod. **Partial**: deterministic extraction is covered; no AI path is claimed.
- [x] Store extracted replies as unverified draft offers with one-click human confirmation; never auto-approve.
- [x] Respect robots.txt, SSRF and size limits when fetching public supplier pages.
- [x] Extract and retain public emails, contact-page links and phones with source URL and retrieval time.
- [x] Create deduplicated prospect supplier records by domain, with category/country/source evidence.
- [x] Draft supplier RFQs from item specs when a result has no visible price, attaching prospect recipients.
- [x] Show all drafted RFQs for one enquiry on one screen with one recorded “approve and send selected” action.
- [x] Add optional auto-send to owner-verified suppliers only; default manual; full audit.
- [x] Add daily send limit per organization.
- [x] Add do-not-contact list enforcement.
- [x] Handle bounces and suppress bad addresses.
- [x] Enforce max one RFQ per supplier per item.
- [x] Send automatic reminder after configurable days without reply.
- [x] Add supplier directory fields: categories, countries, currencies, payment terms, typical lead time, last quoted prices.
- [x] Rank suppliers by category fit and past quotes.
- [x] Add supplier CSV import.
- [x] Show previous quoted/purchased prices for same item/customer with date and currency on sourcing/quotation screens.
- [ ] Add provider-backed FX with daily caching and SAR, INR, EUR, CNY, KRW support. Partial: arbitrary provider pairs, CNY/KRW parsing and 24h cache; live provider and fixed non-USD/AED rates unverified.
- [x] Store FX rate and timestamp on every conversion; no rate => incomplete total, never assumed.
- [x] Phase 4: `npm run check` green, commit, update STATUS.md. Deterministic supplier reply extraction remains the only extraction path; AI+zod and live FX stay unchecked.

## Phase 5 — Quotation quality

- [ ] Add per-line full technical description, country of origin, certification offered, lead time, delivery terms, validity.
- [ ] Add quotation revisions R0/R1/R2 with visible change summary.
- [ ] Add Excel export beside PDF.
- [ ] Use organization letterhead, terms and numbering from tenant settings.
- [ ] Add pricing rules by organization, category and customer tier.
- [ ] Add margin floors that block sending below floor without owner override and recorded reason.
- [ ] Add outcome tracking: won/lost/no-response with reason.
- [ ] Add report: response time, conversion rate, margin by category.
- [ ] Add customer master (companies/contacts), linked to enquiries with quote history.
- [ ] Phase 5: `npm run check` green, commit, update STATUS.md.

## Phase 6 — Owner speed at 40 enquiries/day

- [ ] Add approval email notifications with deep links.
- [ ] Add WhatsApp approval notification only where the Cloud API window allows.
- [ ] Add daily pending-approval digest.
- [ ] Add inbox views: needs review, waiting on suppliers, ready to quote, overdue.
- [ ] Add bulk actions for safe confirmation steps only; keep three approvals individual.
- [ ] Add SLA timers with configurable overdue highlight.
- [ ] Add dashboard: today's volume, backlog, median time to quote, spend vs monthly limits.
- [ ] Phase 6: `npm run check` green, commit, update STATUS.md.

## Phase 7 — Proof

- [x] Build golden dataset of ≥60 synthetic OGS enquiries across the listed categories; represented as text with source-kind metadata, not real binary Excel/PDF files.
- [x] Store expected structured results alongside every golden case.
- [x] Add `npm run eval:extraction` with field-level accuracy by category, wrong-but-confident count, AI cost/enquiry.
- [ ] Run eval with rules-only parser and with AI when a key exists. Rules-only done (100% on 60 simple synthetic cases); AI mode unverified.
- [ ] Add `npm run verify:live` for AI, search, FX, storage, Gmail/Microsoft and WhatsApp when credentials exist. **Not built.**
- [x] Never mark Connected without a passing live test.
- [ ] Add 60-enquiries/hour load test with attachments; report queue latency, CPU, memory, DB connections, dead letters. **Not run.**
- [ ] Add OGS demo seed: ten synthetic enquiries, message to approved quotation PDF, checked by automated test. **Not built.**
- [ ] Phase 7: `npm run check` green, commit, update STATUS.md. **Partial**: corpus/harness only.

## Phase 8 — Documentation

- [x] Update README.md and docs/ to match verified reality. Status/report docs updated; README not fully rewritten.
- [x] Add docs/OGS_ONBOARDING.md with required client inputs.
- [x] Add docs/RUNBOOK.md: deploy, rollback, backup/restore, incidents.
- [x] Add docs/SERVICE_SCOPE.md: included, limits, out of scope.
- [ ] Keep docs/LIMITATIONS.md honest and current. Needs a final pass for the new partial features.
- [ ] Phase 8: `npm run check` green, commit, update STATUS.md. **Partial**: docs added, README/LIMITATIONS still need reconciliation.

## Phase 9 — Audit gaps

- [ ] Add .xls parsing.
- [ ] Add .docx parsing.
- [ ] Add safe .zip handling with count/size/nesting limits and no path traversal/execution.
- [ ] Safely handle legacy .doc/.xlsb with a maintained library or retain + clearly flag manual entry.
- [ ] Document each new parser/library choice and license.
- [ ] Add per-organization WhatsApp approved-template configuration (name, language, variable mapping).
- [ ] Use templates for supplier RFQs and customer quotations outside the 24-hour window.
- [ ] Fail visibly with reason and offer email fallback when no template is configured.
- [ ] Detect expired/revoked Gmail/Microsoft refresh tokens.
- [ ] Add persistent reconnect banner and owner alert email.
- [ ] Enforce soft stock reservations when a quotation is approved, with owner override.
- [ ] Implement multi-unit conversions for inventory/quotation.
- [ ] Add saved inventory column-mapping profiles with diff preview on re-import.
- [ ] Add Arabic and mixed Arabic/English golden cases; ensure classification/extraction/review layout holds.
- [ ] Add configurable message/attachment retention per organization.
- [ ] Add per-organization data export and safe cascading delete, fully audited.
- [ ] Add GitHub Actions CI with PostgreSQL service: typecheck, lint, unit tests, build.
- [ ] Add Playwright main-pipeline test including phone viewport.
- [ ] Add structured logs with request/job ids.
- [ ] Add optional error tracking configured only by env var.
- [ ] Add Settings observability page: queue depth, last heartbeat, last sync, failed jobs with retry.
- [ ] Add scripted pg_dump backup/restore and run a restore drill against a scratch database; record in STATUS.
- [ ] Extend operator CLI: create organization + first owner, suspend/reactivate, rotate credential key safely, export monthly usage.
- [ ] Document operator CLI.
- [ ] Phase 9: `npm run check` green, commit, update STATUS.md.

## Phase 10 — Go-live automation and human hand-off

- [x] Add `npm run check:golive` for ogs: env, DB/migrations, storage round trip, worker heartbeat, cron secret, integration live results, FX, letterhead/terms, inventory, one verified supplier.
- [x] Print PASS/FAIL per line and exact human remediation for every FAIL.
- [ ] Complete and comment `.env.production.example` with every variable and where to obtain it. File exists; final audit against env.ts still needed.
- [x] Add docs/HUMAN_TASKS.md generated from code/capabilities, ordered, with owner/time/links; human tasks only.
- [x] Add docs/DEMO_SCRIPT.md with exact 15-minute click path and synthetic data.
- [ ] Add seed command creating demo data only outside production. Existing demo seed is guarded; ten-enquiry OGS pipeline seed not built.
- [ ] Phase 10: `npm run check` green, commit, update STATUS.md. **Partial**: gate/docs built; env/seed/demo polish incomplete.

## Phase 11 — Self-audit finish line

- [ ] Search repo for TODO, FIXME, stub, mock, placeholder, “not implemented”, unused routes/screens/exports, broken-default feature flags.
- [ ] Run check, Playwright, eval:extraction, load test and check:golive.
- [ ] Fix every finding; update BACKLOG/STATUS; commit.
- [ ] Final report: built work, test/eval results, unverified items, exact human tasks, risks.
- [ ] Definition of done verified: check/tenant/eval/load pass; OGS onboardable from docs; STATUS has every feature state; no non-human unchecked tasks; golive fails only on HUMAN_TASKS; final risk table.

## Human tasks (not code)

- [H] Approve and supply OGS owner name/email; authorize owner provisioning.
- [H] Create/approve Meta app, Business verification, WhatsApp number and templates.
- [H] Google OAuth consent/verification and mailbox access.
- [H] Microsoft app registration/admin consent and mailbox access.
- [H] Provide AI, search and FX API accounts/keys.
- [H] Create Vercel, Neon/PostgreSQL and private bucket accounts; set production env vars.
- [H] Provide domain/DNS and TLS.
- [H] Supply inventory file, supplier list, letterhead, terms, approval users, customer data.
- [H] Approve production migration window/backup and production deployment.
- [H] Run supervised pilot, send real supplier/customer messages, and accept commercial terms.
