# AI RFQ-to-Quote Automation Blueprint

## Executive decision

Do not rebuild this product as a generic chatbot, a web crawler, or an open buyer marketplace. Build one dependable **RFQ-to-quote operating system for industrial distributors and trading companies**: receive enquiries, understand every supported source, check the company's stock, source shortages, obtain supplier quotes, compare landed costs, and prepare a customer quotation for approval.

The uploaded codebase already has most of the workflow skeleton. The highest-value work is to finish its missing integrations, improve extraction quality, make supplier evidence auditable, and prove the flow against real RFQs before selling automation as a promise.

## What exists in this repository

- Inbound messages and attachments are recorded in the app's enquiry workflow.
- PDF text extraction, scanned-PDF OCR, image OCR, XLSX/CSV/DOCX/ZIP text extraction exist.
- Industrial and fastener attribute schemas and deterministic inventory matching exist.
- Supplier sourcing adapters exist for Tavily, Serper and Brave; page fetches and public contact extraction exist.
- Costing and offer ranking code exists; missing freight/FX/MOQ inputs are intended to keep an offer incomplete instead of silently treating unknown costs as zero.
- Gmail and Microsoft 365 integration plumbing exists, including OAuth-based intake/send paths.
- A database-backed job/worker design exists for work that should not run inside a web request.

These code paths are not the same thing as a live, connected production service. In `.env.example`, AI and web search default to `none`, credentials are blank, and Gmail/Microsoft OAuth must be set up by the operator. The readiness report in this repository also states that live integrations and real-message accuracy have not been proven.

## Gaps this implementation pass addressed

1. **Inventory import redirect handling:** Next.js `redirect()` is a control-flow exception. The inventory preview/import actions had redirects inside `try` blocks, allowing the catch block to misreport a redirect as an import error. Redirects after successful work are now outside the try blocks.
2. **Search fallback and coverage:** the web adapter previously stopped after the first provider that returned any results, even if only one or two candidates. It now continues to another configured index when candidate coverage is still thin and deduplicates URLs.
3. **Agent-oriented web retrieval:** Brave now uses its LLM Context endpoint, which returns ranked pre-extracted page chunks and source URLs for an agent, rather than only standard search-result snippets.
4. **Configurable evidence fetch:** the page evidence limit now uses `SEARCH_PAGE_FETCH_LIMIT` (bounded to 0–20) instead of a hard-coded five.
5. **Actual image input to AI:** the optional `AI_VISION_MODEL` path now compresses image attachments and scanned-PDF page renders and passes them as multimodal image inputs in the OpenAI-compatible Chat Completions request. Sampling text-based PDFs for embedded drawings is an additional opt-in via `AI_VISION_PDF_SAMPLE_TEXT_PDFS=true`, because it adds vision-token cost. OCR and digital text extraction remain the default low-cost paths. Visual data URLs are transient and are not stored in the database.
6. **Honest vision cost reporting:** a separate vision-model input/output rate can be configured. If those rates are blank, that model's cost is stored as unknown rather than falsely recorded as zero.

## Current source-audit correction to the older readiness report

`docs/OGS_READINESS_REPORT.md` is dated 21 November 2026. It is a historical snapshot and some “not built” bullets are no longer accurate for the source tree in this uploaded ZIP. The current source contains supplier prospect discovery, draft supplier RFQs, owner/standing-policy gated supplier sending, supplier reply correlation, deterministic reply-term extraction, pricing memory, customer quotation drafts and approvals, and PDF/XLSX quotation export (`src/lib/suppliers/prospects.ts`, `src/lib/workflow/supplierQuotes.ts`, `src/lib/workflow/supplierReply.ts`, `src/lib/pricing/memory.ts`, `src/lib/workflow/quotations.ts`).

However, the existence of code is not evidence of a reliable live end-to-end service. Two important quality gaps remain in the exact source inspected:

- **Supplier reply attachments are stored, not interpreted.** `ingestSupplierReply()` extracts commercial terms from the email body with deterministic patterns. It saves PDFs/images/spreadsheets attached to a supplier reply, but this function does not run `extractDocument()` or the multimodal model over those attachments. Supplier price lists and PDF quotations can therefore remain unread.
- **Supplier web pages are not yet semantically parsed by an LLM.** `runSourcingForItem()` gets search context, fetches a limited number of public HTML pages and applies deterministic text/regex extraction for price, MOQ, specs and lead time. It does not yet make a structured AI extraction pass over all page tables and excerpts. The regex result is useful evidence, not a guarantee that every catalogue layout or pack/unit basis is understood.

The quotation engine and supplier communication flow are code-present, but live provider credentials, real supplier reply formats, reliability, and production deployment remain unverified. This distinction matters: do not treat the 21 November readiness report or the newer source code alone as an operational go-live certificate.

## Target architecture: one controlled pipeline

```text
EMAIL / WHATSAPP / MANUAL UPLOAD
             |
             v
      INTAKE + DEDUPLICATION
             |
             v
  FILE-TYPE ROUTER + SAFE EXTRACTION
  PDF text | scanned-PDF render/OCR/vision
  XLSX/CSV cells | DOCX text | image OCR/vision
             |
             v
     STRUCTURED RFQ EXTRACTION
  item, qty, unit, code, brand, size, grade,
  material, standard, pressure, schedule, source ref
             |
             v
    VALIDATION + NORMALIZATION
  Zod schema + confidence + required-field rules
             |
             v
       INVENTORY MATCHING
  exact SKU / exact technical spec / candidate search
       |                         |
       | stock available         | shortage / no match
       v                         v
  RESERVE / PICK LIST       EXTERNAL SOURCING
                            Brave LLM Context
                            Tavily/Serper fallback
                            official supplier pages
                                  |
                                  v
                         SOURCE + SPEC VALIDATION
                         domain, manufacturer, grade,
                         standard, size, price, MOQ,
                         currency, stock, lead time,
                         shipping, validity, evidence
                                  |
                                  v
                         PRICE MISSING? -> DRAFT RFQ
                         to verified supplier contacts
                                  |
                                  v
                         HUMAN APPROVAL / POLICY GATE
                                  |
                                  v
                         GMAIL / MICROSOFT SEND
                                  |
                                  v
                         SUPPLIER REPLY INTAKE
                         thread/RFQ ID correlation
                                  |
                                  v
                         OFFER EXTRACTION + REVIEW
                                  |
                                  v
                         LANDED-COST COMPARISON
                         currency + MOQ + freight + fees
                                  |
                                  v
                         CUSTOMER QUOTE DRAFT
                         margin floor + revision + approval
                                  |
                                  v
                         SEND + FOLLOW-UP + OUTCOME
```

### Non-negotiable engineering rules

- The model proposes extracted fields; code and schemas validate them. The model must not invent a product grade, size, quantity, price, stock status, certificate, lead time or delivery promise.
- A semantic or fuzzy search is for *candidate recall*, not technical equivalence. Final stock match needs exact required attributes or explicit human approval of a substitute.
- Every extracted value should retain a source pointer: inbound message, filename, PDF page, spreadsheet sheet/row, or supplier URL/quote email.
- Every web price must be accompanied by source URL, retrieval timestamp, currency, unit basis and the text that supports the parsed amount. A price without a clear pack size/unit or MOQ is not comparable.
- Separate list prices, marketplace prices and supplier-confirmed quotes. Do not treat a web listing as a firm offer.
- Only contact suppliers whose official business identity and public contact address can be verified. Draft first; send after approval or a company-configured policy. Never bulk-email arbitrary scraped addresses.
- Never auto-issue a customer quotation or purchase order from an unverified supplier reply.
- Never scrape behind login, bypass paywalls, evade anti-bot controls or ignore robots.txt. “The whole internet” is not a real, accessible dataset: indexes cover public and indexable pages, not every private, blocked, unindexed or dynamically protected source.

## Recommended provider setup

### 1. AI extraction and vision

Use two model tiers at the existing OpenAI-compatible endpoint. For routine text extraction and classification, start with `gpt-6-luna` ($0.10 input / $0.50 output per 1M text tokens). For photographs, product images and technical drawings, use `gpt-6.1-terra`, which OpenAI specifically positions for visual reasoning and interpreting technical drawings ($1.00 input / $5.00 output per 1M text tokens). Both accept image input through Chat Completions. The app sends images only when a vision model is configured and caps them at four per enquiry. These rates are the current standard published token rates; check billing before go-live because image tokenization, processing tier and account terms affect the actual amount. The request builder sets `reasoning_effort=low` for GPT-5/GPT-6/o-series models and omits `temperature` when reasoning effort is not `none`, in line with current API guidance.

Suggested initial environment (direct OpenAI API):

```env
AI_PROVIDER="openai"
AI_API_KEY="<API key with API billing enabled>"
AI_BASE_URL="https://api.openai.com/v1"
AI_MODEL="gpt-6-luna"
AI_VISION_MODEL="gpt-6.1-terra"
AI_VISION_PDF_SAMPLE_TEXT_PDFS="false"
AI_REASONING_EFFORT="low"
AI_INPUT_COST_PER_1M_USD="0.10"
AI_OUTPUT_COST_PER_1M_USD="0.50"
AI_VISION_INPUT_COST_PER_1M_USD="1.00"
AI_VISION_OUTPUT_COST_PER_1M_USD="5.00"
```

If using another OpenAI-compatible gateway, use its base URL and confirm that the selected model accepts Chat Completions `image_url` content parts. A ChatGPT subscription is not itself an API key. Images count toward model input usage and are billable. Do not set the vision rates to zero just to clear the warning; use the actual model price or leave them blank to record unknown cost.

For the lowest operating cost, keep the OCR/text path first. Only send image inputs when there is a photo, diagram, unreadable scan or layout that OCR/text extraction cannot confidently resolve. The current code path caps visual inputs at four per enquiry.

### 2. Web supplier discovery

Recommended primary:

```env
WEB_SEARCH_PROVIDER="brave"
BRAVE_SEARCH_API_KEY="<Brave Search API key>"
BRAVE_SEARCH_COUNTRY="ae"
BRAVE_SEARCH_LANG="en"
SEARCH_MAX_RESULTS="8"
SEARCH_MAX_QUERIES="4"
SEARCH_PAGE_FETCH_LIMIT="5"
```

Brave LLM Context is a good fit because it returns ranked extracted page chunks and source metadata intended for AI agents. Keep Tavily configured as a secondary provider if supplier coverage is insufficient or Brave is rate-limited. Tavily's own documentation distinguishes Basic search (one credit) from Advanced search (two credits) and recommends searching broadly, selecting the useful URLs, then extracting only those pages for deeper content. Do not pay to deeply extract every irrelevant result.

For this type of RFQ, search queries should be generated from *technical identity*, not generic product names:

- exact manufacturer part number / OEM code, with quotes;
- exact standard + grade + dimensions;
- equivalent manufacturer / model family;
- product type + standard + size + UAE/GCC supplier;
- manufacturer/distributor domain restrictions for verification.

Use the first pass for recall. Then fetch only the best 5–10 candidates for evidence, favoring the manufacturer's official site and established distributor domains. A secondary extraction service such as Tavily Extract or Firecrawl should be added only when real pages repeatedly defeat the built-in static HTML reader (e.g. JS-rendered catalogues or deep technical PDFs). It is not necessary to buy three overlapping search vendors on day one.

### 3. Email intake and supplier communication

Pick the mailbox the distributor already uses:

- Gmail: connect through Google OAuth with only the required read/send scopes. Google documents `gmail.readonly` for reading and `gmail.send` for sending; public apps using sensitive/restricted scopes may need OAuth verification.
- Microsoft 365: connect through delegated Microsoft Graph `Mail.Read` and `Mail.Send`, with tenant admin consent where required.

Use a dedicated sales/procurement mailbox. Correlate supplier replies using thread/message identifiers and a unique RFQ reference in the subject/body. Parse messages and attachments, but mark every supplier offer as `UNVERIFIED` until a staff member checks it. Keep send caps, suppression lists, bounce handling and audit logs.

### 4. Structured document processing

Keep the current deterministic parsers for XLSX/CSV and digital PDF text. Keep Tesseract for cheap OCR. The new visual path should act as a targeted fallback for pictures and scanned PDF pages where visual layout matters. Excel should be parsed as workbook data, not converted to a screenshot and sent wholesale to the model.

Only consider a dedicated document AI service (for example Google Document AI custom extraction) after measuring enough recurring document formats to justify processor setup and training. It is not a replacement for industrial product-spec validation or inventory matching.

## Competitive reality and the positioning decision

Public UAE market research shows that “read an RFQ, source suppliers, compare offers and prepare a quote” is already being marketed. Spares International publicly describes handling RFQs, BOQs, spreadsheets, photos and drawings, plus controlled sourcing and price memory. Sorsivo markets RFQ-to-quote software for UAE distributors, including supplier-offer comparison and landed-cost components, with guided implementation. These are vendor-published claims, not independently audited product-performance results.

That means the app should **not** position itself as the first AI that reads RFQs or searches suppliers. That is not a defensible moat. The stronger wedge is to own one distributor's real operating data: normalized inventory and variants, trusted supplier identities, technical compliance history, previously confirmed prices and expiry dates, negotiated terms, freight/FX/MOQ rules, and a complete auditable path from RFQ to approved quote. Start with a narrow category where technical mistakes are costly (for example, fasteners or valves/fittings), prove accuracy, then expand. The differentiator is dependable execution and organization-specific sourcing memory—not a bigger prompt or more search results.

## Product and commercial focus

The buyer is not a generic consumer. The first paying customer should be an industrial distributor/trading company that receives many RFQs by email and WhatsApp, keeps stock in spreadsheets or a basic ERP, and spends time finding products and chasing supplier prices.

Sell the outcome:

> “Forward an RFQ in any supported format. The system turns it into checked line items, shows what is in stock, finds verified supplier options for shortages, chases missing prices through your approved mailbox, compares the landed cost, and prepares a quote for your salesperson to approve.”

Avoid claiming “automatic procurement” or “AI understands every drawing” until the measured pilot proves it. Offer a paid, supervised pilot rather than a free unlimited account:

1. One distributor, one inbox/WhatsApp business number, one inventory import, and one product category first (e.g. fasteners or valves/fittings).
2. Charge a one-time onboarding/data-cleanup fee. The amount is a pricing hypothesis to test with customers, not a verified market rate.
3. Charge a monthly subscription based on processed RFQs, team seats and sourcing volume; cap included supplier searches and attachments to protect gross margin.
4. Keep complex sourcing as a paid managed add-on until automated supplier identity, pricing and replies are consistently accurate.
5. Expand categories only after the first vertical has measurable quote speed and conversion improvement.

A reasonable pricing experiment is three plans (Pilot, Team, Operations) with different RFQ/month and user caps, plus a one-time setup fee. Do not fix final AED prices from competitor websites alone. Interview and sell to 5–10 distributors, secure 2–3 paid pilots, and price against documented labour/time saved and additional quotes sent. The app should report those outcomes to prove renewal value.

## Production gate: tests that must pass before claims or auto-send

Build a real, labelled benchmark set from anonymized customer RFQs and supplier quotes, with at least:

- 50 WhatsApp/email text enquiries;
- 30 digital PDFs and 30 scanned/photo PDFs;
- 30 images (including handwriting, tables, labels and drawings);
- 30 Excel files with single/multiple sheets, merged headers, formulas and units;
- 100 line items across fasteners, valves, pipes, fittings, flanges, gaskets and chemicals;
- 30 supplier replies including attachments and different quote layouts.

Measure per-field exact accuracy for SKU/part number, description, quantity, unit, size, material, grade, standard, price, currency, MOQ and lead time. Measure exact-spec inventory match precision separately from recall. Track false matches as the most expensive error. Include adversarial tests: prompt injection inside PDF, fake web pages, malicious URLs/SSRF, duplicate emails, wrong currency/unit, superseded quote, invalid certificate and supplier impersonation.

Release criteria:

- 100% source pointer coverage for extracted fields used in a quotation;
- zero fabricated prices/stock/lead times in the test set;
- zero automatic substitution when required technical attributes conflict;
- zero supplier auto-send to unverified contacts;
- every low-confidence / incomplete / conflicting line item routes to review;
- inbox idempotency and retry tests pass;
- end-to-end tests include real API keys and a real test mailbox before enabling auto-send;
- worker retries, dead-letter/replay, alerting, backups and restore drills pass.

## Important current limitation

This pass changed source code and documentation, but the uploaded ZIP did not contain the deployed environment secrets or live customer/provider accounts. The previous dependency install timed out and the local TypeScript check could not complete because the install was incomplete. Therefore the changes are **not yet typechecked, integration-tested with live keys, deployed, or production-certified**. Run the repository's full `npm run check` after a complete `npm ci`, then test the exact image, search, email and supplier reply flows in staging before enabling them for customers.

## Official technical references

- OpenAI image input / Chat Completions: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI GPT-6 Luna model details and pricing: https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI GPT-6.1 Terra visual reasoning and pricing: https://developers.openai.com/api/docs/models/gpt-6.1-terra
- OpenAI reasoning API parameter guidance: https://developers.openai.com/api/docs/guides/deployment-checklist
- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- Brave LLM Context: https://api-dashboard.search.brave.com/documentation/services/llm-context
- Tavily Basic vs Advanced: https://help.tavily.com/articles/6938147944-basic-vs-advanced-search-what-s-the-difference
- Spares International FZE (UAE RFQ/sourcing offering): https://sparesinternational.com/
- Sorsivo (UAE RFQ-to-quote offering): https://sorsivo.com/
- iSupply UAE (RFQ marketplace model): https://isupply.ae/
- Tavily extraction guidance: https://help.tavily.com/articles/3363168593-extracting-web-content-using-tavily
- Gmail send method: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Gmail OAuth scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google Document AI custom extractor: https://docs.cloud.google.com/document-ai/docs/custom-extractor-overview
