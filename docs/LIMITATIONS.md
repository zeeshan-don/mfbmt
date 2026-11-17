# Limitations

Everything below is a known, deliberate limit of this build. None of it is disguised in the UI: missing configuration says **Not connected**, missing data says **Needs review**, and incomplete costs say **incomplete** instead of guessing.

## Intake

- **WhatsApp Cloud API only.** The app cannot read an existing personal WhatsApp inbox, chat history or groups. Coexistence between the WhatsApp Business app and the Cloud API is controlled by Meta and varies by account — confirm eligibility in Business Manager before promising it. A dedicated business number is the reliable path. No unofficial clients, session hijacking or scraping.
- **Business-initiated WhatsApp messages** are subject to Meta's 24-hour window/templates. A failed send is reported; it is not retried forever or silently downgraded.
- **Gmail / Microsoft 365** require OAuth app approval. While a Google OAuth app is in testing mode, refresh tokens may expire after 7 days and only test users can connect. Microsoft needs admin consent for `Mail.Read`/`Mail.Send`.
- **Email intake is polling**, not push. Gmail Pub/Sub and Graph change notifications are not implemented; the interval is whatever you schedule (`npm run worker` processes what was queued).
- **Forwarded email** requires a provider that can POST JSON with a shared secret; a plain mail rule that only forwards to an address will not work without that bridge.
- **Attachments**: PDF, XLSX, CSV, JPEG, PNG, WebP and plain text. `.xls`, `.xlsb`, `.doc`, `.docx` and archives are not parsed. HEIC/HEIF photos from iPhones are not decoded — re-send as JPEG.

## Reading documents

- Scanned PDFs with no embedded text are **not OCR'd** here; they are flagged for manual entry. Image OCR uses Tesseract and needs its language data downloaded on first use (no internet → OCR unavailable).
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
- Fractional stock is rejected; multi-UOM conversion (box → pieces) is not performed automatically.
- Reservations are recorded but not enforced against future quotations; two quotations can both reference the same available quantity until an owner converts one.

## Workflow and approvals

- **Approvals are in-app only.** There is no email/WhatsApp approval link and no mobile push. The owner must sign in.
- **No purchase orders, payments or supplier commitments** are created. Approval authorises sourcing and quoting only; the actual purchase happens outside the system.
- **Quotation sending** is gated by a second approval, but the send itself uses the connected mailbox or manual export. No e-signature, no delivery/read tracking beyond provider errors.
- **Quotation versioning** keeps versions, but editing an approved quotation creates a new approval rather than an amendment trail with redlines.
- **One organisation.** Multi-company, multi-branch accounting and inter-company pricing are out of scope.

## Platform

- **Default database is SQLite** (`file:./dev.db`). It suits one server and a small team. It does not support concurrent writers well and must not be shared over a network filesystem. PostgreSQL is documented and supported by the schema, but this build has only been exercised on SQLite.
- **Sessions are cookie-based** with a 7-day lifetime. No SSO, SAML, OIDC or MFA.
- **Account management is minimal**: the owner can create staff accounts, grant areas and deactivate them in Settings. There is no password reset flow (no email link, no "change my password" screen) and no forced password change on first sign-in — reset a password by updating the user's bcrypt hash.
- **No field-level encryption** in the database. Integration tokens are encrypted; business data at rest relies on disk/database encryption.
- **No malware scanning** of uploaded files. Treat attachments as untrusted.
- **No strict CSP with nonces**; other security headers are set. Add CSP at the proxy if required.
- **Notifications are in-app only**; no email/SMS alerts when an approval is waiting.
- **Local disk storage** only. S3/Azure Blob is not implemented; the storage module is the seam for it.
- **Background jobs** run in one process. There is no distributed lock beyond the job table; run a single worker.
- **Observability** is logs and the audit log. No metrics, tracing, or error-tracking service integration.

## Data and demo content

- The seed creates clearly marked **demo** users, suppliers, products and enquiries. They are not automatically removed. Do not run the seed against production data.
- Supplier names, prices and URLs in demo records are fictional or illustrative.
- Audit log retention is unlimited; there is no archival or purge policy configured.

## Not tested here

- No real Meta, Google, Microsoft, AI or search credentials were available, so those calls were exercised only through their error/unconfigured paths. The code follows the documented request/response shapes, but live onboarding must be verified in your accounts.
- No load, penetration or accessibility audit tooling was run. Contrast and focus states were designed for WCAG AA and checked by inspection, not with an automated auditor.
- No production deployment was performed; `docs/DEPLOYMENT.md` describes the expected setup.
