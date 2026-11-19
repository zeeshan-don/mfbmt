# Architecture

## Shape of the system

```
┌──────────────────────────── Browser (owner / staff) ────────────────────────────┐
│ Next.js App Router screens. No procurement logic in components.                 │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ server actions (mutations) / server components (reads)
┌───────────────────────────────▼─────────────────────────────────────────────────┐
│ Application layer  src/lib/workflow/*                                           │
│ enquiries · jobs · approvals · quotations · supplier quotes · item corrections  │
└───────┬───────────────────────┬──────────────────────────────┬──────────────────┘
        │                       │                              │
┌───────▼─────────┐   ┌─────────▼──────────┐        ┌──────────▼─────────────────┐
│ Interpretation  │   │ Procurement engine │        │ Commercial control         │
│ ai/classify     │   │ inventory/check    │        │ costing/landed             │
│ ai/extract      │   │ sourcing/engine    │        │ costing/ranking            │
│ intake/documents│   │ sourcing/adapters  │        │ pricing/rules              │
│ (evidence only) │   │ (evidence only)    │        │ workflow/approvals         │
└─────────────────┘   └────────────────────┘        └────────────────────────────┘
        │                       │                              │
        └───────────────────────┴──────────────┬───────────────┘
                                               ▼
                       Prisma → PostgreSQL
                       Attachments on disk, encrypted integration secrets in DB
                       BackgroundJob table → `npm run worker` or /api/jobs/tick
```

The important boundary: **AI never computes commercial facts**. It reads text and proposes structure. Quantities, stock, prices, conversions, MOQ checks, eligibility, approvals and state transitions are deterministic code with tests.

## Request flow for one enquiry

1. **Intake** (`lib/intake/*`, `workflow/enquiry#ingestInboundMessage`)
   - Webhook authenticity is checked before parsing (WhatsApp HMAC; forwarding shared secret).
   - `Message.externalMessageId` is unique: provider retries return the existing message.
   - Excluded contacts are recognised before storage; their body is discarded and no job is queued.
   - Attachments are sniffed by content, size-limited, stored under a random name, deduplicated by SHA-256.
2. **Classification** (`lib/ai/classify`)
   - Rules first; an AI provider may refine. Excluded personal contacts never reach the model.
   - Only `RFQ` creates an extractable enquiry. `UNCLEAR`/`AVAILABILITY` create a review record; no sourcing.
3. **Extraction** (`lib/ai/extract`, `intake/documents`)
   - Attachment text: embedded PDF text → OCR for images → Excel/CSV rows with header detection.
   - The AI or deterministic parser returns a strict schema (`zod`). Invalid output is rejected, not trusted.
   - Original extraction is stored in `Enquiry.extractedJson` / `EnquiryItem.extractedJson`; owner edits never overwrite it.
4. **Stock check** (`lib/inventory/check`, `matching`)
   - Token search narrows candidates; deterministic attribute comparison decides the status.
   - Only exact matches fulfil stock. A missing required attribute yields `INSUFFICIENT`, never an exact match.
   - Available = on hand − reserved. Stock older than 30 days is flagged.
5. **Sourcing** (`lib/sourcing/engine`)
   - Adapters run independently; each reports OK / NOT_CONFIGURED / FAILED with a reason, stored on the session.
   - Every result keeps its source URL, title, price text, retrieval time and extracted evidence.
   - Candidates are deduplicated, matched against the *original* requirement, and persisted as offers.
6. **Comparison** (`lib/costing/evaluate`, `landed`, `ranking`)
   - FX rate + timestamp is recorded per conversion; no rate → incomplete, not a guess.
   - MOQ raises the effective quantity; ineligible offers are excluded from ranking.
   - Snapshot stored on each offer so the UI, approval payload and audit trail read identical numbers.
7. **Approval** (`lib/workflow/approvals`)
   - Owner picks an offer (or overrides with a reason). State stored on the item and in `Approval`.
   - Second decision on the same approval is refused.
8. **Quotation** (`lib/workflow/quotations`, `lib/pdf`)
   - Built from approved offers and pricing rules; supplier cost/margin is internal only.
   - Approval of the quotation is a separate record; sending is a manual/authorised action.

## Background processing

`BackgroundJob` is the queue. It is a database table, so restarts lose nothing.

- States: `QUEUED → PROCESSING → COMPLETED | FAILED | CANCELLED`.
- `idempotencyKey` is unique: re-queuing the same work returns the existing job.
- Attempts are stored; failures back off (20s, 40s, 80s… capped at 15 minutes) up to each job's own `maxAttempts`, then stay `FAILED` with the reason. Expired leases are requeued by the same per-job limit.
- A worker that dies mid-job is recovered after 10 minutes (`releaseStaleJobs`).
- `npm run worker` is the normal runner. `/api/jobs/tick` exists for hosts without a long-running process; it performs the same work and requires `WORKER_SECRET`.

## Module ownership

| Concern | Source of truth |
|---|---|
| Message identity / dedupe | `Message.externalMessageId` |
| What the customer asked | `EnquiryItem` (and immutable `extractedJson`) |
| What MFBMT has | `InventoryStock` |
| What suppliers offered | `SupplierOffer` (+ evidence JSON) |
| Why an option is eligible | `SupplierOffer.landedCostJson` snapshot |
| What the owner decided | `Approval` + `AuditLog` |
| What was quoted | `CustomerQuotation` version |
| Files | disk under `STORAGE_ROOT`; metadata in `Attachment` |

## Defaults and deliberate constraints

- **PostgreSQL** is the datasource. JSON payloads are stored as validated text so schemas evolve without destructive enum changes; the queue relies on PostgreSQL row locking (`FOR UPDATE SKIP LOCKED`) and worker liveness on a persisted heartbeat registry (see `docs/DATABASE.md`).
- **Single organisation** is assumed; the `Organization` row holds quotation identity and defaults.
- **Currency**: prices keep their original currency. Comparison uses the enquiry currency (or the organisation default).
- **No scraping behind controls**: page fetching checks robots.txt, blocks private hosts, caps size and timeout.

## Multi-company update (2026-11-19)

The application is now tenant-aware end to end. `src/lib/db.ts` scopes every tenant query in the
caller's async context (not inside a Prisma extension, which loses `AsyncLocalStorage`). Explicit
webhook, supplier-token and job work runs inside `runWithTenant`. `Organization` is global; every
business model carries `organizationId`. See `docs/MULTITENANCY.md`.
