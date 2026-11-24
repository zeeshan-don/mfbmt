# Automatic supplier email reply ingestion

Gmail and Microsoft 365 replies from known suppliers are ingested, correlated to
the outstanding RFQ they answer, stored idempotently, and turned into unverified
supplier offer drafts.

## Correlation order

When a supplier RFQ is created, the application stores:

* supplier, supplier email and recipient;
* customer enquiry reference and RFQ subject;
* a random `RFQ-xxxxxxxx` correlation token in the subject and body;
* provider thread/message ids when the send response returns them
  (Gmail currently returns both; Microsoft Graph sendMail returns no message id,
  so the token/thread/header paths cover it).

An inbound email from a known supplier is compared in this order:

1. exact provider thread id;
2. `In-Reply-To` / `References` against the stored provider message id;
3. the opaque `RFQ-` correlation token in subject or body;
4. the customer enquiry reference (`ENQ-...`);
5. sender identity against the intended supplier.

Only evidence 1–3 auto-attaches, and only when exactly one RFQ matches. An
enquiry reference with a different sender, or sender identity alone, is
`NEEDS_REVIEW` with the possible RFQs shown to the owner. A similar subject with
no identifier never attaches. A known supplier email that matches nothing is
retained as `UNMATCHED`; it is never discarded.

## Idempotency

`SupplierEmailReply` has a unique key on
`(organizationId, provider, externalMessageId)`. Repeated mailbox syncs therefore
cannot create a second reply or a second offer for the same email. The offer is
also guarded by the unique `SupplierQuoteItem.offer` link.

## Attachments

Supplier attachments are validated by content type and size, then stored under
the tenant-scoped key described in `docs/STORAGE.md`. PDF, XLSX, CSV, DOCX, text
and image files are accepted; unsupported or oversized files are recorded as
failures. If persistent storage is not ready, the reply is still retained but no
file is written and the failure is visible in the review screen.

Every stored attachment is then **read**, not just retained, through the same
`extractDocument()` pipeline used for customer enquiries. Digital PDF text,
scanned-page OCR (when `OCR_PROVIDER` is enabled), XLSX/CSV rows, DOCX tables and
image OCR are all available. Each file gets its own `Attachment` record with
`textExtract`, `pageCount`, `extractionStatus` and `extractionNote`, so a price
list that could not be parsed is visible instead of looking like an empty quote.

A file that cannot be read records a structured failure and does not stop the
reply: the email body and any other readable attachment are still processed, and
the failure is listed in `SupplierEmailReply.correlationJson.attachmentFailures`
and returned as the ingestion reason.

## Extracted terms

The deterministic extractor records only stated values:

* unit price and currency (never a document total as a unit price);
* MOQ, quantity available, lead time;
* shipping, taxes and other charges — **unknown stays null, never zero**;
* delivery/incoterm, payment terms, validity, certifications, country of origin,
  brand/manufacturer and any stated technical attributes.

A VAT percentage without an amount is flagged as an unknown tax amount.

When the email body omits a value, the supplier's attachments may supply it.
Body wording always wins; an attachment only fills fields that are still null.
Every attachment-sourced field keeps its provenance on the offer's
`evidenceJson.attachmentProvenance` as `filename (page/sheet/row)`, and
`evidenceJson.attachmentEvidence` lists each file's extraction status, page
count, page/sheet references and the fields it supplied. Unknown values remain
null after merging; they are never filled with zero or a guess.

## AI-assisted reading

When `AI_PROVIDER` is configured, the reply body and every readable attachment
are also passed to `extractSupplierQuotation()` in `src/lib/ai/supplierExtraction.ts`.
The response is validated against a strict Zod schema covering supplier intent,
supplier reference, currency, multiple quoted products, specifications, unit vs
total price, quantity and UoM, MOQ, lead time, shipping, taxes, validity, payment
terms, availability, alternatives, general terms, clarifications, confidence and
per-item evidence (source, page/worksheet/row, short quote, reading method).

AI output is merged *after* deterministic extraction. A field the body or an
attachment already stated is kept; a disagreement is recorded in
`extractedJson.conflicts` with both values and the source, and is shown on
`/suppliers/replies`. AI-sourced values keep `ai:` provenance. Missing values
remain `null`. A total price is never promoted to a unit price; only a total
produces a clarification and leaves the unit price unknown.

The AI never chooses the RFQ and never approves, verifies, sends or confirms
anything. RFQ correlation remains the deterministic precedence described above.
If the provider times out, returns invalid JSON, or the monthly budget is
exhausted, deterministic terms are kept and the AI status is recorded as
`FAILED`, `BUDGET_BLOCKED` or `NOT_CONFIGURED`. Only transient provider failures
(timeout, 429/5xx, network) enqueue the bounded `EXTRACT_SUPPLIER_REPLY` job, which
retries with the worker's existing exponential backoff and dead-lettering.

## Unknown senders

A sender who is not in the supplier directory is evaluated before customer
intake. Deterministic supplier signals (a priced offer, price list, quotation
wording) are checked first; a priced attachment is read for the check. When AI
is configured it may refine the intent, subject to the existing
`AI_FOR_UNKNOWN_SENDERS` privacy switch (a clearly priced business document is
allowed through). A plausible supplier response is retained as an unmatched
`SupplierEmailReply` with `supplierId = null` and a `SUPPLIER_REPLY_UNKNOWN`
notification. No supplier account is created and no offer is made until the owner
links the sender and/or matches an RFQ. An ordinary customer request continues
to `ingestInboundMessage()` unchanged.

When matched, the reply creates a `SupplierOffer` with:

* `status = QUOTE_RECEIVED`;
* `verificationStatus = UNVERIFIED`;
* `sourceType = SUPPLIER_QUOTE`;
* the supplier's original wording, attachment names, extraction confidence and
  match reasons in `evidenceJson`.

The owner reviews and confirms the offer before it can be used. Email ingestion
does not approve an offer, select a supplier, create a purchase order or send a
customer quotation.

## Review screen

Owner-only `/suppliers/replies` lists pending ambiguous/unmatched replies with the
extracted commercial terms and possible RFQs. The owner can match a reply to the
correct RFQ (which creates the same unverified draft) or mark it reviewed /
dismissed. Every action is audited.

## Provider setup

Gmail: OAuth scopes must allow reading messages and attachments. Push (Pub/Sub)
is optional; polling with a persistent cursor is supported.

Microsoft 365: Graph `Mail.Read`-equivalent access for the connected mailbox.
`conversationId` is used as the thread identifier and `internetMessageHeaders`
supplies `In-Reply-To`/`References` when returned.

No supplier email is sent automatically. Supplier RFQs, follow-ups and purchase
orders each require explicit owner approval.

## Outlook intake path

Outlook messages use the same pipeline as Gmail and WhatsApp: contact exclusions are applied before attachment download and before anything is persisted; supplier replies are correlated by provider
thread, In-Reply-To/References or RFQ token; customer messages go through
`ingestInboundMessage()` and the existing classification/extraction jobs.
Supplier attachments are read by `extractDocument()` and, when AI is configured,
the body and documents are read again by the supplier extraction pass. Their
page/sheet evidence is stored with the offer, which remains `UNVERIFIED` until the
existing review/approval process says otherwise. Unknown senders with plausible
supplier intent become review candidates instead of customer enquiries. No second
procurement pipeline exists for Outlook.
