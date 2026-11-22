# Limitations

Everything below is a known, deliberate limit of this build. None of it is disguised in the UI: missing configuration says **Not connected**, missing data says **Needs review**, and incomplete costs say **incomplete** instead of guessing.

## Intake

- **WhatsApp Cloud API only.** The app cannot read an existing personal WhatsApp inbox, chat history or groups. Coexistence between the WhatsApp Business app and the Cloud API is controlled by Meta and varies by account — confirm eligibility in Business Manager before promising it. A dedicated business number is the reliable path. No unofficial clients, session hijacking or scraping.
- **Business-initiated WhatsApp messages** are subject to Meta's 24-hour window/templates. A failed send is reported; it is not retried forever or silently downgraded.
- **Gmail / Microsoft 365** require OAuth app approval. While a Google OAuth app is in testing mode, refresh tokens may expire after 7 days and only test users can connect. Microsoft needs admin consent for `Mail.Read`/`Mail.Send`.
- **Email intake** supports polling, Gmail Pub/Sub push and Microsoft Graph change notifications. Push endpoints must be reachable over HTTPS and their shared secrets configured; without credentials only the error paths can be exercised.
- **Forwarded email** requires a provider that can POST JSON with a shared secret; a plain mail rule that only forwards to an address will not work without that bridge.
- **Attachments**: PDF, XLSX, CSV, DOCX, ZIP and plain text, plus JPEG, PNG and WebP. ZIP extraction enforces entry-count, decompressed-size, nesting and path-traversal limits. Legacy `.xls`, `.xlsb` and `.doc` are not parsed and must be re-saved as `.xlsx`, `.docx` or PDF. HEIC/HEIF photos are converted when the server's `sharp` build supports them; if conversion fails the app keeps the file and asks for a JPEG.

## Reading documents

- Scanned PDFs with no embedded text are rendered page-by-page and read with Tesseract OCR when `OCR_PROVIDER` is not `none`. Language data is downloaded on first use; without internet or language data the PDF is flagged for manual entry, never silently skipped. Image OCR uses the same Tesseract path.
- Table extraction is heuristic. Merged cells, multi-row headers and units in a separate column can be misread. The original text and the extraction are always shown so the owner can correct them.
- The deterministic parser handles common RFQ phrasing (quantities, sizes, materials, grades, units). Unusual layouts fall back to review rather than invention.
- An AI provider improves messy text, but is optional. Without a key, all AI-dependent paths are marked "read without AI assistance". The app never fabricates AI output.
- Arabic and mixed-language messages are passed to the AI provider when configured; the rule-based parser only recognises Latin text and numbers. Arabic-only messages will need review.

## Sourcing and comparison

- **No marketplace API is integrated.** Amazon Business, Tradeling and similar require contracts/credentials; the adapter returns `NOT_CONFIGURED` rather than scraping. Discovery relies on the configured web search API plus manual entry.
- **Web results are not price truth.** A listing price without a stated MOQ, shipping or validity remains incomplete and is not ranked. Suppliers must confirm before a purchase.
- **Only up to five result pages** are fetched per run for evidence; deeper catalogues are not crawled.
- **Search engines rate-limit.** A failed adapter is recorded with its reason; results from other adapters are still used.
- **No automated supplier negotiation or bidding.** RFQs are drafted and sent only after approval; responses are read from the supplier form or entered by staff.
- **FX** needs a configured provider or the fixed USD/AED peg. Without a rate, cross-currency comparison is marked incomplete. Rates are point-in-time, not hedged.
- **Landed cost excludes** customs duty, clearing fees, inland transport and payment charges unless someone enters them as "other charges". Recoverable VAT is excluded from landed cost by design but shown separately.

## Stock

- Inventory is only as good as the import. There is no ERP/accounting integration in this build (no Tally, Zoho, Odoo or QuickBooks sync).
- Stock older than 30 days is flagged, not verified. Physical counts are not scheduled.
- Unit conversion is dimension-aware. Fixed physical factors (m/mm, kg/g, l/ml, m²) and atomic counts (pcs/pc/each) convert; packaging units (box, pair, set, roll, coil, bundle, carton, drum, bag) convert **only** when a product-specific factor is explicitly configured. There is no implicit “1 box = 1 piece”.
- Reservations are enforced. Approval reserves stock transactionally across eligible locations, row-locks the stock, never over-reserves, and rolls the approval back when stock is insufficient. Holds expire after 7 days and are released on rejection or cancellation. An owner can override only with a recorded reason; an override never invents reserved units. A hold is not a purchase order.

## Workflow and approvals

- **Approvals are in-app, with notification links.** Approval emails contain a deep link; WhatsApp approval alerts are opt-in and subject to Meta's service window. The decision itself always requires an authenticated session. There is no native mobile push or e-signature.
- **No purchase orders, payments or supplier commitments** are created. Approval authorises sourcing and quoting only; the actual purchase happens outside the system.
- **Quotation sending** is gated by a second approval, but the send itself uses the connected mailbox or manual export. No e-signature, no delivery/read tracking beyond provider errors.
- **Quotation versioning** keeps versions, but editing an approved quotation creates a new approval rather than an amendment trail with redlines.
- **Multiple tenants are supported**, with organization-scoped data, credentials and numbering. Multi-branch accounting and inter-company pricing remain out of scope.

## Platform

- **Database**: PostgreSQL 14+ is required. The schema uses text JSON payloads rather than `jsonb`; add GIN indexes if you need JSON query performance.
- **Sessions are cookie-based** with a configurable lifetime (`AUTH_SESSION_DAYS`, 1–90) and TOTP MFA for owners/admins. No SSO, SAML or OIDC.
- **Account management**: owner-created staff accounts, permissions, deactivation, password change and reset links exist. There is no e-mail delivery guarantee for reset links when no mailbox is connected.
- **No field-level encryption** for business data. Integration tokens and secrets are AES-256-GCM encrypted; business data at rest relies on PostgreSQL/disk encryption.
- **No malware scanning** of uploaded files. Treat attachments as untrusted.
- **CSP** is set in `next.config.ts` (Meta domains allowed for Embedded Signup). It uses `'unsafe-inline'` for Next bootstrap and the Meta SDK; a nonce-based policy would require removing the inline Meta handlers.
- **Notifications** are always written in-app; approval emails are sent through the connected mailbox, and WhatsApp owner alerts are opt-in. Without a connected mailbox, only the in-app notification is guaranteed.
- **Storage**: local disk or any S3-compatible private bucket (R2, S3, MinIO). Azure Blob is not implemented.
- **Background jobs**: safe to run more than one worker thanks to `FOR UPDATE SKIP LOCKED` and compare-and-set leases. The long-running worker is primary; a single QStash job-processing watchdog runs every 5 minutes. Mailbox polling is worker-only and per tenant; there is no tenant-less email-sync schedule.
- **Observability** is structured console logs, the audit log, `/api/health` and the Activity screen. No metrics, tracing or error-tracking integration.

## Data and demo content

- The seed creates clearly marked **demo** users, suppliers, products and enquiries. It is fail-closed: production is always rejected and both `DEMO_MODE=true` and `SEED_DEMO_DATA=true` are required. Re-running it is idempotent and never resets stock or owner edits.
- The fastener walkthrough (`/demo`) can be restored without touching the original demo records; it rebuilds only `ENQ-DEMO-FASTENER-01/02`.
- Supplier names, contacts and prices in demo records are fictional or illustrative; e-mail addresses use the non-deliverable `.test` domain. They are not live market quotations.
- Demo mode routes e-mail/WhatsApp through a simulation adapter: no provider call, order or payment is made.
- Audit log retention is unlimited; there is no archival or purge policy configured.

## Not tested here

- No real Meta, Google, Microsoft, AI or search credentials were available, so those calls were exercised only through their error/unconfigured paths. The code follows the documented request/response shapes, but live onboarding must be verified in your accounts.
- A targeted load/concurrency harness was run (`npm run stress`, 30 reservations, 300 queued jobs, 60 outbound messages); see `docs/LOAD_TESTING.md`. No sustained 60-enquiry/hour full-pipeline load, penetration or accessibility audit tooling was run. Contrast and focus states were designed for WCAG AA and checked by inspection, not with an automated auditor.
- No production deployment was performed; `docs/DEPLOYMENT.md` describes the expected setup.
- `docs/INTEGRATION_READINESS.md` records the same provider status in table form.

## Multi-company update (2026-11-19)

- Live WhatsApp, Gmail/Microsoft, AI, search and FX calls remain unverified: no provider credentials.
- There is no platform-administration web UI; tenant lifecycle is the operator CLI only.
- OGS industrial schemas and deterministic comparison are implemented and unit-tested, but every OGS
  category is not yet wired into the enquiry extraction screens.
- A support-access workflow with explicit authorization and audit is not implemented; operators
  cannot read customer data.

## Current verification limits (22 November 2026)

Live Gmail, Microsoft 365, WhatsApp, AI, web-search and exchange-rate checks were NOT executed because no provider credentials or dashboard access were used in this work. Their diagnostics report NOT_CONFIGURED or NOT_VERIFIED until an owner runs a real check; stored credentials alone are not treated as proof.

The targeted concurrency harness (`npm run stress`) ran against an isolated local PostgreSQL database with mocked providers. Its timings are machine-specific and are not a production capacity guarantee. A sustained 60-enquiry/hour full-pipeline load test with attachments was not run.

An isolated PostgreSQL backup/restore drill passed (`mfbmt_test` -> `mfbmt_restore`, 11 table counts matched). The dump contained 0 attachments, so attachment availability after restore was not proven; a database dump never includes S3/R2 objects.

No production migration, production data change, real supplier/customer message, OGS owner provisioning or production deployment was performed.
