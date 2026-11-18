# Test report

Environment: Windows dev machine, Node 24, local PostgreSQL, isolated `mfbmt_test` database.
No live provider credentials were available.

## Summary (latest run)

| Check | Result |
|---|---|
| `npx prisma validate` | Pass |
| `npx prisma generate` | Pass (production build ran `prisma generate` successfully) |
| `npx prisma migrate deploy` (dev + test DB) | Pass — additive migrations applied, including `20261118130000_approval_pending_only_unique` |
| `npx tsc --noEmit` | Pass — 0 errors |
| `npm run lint` | Pass — 0 errors (20 pre-existing warnings) |
| `npm test` | Pass — **14 files, 142 tests** |
| `npm run test:e2e` | Pass — **7 Playwright (Chromium) tests** |
| `npx next build` | Pass — production bundle completed (37 routes). `npm run build` was blocked at `prisma generate` by a Windows lock on the Prisma engine DLL; the already-generated client built successfully. |
| Production start smoke | Pass — `next start` refused the unsafe demo `.env` (fail-closed), then served `/login` (200), `/` → `/login` (307) and `/api/health` with a production-safe env. Health reported `worker: unknown`, not a fake green |
| Worker runtime | Pass — one and two workers started, polled, and `/api/health` reported `worker: healthy` with a current heartbeat |
| PDF inspection | Pass — both demo and E2E quotation PDFs are 1 page, contain totals/VAT, and contain no supplier cost/margin/internal text |

## Automated coverage

| File | Tests | Covers |
|---|---:|---|
| `tests/fasteners.test.ts` | 22 | Structured parsing; M10 vs M12; 1.5 vs 1.25 pitch; 30 vs 50 length; bolt vs nut/washer; 8.8 vs 10.9; A2 vs A4; zinc vs HDG; DIN 933/ISO 4017 vs DIN 931/ISO 4014; UNC vs UNF vs metric; missing pitch/class/length → INSUFFICIENT; exact match stays EXACT; owner-approved material equivalence → EQUIVALENT; unapproved substitution → NO_MATCH; approved material cannot hide pitch/class conflicts; missing data remains INSUFFICIENT; generic pipe-fitting matching unchanged |
| `tests/fastener-inventory.test.ts` | 4 | Stock uses confirmed fastener attributes: M12 stock never satisfies M10; class 10.9 never satisfies 8.8; missing pitch → CLARIFY |
| `tests/jobs-concurrency.test.ts` | 9 | Concurrent `Promise.all` claims; single completion; stale-worker completion/failure rejected; per-job maxAttempts; dead-letter threshold; retry refuses completed/cancelled; heartbeat HEALTHY/STALE/UNKNOWN |
| `tests/routes.test.ts` | 5 | Every internal href/action resolves to an app route; `/settings/integrations` gone; staff nav hides owner-only pages; demo nav only in demo mode |
| `tests/seed-guard.test.ts` | 4 | Seed rejected in production regardless of flags; requires both explicit opt-ins; requires PostgreSQL |
| `tests/e2e/release.spec.ts` | 7 | Owner login/navigation/logout; fastener demo walkthrough; PDF download and internal-cost leakage check; staff navigation/server-side guards and redacted costs; real Next.js Server Action replay with the owner cookie removed and a staff session, proving the action itself redirects to `/login` and leaves the approval pending; isolated approval, quotation approval and PDF flow; mobile navigation/enquiry/sign-out |

Previous suites (classification, normalization, matching, costing, workflow, auth, production safety,
document reading and the end-to-end procurement flow) continue to pass.

## What was verified manually against the development demo database

- The fastener walkthrough has: line 1 fully covered by stock; line 2 short with 100 on hand and 200 to source;
  line 3 missing length and property class (CLARIFY).
- Offer outcomes on line 2: exact offer with huge MOQ (eligible, disclosed overbuy); exact offer with missing
  freight (eligible but total incomplete, unranked); exact fully-costed offer (rank 1); wrong class/finish
  (NO_MATCH, excluded).
- An approved sample quotation exists with a generated PDF at a private storage path.
- Approval uniqueness no longer crashes on re-approval: pending-only partial unique index replaces
  `(type, entityId, status)`.
- Staff sourcing view redacts unit price, MOQ, shipping and estimated total, hides approve/search/manual-price
  controls, and server guards return `denied=1` for owner-only pages.
- Both demo and isolated E2E PDFs parse successfully with `pdf-parse`; 1 page each; VAT line present on demo
  quote; no supplier cost/margin/internal text.
- Fastener equivalence was fixed at the shared matcher: the fastener path now receives active
  `MaterialEquivalence` rows instead of returning before the generic equivalence policy. Inventory, sourcing,
  manual offers and supplier responses all use the same deterministic path.
- The direct server-action test captures a real action POST from the owner page, aborts it, removes the owner
  cookie, and replays the same action/body with a staff session. The action returns a redirect to `/login` and
  the approval stays `PENDING`; it is not merely a page-navigation check.

## PASS / FAIL / NOT VERIFIED

| Area | Result |
|---|---|
| Fastener specification and matching | PASS |
| Owner-approved equivalence policy | PASS |
| Authorization at page, action and browser-session level | PASS |
| Demo workflow and screenshots | PASS |
| Quotation PDF content and leakage check | PASS |
| Queue concurrency, leases, retries and heartbeat | PASS |
| Automated checks (`validate`, `tsc`, `lint`, `vitest`, `next build`) | PASS |
| `npm run build` wrapper on this Windows host | NOT VERIFIED — `prisma generate` DLL lock |
| Live Meta/Google/Microsoft/AI/search/FX onboarding | NOT VERIFIED — no credentials |
| OCR with downloaded language data | NOT VERIFIED — local code path exists, no live run in this environment |
| Managed PostgreSQL, reverse proxy, backups, monitoring | NOT VERIFIED — deployment infrastructure not available |

## Not verified here

- **Live integrations**: Meta/WhatsApp, Gmail, Microsoft 365, AI providers, web search and FX were
  exercised only through unconfigured/error paths and mocks. Real onboarding requires the owner's accounts.
- **OCR**: Tesseract and PDF page rendering are implemented, but no run with downloaded language data was
  completed here. HEIC/HEIF conversion depends on the installed `sharp` native build and falls back honestly
  when it cannot decode a file.
- **Production-like PostgreSQL**: only local PostgreSQL; managed pooling/failover was not tested.
- **Demo send**: the simulation adapter is unit-level code; no test sets `DEMO_MODE=true` at import time
  because the test environment deliberately runs with demo mode off.
- **Extended mobile visual inspection**: responsive layout was exercised by Playwright at 390x844 and
  screenshots were captured, but no exhaustive manual visual review of every screen was performed.

## Reproducing

```bash
npm ci
cp .env.example .env                    # set PostgreSQL DATABASE_URL + secrets
npx prisma migrate deploy
npx prisma validate
npx tsc --noEmit
npm run lint
npm test                               # uses TEST_DATABASE_URL or mfbmt_test
npm run test:e2e                       # requires a running dev server on 127.0.0.1:3000
npm run build
```

Demo walkthrough:

```bash
# .env: DEMO_MODE=true, SEED_DEMO_DATA=true, NODE_ENV=development
npm run db:seed
npm run dev
# sign in and open /demo
```
EOF