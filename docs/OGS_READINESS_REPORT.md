# OGS readiness report — 21 November 2026

## What is verified

| Check | Result |
| --- | --- |
| `npm run check` | PASS — typecheck, 30 Vitest files, 230 tests, production build |
| `npm run eval:extraction` | PASS on the synthetic rules corpus — 60 cases, 56 RFQs, 100% classification, 100% quantity/category fields, 0 wrong-but-confident, $0 AI cost |
| MFA | RFC 6238 vector, single-use challenge, recovery-code replay and enrollment tests pass |
| Tenant isolation | Overlapping MFBMT/OGS tests pass for usage and search cache |
| Cron/job safety | `FOR UPDATE SKIP LOCKED` concurrency tests and cron auth tests pass |
| Storage/FX | Local storage round trip and same-currency FX path tested; S3 and live FX unverified |
| Go-live gate | `check:golive` runs and fails closed locally with human remediation |

The 100% eval figure is **not** a real-mail accuracy claim. The corpus is simple synthetic text; real attachments, OCR, Arabic/mixed language and AI-mode runs are unverified.

## Built in this pass

- Durable cron fallback, worker `/health`, graceful SIGTERM release, storage check command, baked OCR language assets, operational alerts/digest and TOTP MFA.
- AI token/cost metering, per-organization limits, search cache, monthly usage page and CSV/PDF export.
- Gaskets, insulation kits, service lines, A194 nut grades, U-bolts and service-sourcing block.
- 60-case OGS synthetic evaluation corpus and harness.
- Go-live gate and OGS onboarding/runbook/service-scope/human-task/demo documents.

## Not built or not proven — do not sell as available

- Supplier prospect discovery and contact extraction, drafted-RFQ queue, auto-send-to-verified, send limits, bounce/reminder workflow.
- Supplier directory ranking/CSV, price memory, full multi-currency provider verification.
- Quotation technical fields, R0/R1/R2 revision history, Excel export, margin floors/override workflow, won/lost reports, customer master.
- Approval email/WhatsApp deep links, safe bulk inbox actions, SLA timers, requested dashboard metrics.
- Optional second AI pass (checkbox only).
- `.xls/.docx/.zip/.doc/.xlsb` parsing, WhatsApp templates, mailbox reconnect banner, stock reservations, retention/export/delete, observability page, operator CLI.
- GitHub Actions, phone-viewport Playwright pipeline, 60-enquiry/hour attachment load test, backup restore drill.
- Live AI/search/FX/storage/Gmail/Microsoft/WhatsApp tests.
- Production migration/deployment and real OGS provisioning.

## Cost and load evidence

AI cost for the rules-only corpus is $0 because no provider was called. No valid production AI cost per enquiry can be quoted without a live key and real mail. The previous local burst was 30 requests; it is not the required 60-enquiry/hour attachment test.

## Risks to disclose before signature

1. Real OGS extraction accuracy is unmeasured; the synthetic corpus is easier than scanned supplier/customer mail.
2. Supplier outreach and quotation revision/outcome workflows are not complete, so the “reduce salesperson workload” promise is only partly delivered.
3. Every live integration and production migration remains unverified in this environment.
4. The development database currently reports an older `Organization` schema; production must run pending migrations after a verified backup.
5. No production deployment, real messages, purchases or payments were made.

## Human tasks

See `docs/HUMAN_TASKS.md`. Provider approvals, credentials, client data, contract/sign-off and supervised pilot are required before go-live.
