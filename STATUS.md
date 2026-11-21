# STATUS — OGS production readiness

Last updated: 21 November 2026 (Phase 0 baseline)  
HEAD: `8c4142eaa64e16125de7c842c8f4f46482ae6290` · branch `main`  
Working tree: baseline hardening changes being committed; no production env, database, credentials or deployments touched.

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

1. **`vercel.json` vs cron routes** — `src/app/api/cron/process-jobs/route.ts` and `src/app/api/cron/email-sync/route.ts` say they are scheduled every 5 minutes, but `vercel.json` currently defines only the worker daemon and no `crons` array. This is a real production gap.
2. **Worker health** — `src/worker.ts` has durable heartbeats and SIGTERM/SIGINT flags, but no HTTP health server and no `livenessProbe`; it also cannot release a claimed job while blocking inside a handler.
3. **OCR packaging** — `Dockerfile.worker` does not bake Tesseract language data. `docs/INTEGRATIONS.md` correctly says language data is downloaded first use, which is unsafe on ephemeral Vercel storage.
4. **Deployment/storage docs** — `docs/DEPLOYMENT.md` and the storage section of `docs/INTEGRATIONS.md` still describe a writable local disk/`STORAGE_ROOT` as the normal deployment. Code now requires S3 in production unless `STORAGE_ALLOW_LOCAL_VOLUME=true`.
5. **README provisioning** — the setup example still shows `MBFMT_OWNER_*` and a password in the environment. The implemented flow is explicit `ORG_SLUG`/`CONFIRM_ORGANIZATION` plus a one-time invitation, and passwords are refused from the environment.
6. **RELEASE_REPORT stale status** — its main body says OGS extraction-screen wiring and automatic supplier-reply matching are not implemented; the 21 Nov addendum and code show both implemented. Current test count is 206, not 164.
7. **MULTITENANCY stale status** — it says OGS category wiring is pending; the industrial flow is now wired behind `procurementProfile=INDUSTRIAL`. Its statement that OGS is empty is a data statement, not a code limitation.
8. **`docs/LIMITATIONS.md`** — contains a truncated `## Current verific` heading, says “One organisation” despite multi-tenancy, and correctly lists missing MFA, email/WhatsApp alerts, `.xls/.docx` parsing, reservations and other gaps still to implement.
9. **No MFA** — `docs/LIMITATIONS.md` and `docs/SECURITY.md` correctly say MFA is absent. No TOTP code exists yet.
10. **No AI metering/limits/search cache/usage report** — documented features do not exist yet; AI calls return no usage to the app, and sourcing has no query cache.
11. **No `check:storage`, `eval:extraction`, `verify:live` or `check:golive` scripts** — only the scripts visible in `package.json` exist.
12. **No supplier prospect/outreach layer** — web search produces search results and offers, but no unverified prospect record, contact extraction, drafted-RFQ queue or auto-send-to-verified path.
13. **No quotation revisions/Excel/outcome tracking/customer master** — the existing quote flow has versions and PDF, but not the full Phase 5 surface.
14. **`docs/LIMITATIONS.md` is honest about file parsing** — `.xls`, `.xlsb`, `.doc`, `.docx` and archives are not parsed. This matches the code at baseline.

## Feature state legend

- **Built + tested** — code exists and automated tests cover the behavior.
- **Built** — code exists; no dedicated test or live proof yet.
- **Needs live credentials** — code path exists; provider behavior cannot be proven here.
- **Not built** — no honest implementation yet; must be built or listed in LIMITATIONS.

## Current feature states (baseline, before Phase 1)

| Area | State | Evidence / gap |
| --- | --- | --- |
| Multi-tenant scoping | Built + tested | Tenant guard, 6 tenant-isolation tests, overlapping data |
| MFBMT fastener engine | Built + tested | 22 fastener tests + matching/inventory tests |
| OGS industrial schemas | Built + tested (6 categories) | `industrialSpec.ts`, extraction/matching tests |
| OGS review wiring | Built | Enquiry review displays/edits industrial spec; add Phase 3 categories/service/bolting |
| Supplier reply correlation | Built + tested | Provider/header/token correlation; 10+4 tests; live providers unverified |
| Supplier web discovery/outreach | Not built | Phase 4 |
| Storage S3 + tenant keys | Built + tested; S3 live unverified | 12 storage tests; no S3 credentials |
| Production local-storage refusal | Built + tested | `storage-config.ts`; check:storage script missing |
| Cron scheduling | Not built | Route code exists; `vercel.json` has no crons |
| Two-runner job safety | Built + tested | Existing jobs-concurrency tests; add explicit two-runner proof |
| Worker HTTP health | Not built | DB heartbeat exists |
| Graceful worker shutdown | Partial | Flag stops loop; no job release/health server |
| OCR packaging/loud failure | Partial | OCR works; Docker language data missing |
| Owner alerts/failure digest | Not built | In-app notifications only |
| TOTP MFA | Not built | No code |
| AI usage metering/budget | Not built | No usage capture |
| Organization limits | Not built | No limits |
| Search/page cache | Not built | No cache model |
| Usage report | Not built | No page/export |
| Optional second AI pass | Not built | No second-pass path |
| Gaskets/insulation/bolting/services | Not built | Only six base categories |
| Units/conversions | Partial | Basic units; no stated conversions |
| Supplier directory/ranking/CSV | Partial | Supplier model/UI exists; fields/ranking/import need work |
| Price memory | Not built | No history view |
| FX multi-currency | Partial | USD/AED + provider; SAR/INR/EUR/CNY/KRW paths need proof/tests |
| Quotation technical fields/revisions/Excel | Partial | Version/PDF exist; fields/exports/outcome missing |
| Customer master | Not built | Contact model exists but no company master/quote history |
| Approval notifications/digest | Not built | In-app notifications only |
| Inbox/SLA/dashboard | Partial | Enquiries/activity exist; views/timers/metrics missing |
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

- All live provider integrations (Meta, Gmail, Microsoft, AI, search, FX): **needs live credentials**; no provider call was made.
- S3/R2 round trip: **needs credentials**; local storage tests only.
- Production database migration: **not applied**; no production access used.
- Real OGS owner/account, client inventory/suppliers/letterhead/terms: **human tasks**.
- Production deployment, `main` push, real messages: **not performed**.

## Phase log

- Phase 0: baseline check PASS; docs read/compared; BACKLOG.md and STATUS.md created. No behavior changed.
