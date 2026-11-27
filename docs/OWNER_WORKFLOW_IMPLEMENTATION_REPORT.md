# Owner Workflow Implementation Report

Date: 27 November 2026

## Scope delivered

This pass is deliberately owner-first. It does not introduce a Sales role, assigned portfolios, or a new persistent task system. The aim is to make the current Owner account's daily operating sequence clearer without replacing the existing enquiry, sourcing, approval, quotation, supplier and order modules.

## Changes

### 1. Record-backed owner action queue

Added `src/lib/workflow/ownerWorkQueue.ts`.

The queue reads live tenant-scoped business records and creates actionable items for:

- Enquiry extraction/review.
- Missing product specifications.
- Enquiries ready for stock/sourcing review.
- Pending approvals.
- Unverified supplier offers.
- Customer acceptance and PO reviews.
- Supplier PO approval and approved-but-unsent POs.
- Supplier acknowledgements awaiting review.
- Overdue supplier deliveries, but only after the supplier-facing PO has been sent/acknowledged.
- Blocking/high order discrepancies.
- Overdue customer invoices and supplier bills.
- Customer quotations that need to be completed, sent, or followed up. The Overview also reports how many active deals have work outstanding, even though it only displays the top-priority rows.
- Supplier quote requests with overdue responses.
- Failed supplier research runs.
- The next operational step for active sales orders.

### 2. One primary action per deal

The queue deduplicates actions and keeps the highest-priority action for a deal. Where an enquiry has exactly one active sales order, enquiry-level actions are grouped under that order so the same deal does not appear twice during the transition to fulfilment. If it has multiple active sales orders, the queue does not guess which order owns the enquiry-level task.

If an enquiry has multiple active sales orders, enquiry-level work remains separate because the system cannot safely guess which order owns it.

### 3. Overview page

Updated `src/app/(app)/(dashboard)/page.tsx`:

- Owner accounts now see **Your next actions** at the top of Overview.
- Each item shows the actual issue, priority, and one action link into the module that owns the record.
- The existing detailed modules and commercial operations summary remain available.
- Non-owner accounts retain their existing overview attention section.

### 4. Dashboard query reduction

Added `ownerDashboardSummary()` to `src/lib/orders/dashboard.ts` so the homepage loads the commercial summary separately from the full detailed `/orders` operations board. This avoids running every order attention count twice on the Overview page.

### 5. Owner handover guide

Added `docs/OWNER_QUICK_START.md` describing how an owner should use the queue from enquiry through closure, and the existing approval and verification boundaries.

### 6. Regression coverage

Added `tests/owner-work-queue.test.ts` with eight test cases covering:

- One primary action per deal.
- Highest-priority action selection.
- Oldest item tie-breaking.
- Priority ordering.
- Queue limit.
- Empty queue.
- One active order grouping.
- Ambiguous multiple-order grouping.

## Verification performed

- TypeScript transpilation/syntax checks passed for the modified queue service, Overview page, dashboard service and new test file.
- Eight direct runtime assertions against the pure queue selection/grouping functions passed.
- `npm run typecheck` could not complete because the ZIP's dependencies were not installed; TypeScript reports missing type definition packages including `node`, `react`, `react-dom`, `pdfkit` and others.
- `npm test -- --run` could not start because `vitest` is not installed.
- `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --fetch-retries=0` failed with npm's `Exit handler never called!` error. No successful dependency installation was obtained.
- Therefore a full project typecheck, Vitest run, lint and production build are **not verified** in this environment.
- No production database, live email/provider, or deployed application was changed or tested.

## Important scope boundaries

This pass does not implement:

- A separate Sales role or sales assignment model.
- Persistent customer follow-up tasks or scheduled customer outreach.
- A single combined detail page replacing the specialist modules.
- New order/invoice/payment business logic.

Those are separate changes and should not be implied by the owner action queue.

## Deployment checklist

1. Review this source diff in the main development repository.
2. Install dependencies using the normal development environment.
3. Run `npx prisma validate`, `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
4. Test the owner queue against a staging database containing at least one example of each action type.
5. Verify that each action link opens the correct record and the action disappears or is replaced after the underlying record changes.
6. Confirm tenant isolation and owner-only access.
7. Deploy the web application through the normal pipeline. No database migration was added in this pass.
8. Have the owner run one real enquiry through review, sourcing, supplier quote verification, customer quotation, acceptance and order progression before handover.

## Acceptance definition

The Owner Overview must tell the owner what needs attention next, link directly to the correct existing business record, avoid duplicate deal rows where the enquiry has one active order, and derive all items from real records. It is a navigation/workflow simplification, not a claim that every back-office step is fully autonomous.
