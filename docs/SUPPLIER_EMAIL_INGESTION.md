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
the tenant-scoped key described in `docs/STORAGE.md`. PDF, XLSX, CSV, text and
image files are accepted; unsupported or oversized files are recorded as
failures. If persistent storage is not ready, the reply is still retained but no
file is written and the failure is visible in the review screen.

## Extracted terms

The deterministic extractor records only stated values:

* unit price and currency (never a document total as a unit price);
* MOQ, quantity available, lead time;
* shipping, taxes and other charges — **unknown stays null, never zero**;
* delivery/incoterm, payment terms, validity, certifications, country of origin,
  brand/manufacturer and any stated technical attributes.

A VAT percentage without an amount is flagged as an unknown tax amount.

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
