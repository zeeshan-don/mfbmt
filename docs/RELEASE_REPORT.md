# Release report — 2026-11-19

## Classification

**PILOT READY.** The owner workflow, fastener matching, authorization boundaries, PDF output and queue
reliability are verified locally. Production classification is withheld until live provider credentials,
managed PostgreSQL, HTTPS/reverse-proxy deployment, backups and monitoring are verified.

## Bugs found and fixed

### 1. Fastener path bypassed owner-approved equivalences

- **Root cause:** `matchProduct()` took the deterministic fastener branch and returned immediately. It
  called `compareFastenerSpecs()` without passing `MaterialEquivalence` rules, and hard-coded
  `usedEquivalence: false`.
- **Fix:** `compareFastenerSpecs()` now accepts active equivalence rules and can return `EQUIVALENT` only
  when an approved material substitution is present. Hard conflicts in diameter, thread, pitch, length,
  property class, finish, head/drive, certification or a customer-specified standard still return
  `NO_MATCH`; missing required data still returns `INSUFFICIENT`.
- **Callers updated:** inventory matching, sourcing engine, manual supplier offers, supplier response form.
- **Provenance:** the rule carries `approvedById`, `approvedAt`, `reason` and `isActive`; offers keep their
  supplier-stated `offeredSpecJson` and evidence. No AI/parser output creates an equivalence.

### 2. Direct server-action authorization test did not invoke the action

- **Root cause:** the old test posted guessed form fields to the page URL. Next.js rendered the owner-only
  page and redirected to `/?denied=1`; it never proved the Server Action ran.
- **Fix:** the test now captures a real action POST from the owner page, aborts it, strips the owner cookie
  and replays the same `Next-Action` header and body with a staff session. The action redirects to
  `/login`, and the approval remains `PENDING`.

### 3. Operational test failures caused by a stale dev server

- **Root cause:** an old Next.js process held port 3000 and served a stale `.next` bundle, producing a
  webpack `__webpack_modules__[moduleId] is not a function` error on approval pages.
- **Fix:** stopped stale processes, restarted on port 3000, and reran the suite. No application code change
  was required for this failure.

## Files modified

- `src/lib/fasteners/spec.ts`
- `src/lib/inventory/matching.ts`
- `src/lib/sourcing/engine.ts`
- `src/lib/workflow/supplierQuotes.ts`
- `src/app/actions/sourcing.ts`
- `tests/fasteners.test.ts`
- `tests/e2e/release.spec.ts`
- `docs/TEST_REPORT.md`, `docs/LIMITATIONS.md`, `docs/INTEGRATIONS.md`, `docs/IMPLEMENTATION_AUDIT.md`,
  `docs/DATABASE.md`, `README.md`

## Migrations

No new migration was required for this pass. Existing additive migrations:

- `20261118120000_fastener_specs_and_worker_heartbeat`
- `20261118130000_approval_pending_only_unique`

## Verification actually executed

| Check | Result |
|---|---|
| `npx prisma validate` | PASS |
| `npx tsc --noEmit` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors, 20 pre-existing warnings |
| `npm test` | PASS — 14 files / 142 tests |
| `npm run test:e2e` | PASS — 7 Playwright Chromium tests |
| `npx next build` | PASS — 37 routes |
| `npm run build` wrapper | NOT VERIFIED on this host — `prisma generate` DLL file lock; generated client builds |
| Worker concurrency/lease tests | PASS — `tests/jobs-concurrency.test.ts` |
| PDF content/leakage | PASS — demo and E2E PDFs 1 page, totals/VAT, no internal cost/margin |
| Live WhatsApp/email/AI/search/FX | NOT VERIFIED — no credentials |
| Managed PostgreSQL / reverse proxy / backups | NOT VERIFIED — no production infrastructure |

## Deployment instructions

1. Copy `.env.production.example` to `.env`; fill `DATABASE_URL`, `APP_URL`, `AUTH_SECRET`,
   `CREDENTIAL_ENCRYPTION_KEY`; keep `DEMO_MODE=false` and `SEED_DEMO_DATA=false`.
2. `npm ci && npx prisma migrate deploy && npm run build`
3. Run the web process with `npm start -- -p 3000`.
4. Run the worker as a supervised service: `npm run worker` (`Restart=always`; see
   `docs/DEPLOYMENT.md`).
5. Put HTTPS in front; expose `/api/webhooks/*` publicly and keep the rest restricted.
6. Provision the first owner with `npm run provision:owner` (never run `db:seed` in production).
7. Verify `GET /api/health` reports `database: reachable` and a fresh worker heartbeat.
8. Configure live integrations in Settings and press **Test connection** for each; do not treat a saved key
   as a working integration.

## Remaining external dependencies

- Meta WhatsApp Business / Embedded Signup credentials and a business number.
- Google Gmail OAuth client or Microsoft Graph app registration.
- AI provider key, web-search API key, FX provider key (optional).
- S3-compatible bucket if not using local disk.
- Managed PostgreSQL, HTTPS reverse proxy, backup target and monitoring/alerting.

## Remaining risks

- No live provider end-to-end call has been made.
- OCR depends on Tesseract language data and a working `sharp` build for HEIC.
- One organisation only; no multi-tenant billing or subscription layer.
- No automated accessibility/penetration/load audit.
- Approvals are in-app only; the owner must sign in.
- The app does not place purchase orders or payments.
