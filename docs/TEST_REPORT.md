# Test report

## Summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass (0 errors) |
| `npx vitest run` | Pass — **6 test files, 65 tests** |
| `npm run build` | Pass — all 31 routes compile and are registered |
| Manual smoke (HTTP) | `/api/health` → `{"status":"ok",...}`; unauthenticated dashboard → 307 to `/login`; security headers present |
| Auth negative checks | unauthenticated routes redirect; inbound webhook returns 401/503; WhatsApp webhook returns 403/401/503; `/api/jobs/tick` returns 503 without secret |
| PDF | generated file begins with `%PDF-1.3` and is 3,212 bytes (demo quotation) |

## Automated tests

| File | Tests | Covers |
|---|---|---|
| `tests/classification.test.ts` | 10 | RFQ vs availability vs personal vs supplier vs unclear; excluded contacts never classify; confidence |
| `tests/normalization.test.ts` | 14 | Size, material, grade, pressure, schedule, unit normalisation and synonyms |
| `tests/matching.test.ts` | 11 | Exact/equivalent/similar/no-match/insufficient; missing attribute → insufficient; quantity availability |
| `tests/costing.test.ts` | 17 | Landed cost arithmetic, MOQ, incomplete-cost handling, FX conversion, eligibility, ranking order, snapshots |
| `tests/workflow.test.ts` | 10 | Ingestion, dedupe, classification gating, inventory check, sourcing engine adapter failure handling, approval single-shot, quotation draft, supplier quote response |
| `tests/auth.test.ts` | 3 | Generic login error message; database-backed sign-in throttling (lockout after 8 failures); audit recording |

Total: **65 tests, 0 failures**, runtime ~17 s on a Windows dev machine (bcrypt hashing dominates).

## Manual verification performed

- Seeded the database with `npm run db:seed` and walked the two demo enquiries through the UI.
- Verified ENQ-2026-0001: hammers and valves are marked `CLARIFY` with full quantity to source; SS316 elbow shows as stock.
- Verified ENQ-2026-9002: Gulf Fasteners ranked #1 (landed 148 / 775), Emirates Industrial Supply excluded for MOQ, Al Noor excluded for material mismatch; 1 pending sourcing approval; 3 suppliers; 2 completed jobs.
- Generated a quotation PDF and confirmed it is a valid PDF with company block, line items, totals, terms and validity.
- Verified owner vs staff: staff cannot open Settings or Approvals, and internal cost/margin is not in the API response for staff.
- Verified staff cannot reach `/api/jobs/tick` without the secret, and the WhatsApp webhook rejects bad signatures.

## What is not covered by automated tests

- **Scenarios A–M as named end-to-end cases.** They were used as acceptance checks during the build (see the demo seed and the enquiry detail screens), but there is no separate test file per scenario. The behaviour they exercise — classification, clarification, stock split, sourcing coverage, landed-cost ranking, owner approval, quotation approval, send gating — is covered by the unit and workflow tests above, but a regressions-only end-to-end harness would be needed for confidence in the full pipeline.
- **Live integrations.** Meta, Google, Microsoft, AI providers, search APIs, OCR on scanned documents and exchange-rate providers were exercised only through their unconfigured/error paths. Their live request/response shapes follow the providers' documented APIs, but onboarding must be verified against real accounts.
- **UI rendering.** Components were checked by loading routes in a browser and by inspection; there is no DOM/visual regression suite.
- **Concurrency.** The job queue and approval single-shot guards are tested sequentially. Concurrent execution of the same job or approval was not load-tested.
- **Accessibility.** Contrast and focus states were designed for WCAG AA and checked by inspection; no automated auditor (axe/lighthouse) was run.
- **Database portability.** Only SQLite was exercised. PostgreSQL is supported by the schema design but has not been migrated or tested in this build.

## Reproducing

```bash
npm ci
cp .env.example .env
npx prisma migrate deploy
npm run db:seed
npm run typecheck
npm test
npm run build
```

Tests create and reset `prisma/test.db` via `prisma db push --force-reset`; they never touch `prisma/dev.db`.
