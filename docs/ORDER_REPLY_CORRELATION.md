# Inbound acceptance and supplier acknowledgement correlation

Status: implemented and covered by automated tests. No live mailbox, provider or production database was used to verify these flows.

## Why this exists

The order-to-closure lifecycle (sales orders, supplier POs, receipts, deliveries, invoices, payments and verified closure) is implemented in `src/lib/orders/`. Two inbound links were still manual:

1. A customer replying with a purchase order or written acceptance had to be re-entered on the orders screen.
2. A supplier replying to a sent purchase order had to be recorded manually.

This change connects both replies to the existing durable records. It does **not** auto-approve anything: extraction is evidence, and the owner still makes every commercial decision.

## Customer acceptance path

```
inbound email
  → deterministic correlation to one exact CustomerQuotation version
  → document package processing (existing pipeline)
  → customer purchase-order AI reading (text + vision)
  → CustomerAcceptanceReview (PENDING)
  → owner decision
      ACCEPT_ORIGINAL  → sales order built from the quotation snapshot
      APPROVE_REVISED  → sales order built from the customer's stated lines (reason required)
      REJECT           → no order
```

### Correlation

`correlateCustomerReply()` scores every open (`APPROVED`/`SENT`, already sent) quotation for the tenant:

| Evidence | Score | Auto-match |
|---|---|---|
| Provider thread id | 100 | yes, if unique |
| `In-Reply-To` / `References` contains the sent provider message id | 100 | yes, if unique |
| Opaque `QTN-…` token embedded in the sent subject/body | 95 | yes, if unique |
| Quotation number in subject/body | 90 | yes, if unique |
| Customer/sender address only | 55 | no — `NEEDS_REVIEW` |

A tie at the top score is `NEEDS_REVIEW`. A weak match is not handled by this path, so ordinary customer intake continues unchanged.

The token is derived deterministically from the quotation id (`sha256("QTN:"+id)`), so retries produce the same reference. It contains no tenant or customer data.

### Extraction

`extractCustomerPurchaseOrder()` uses the existing AI provider abstraction, document text from `processDocumentPackage()`, and the same bounded vision handoff as supplier replies. It returns:

- header: PO number/date, currency, payment/delivery terms, delivery address/date, tax, conditions
- lines: description, specifications, quantity, unit, unit price, discount, tax, line total, optional quotation line ref, evidence

Missing values stay `null`; nothing is converted to zero. If AI is unavailable, the review is still stored with the original email and attachments, but conversion is disabled and the UI says the document could not be read.

### Comparison

`compareAcceptanceToQuotation()` compares the reading with the exact quotation version: product identity, specifications, quantity, unit, unit price, discount, line tax, currency, tax amount/rate, payment/delivery terms, validity, delivery date and extra conditions.

Every difference is stored in `CustomerAcceptanceReview.comparisonJson` with `code`, `severity`, `quoted`, `requested` and a message. Blocking differences never create an order on their own. `ACCEPT_ORIGINAL` records that the changed values were rejected and builds the order from the quotation snapshot; it does not adopt them. Partial acceptance requires `APPROVE_REVISED` with a recorded reason.

### Conversion and idempotency

`convertAcceptanceReview()` calls the existing `createSalesOrderFromAcceptance()` with `idempotencyKey = acceptance-review:<reviewId>`. The sales order keeps:

- tenant, customer, source enquiry
- `quotationId` and `quotationVersion`
- customer PO number and acceptance evidence
- immutable line snapshots (description, specs, quantity, unit, price, discount, tax, line total, stock/procure split)

Replaying the same email returns the existing review; replaying the conversion returns the existing order. The review moves `PENDING → CONVERTED | REJECTED | DISMISSED` with reviewer, timestamp and note.

## Supplier purchase-order reply path

```
sent supplier PO
  → deterministic correlation to one PurchaseOrder
  → acknowledgement reading (AI lines when available, deterministic default otherwise)
  → SupplierAcknowledgement (PENDING) + PO ACKNOWLEDGEMENT_RECEIVED
  → owner review (existing screen)
      APPROVE → ACKNOWLEDGED | PARTIALLY_ACKNOWLEDGED | REVISED | REJECTED
      DISMISS → back to SENT
```

### Correlation

`correlatePurchaseOrderReply()` uses the same ordered evidence: provider thread, message-id header, opaque `PO-…` token, PO number in the subject, then sender. Sender-only matches require owner review.

The token is added to the outgoing subject and body (`Purchase order PO-2026-0001 [PO-AB12CD34EF56]`) and stored on the PO. It is stable across retries.

### Reading and deviations

`deriveAcknowledgement()` maps AI-read lines to PO lines by exact/normalised description and word overlap. It records:

- acknowledged quantity (defaults to ordered when not stated)
- revised unit price (only when stated and different)
- promised date from stated lead time
- deviations: `PARTIAL_QUANTITY`, `EXCESS_QUANTITY`, `REVISED_PRICE`, `LATE_DELIVERY`, `SUPPLIER_REJECTED`

Rejection phrases produce `REJECTED` with zero acknowledged quantities. With no itemised evidence the acknowledgement defaults to the ordered quantities at `LOW` confidence and is explicitly marked `DETERMINISTIC_DEFAULT`.

**The approved PO is never changed by ingestion.** Prices, totals and line values stay exactly as approved. Revised prices are applied only by the existing `reviewSupplierAcknowledgement()` path, which creates a new PO version and records an event.

### Idempotency

`SupplierAcknowledgement.supplierReplyId` is unique. Replaying the same mailbox message returns the existing acknowledgement; no second record, notification or status event is created.

## Data model changes

Migration: `prisma/migrations/20261126120000_order_acceptance_and_ack_correlation/`.

Additive only:

- `CustomerQuotation.correlationToken` (unique), `providerThreadId`, `providerMessageId`
- `PurchaseOrder.correlationToken` (unique), `providerThreadId`
- `SupplierEmailReply.purchaseOrderId` + relation/index
- `SupplierAcknowledgement.supplierReplyId` (unique) + relation
- `Attachment.acceptanceReviewId` + relation/index
- new `CustomerAcceptanceReview` model (tenant-scoped, unique on `(organizationId, externalMessageId)`)
- `CustomerAcceptanceReview` added to `TENANT_MODELS`

Existing rows keep working: a quotation or PO created before this change simply has no token; thread/header/number correlation still applies, and the token is generated the next time the document is sent.

## Permissions and approvals

- `/orders` and `/orders/acceptance/[id]` are owner-only (`requireOwner()`).
- Conversion, rejection and dismissal are owner server actions.
- A changed commercial term never becomes a commitment without an explicit owner decision.
- Supplier acknowledgements remain `PENDING` until the existing owner review approves or dismisses them.
- Inbound ingestion runs as `system` and records audit entries; it performs no outbound send.

## Tests and actual results

New files:

- `tests/customer-acceptance.test.ts` — 13 tests
- `tests/purchase-order-acknowledgement.test.ts` — 9 tests

They cover: token/thread/header correlation, weak-evidence rejection, ambiguous ties, exact acceptance, changed price/quantity/specification, unreadable documents, idempotent review creation, idempotent conversion, rejection, quotation-ref mapping, cross-tenant refusal, real `ingestCustomerAcceptanceReply` and `ingestSupplierReply` entry points, partial/revised/late/rejected supplier replies, and duplicate acknowledgement ingestion.

Results in this environment:

- `npx tsc --noEmit` — pass
- `npx vitest run` — 65 files, 495 tests passed
- `npm run lint` — 0 errors, 23 pre-existing warnings
- `npm run build` — pass; `/orders/acceptance/[id]` included
- `npx prisma validate` — pass
- migration diff for the new objects — no drift

## Limitations

- No live Gmail/Microsoft mailbox, email send or production database was used. The provider boundaries are exercised through the existing guarded/outbound paths and mocks; a staging smoke test is still required.
- AI extraction quality was not benchmarked against real customer PO scans. With `AI_PROVIDER=none`, reviews are stored but cannot be converted automatically.
- The supplier acknowledgement reading reuses the supplier-quotation extraction output; it does not run a second dedicated AI call. Without AI, it records a low-confidence default that still requires owner review.
- No PDF rendering of the customer PO or supplier acknowledgement is produced; the original files and the sent document JSON are retained.
- The existing migration diff shows unrelated pre-existing drift (legacy indexes/defaults). It does not involve any object added here.

## Staging smoke tests

1. Send an approved quotation from a test mailbox; confirm the subject contains `[QTN-…]` and the token is stored.
2. Reply from the customer address with a PDF PO that changes one price. Confirm one `PENDING` review, the price difference with quoted/requested values, and no sales order.
3. Convert with `ACCEPT_ORIGINAL`; confirm the order uses the quoted price and is bound to the quotation version. Replay the same email; confirm no duplicate.
4. Send an approved supplier PO; confirm `[PO-…]` in the subject and the token stored.
5. Reply as the supplier with a partial quantity and a revised price. Confirm one `PENDING` acknowledgement, PO status `ACKNOWLEDGEMENT_RECEIVED`, and unchanged PO prices/totals.
6. Approve the acknowledgement with a reason; confirm the PO version/total changes only then.
7. Run the same webhook/message id twice; confirm one review/acknowledgement and no duplicate notifications.
8. Sign in as staff; confirm `/orders/acceptance/[id]` is not accessible.
