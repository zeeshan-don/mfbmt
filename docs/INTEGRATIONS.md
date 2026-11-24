# Integration setup

All integrations are optional at start-up. The app works with manual intake, inventory imports and manually recorded supplier prices. An integration is shown as **Connected** only after a live test succeeds — saving a key never marks it active.

Credentials go in `.env` (server-side only). OAuth tokens are stored encrypted in the `Integration` table with AES-256-GCM (`CREDENTIAL_ENCRYPTION_KEY`). Nothing secret is sent to the browser.

---

## 1. WhatsApp Business (Meta Cloud API)

### What the code does
- `GET /api/webhooks/whatsapp` verifies `hub.mode`, `hub.verify_token` and echoes `hub.challenge`.
- `POST /api/webhooks/whatsapp` validates `X-Hub-Signature-256` using `META_APP_SECRET` before parsing anything.
- Text, image, document, audio and video message types are parsed; media is downloaded through the official two-step media API.
- `Message.externalMessageId` is unique, so Meta retries cannot create duplicates.
- Business replies are only sent through `sendWhatsAppText` after an owner approval.

### Setup steps
1. Create a Meta app at <https://developers.facebook.com/apps> with the WhatsApp product.
2. Add a **WhatsApp Business Account** and a phone number to it.
3. Copy the **Phone number ID**, **WhatsApp Business Account ID**, and generate a **permanent access token** for a system user with `whatsapp_business_messaging` (and `whatsapp_business_management` if you manage templates from here).
4. Put these in `.env`:
   ```
   META_APP_SECRET=
   WHATSAPP_ACCESS_TOKEN=
   WHATSAPP_PHONE_NUMBER_ID=
   WHATSAPP_BUSINESS_ACCOUNT_ID=
   WHATSAPP_VERIFY_TOKEN=<random string you choose>
   META_GRAPH_API_VERSION=v21.0
   ```
5. Expose the app over HTTPS (a tunnel is fine while testing) and register the callback URL:
   `https://your-host/api/webhooks/whatsapp` with the same verify token.
6. Subscribe the app to the `messages` webhook field for that business account.
7. Open **Settings → Connections → WhatsApp Business** and press **Test connection**. It calls the Graph API for the phone number's display name and quality rating. Only then is it marked connected.
8. Send a real message to the number and confirm it appears under **Enquiries**.

### Important limitation: the owner's personal WhatsApp inbox
The Cloud API receives messages sent **to the connected business number**. It cannot read an existing personal WhatsApp inbox, personal chat history, or groups.

Meta has been rolling out **coexistence** between the WhatsApp Business app and the Cloud API for eligible business accounts. Eligibility, supported features and onboarding differ by account and change over time — verify the current status in Meta's official Cloud API documentation and in your Business Manager before relying on it. If your current number is a personal number that cannot be onboarded, the supported alternative is a **dedicated business number** connected to the Cloud API. This application never uses WhatsApp Web automation, session cookies or unofficial access.

### Family and personal messages
- Add the number under **Settings → Family and personal contacts**. Category `FAMILY`, `PERSONAL` or `OTHER` means:
  - no enquiry is created,
  - no supplier search runs,
  - no automated reply is sent,
  - the message body is not retained (`bodyRetained = false`); only a minimal audit entry remains.
- `TRUSTED_SUPPLIER` and `CUSTOMER` entries do not suppress messages.

### Message window
WhatsApp only allows free-form business messages inside the 24-hour customer service window (starting from the customer's last message). Outside that window Meta requires an approved template. This app sends a supplier RFQ on WhatsApp only after the owner approves the send; the send is a plain text message, so if Meta rejects it the job is marked failed with Meta's reason and the RFQ must be sent from the WhatsApp Business app or by email instead. No template is created or sent automatically.

---

## 2. Email intake

### Option A — Gmail (official API)
1. In Google Cloud Console create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. Requested scopes: `gmail.readonly` and `gmail.send` (plus `openid`, `email`).
3. Create an **OAuth client ID** (Web application) with redirect URI:
   `https://your-host/api/integrations/gmail/callback` (and `http://localhost:3000/...` for local work).
4. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`, and `EMAIL_INTAKE_PROVIDER="gmail"`.
5. In **Settings → Connections → Gmail** press **Connect Gmail**, sign in with the company mailbox, then **Test connection**.
6. Set `EMAIL_FILTER` (default `is:unread newer_than:2d`) to the search that identifies enquiry mail. Only matching messages are fetched.
7. Press **Check mailbox now** or call `syncEmailIntake()` from your scheduler.

Notes:
- While the OAuth app is in "Testing" mode, Google limits sign-in to added test users, and refresh tokens for external apps may expire after 7 days. Publish/verify the app for lasting access.
- Reading is read-only plus send. The app never deletes, labels or moves mail.
- Post-retrieval filtering does **not** narrow the OAuth permission; the granted scope is the limit. The interface says exactly which scopes are requested.

### Option B — Microsoft 365 / Outlook (Microsoft Graph)
1. Register an app in Microsoft Entra ID. Add a **Web** redirect URI: `https://your-host/api/integrations/microsoft/callback`.
2. Grant delegated permissions `Mail.Read`, `Mail.Send`, `offline_access`, `User.Read` (admin consent recommended).
3. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, `EMAIL_INTAKE_PROVIDER="microsoft365"`.
4. Connect and test in Settings. `EMAIL_FOLDER` selects the mail folder (default `inbox`).

### Option C — Forwarding / inbound webhook
If you do not want to connect a mailbox:
1. Set `INBOUND_EMAIL_SECRET` to a long random string.
2. Configure your mail provider or forwarding service to POST JSON to `https://your-host/api/webhooks/inbound-email` with header `x-inbound-secret`.
3. Body format:
   ```json
   {
     "messageId": "<provider message id>",
     "from": "customer@example.com",
     "fromName": "Customer",
     "subject": "RFQ 123",
     "text": "Please quote 20 pcs SS316 elbow 1 inch",
     "receivedAt": "2026-11-17T08:00:00Z",
     "threadId": "optional-thread-id",
     "attachments": [{ "filename": "list.pdf", "contentBase64": "..." }]
   }
   ```
4. The same classification, exclusion and storage rules apply.

### Duplicates and attachments
Every email is keyed by its `Message-ID` (or provider id). Attachments are content-sniffed, size-limited and only accepted types are stored. Forwarded enquiries are still read as data.

---

## 3. AI reading service

The AI layer is a replaceable adapter (`src/lib/ai/provider.ts`) using an OpenAI-compatible Chat Completions API with `response_format: json_object`.

```
AI_PROVIDER=openai          # openai | gemini | none
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

- Any compatible gateway works by changing `AI_BASE_URL` and `AI_MODEL`.
- **Gemini (free tier available)**: Set `AI_PROVIDER=gemini`, `AI_API_KEY=<your-gemini-key>`, `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `AI_MODEL=gemini-3.1-flash-lite`. Gemini's free tier provides 15 requests/minute and 1,500 requests/day at no cost.
- Every response is validated with zod. Invalid JSON or missing required fields is rejected; the app falls back to the deterministic parser and flags the enquiry for review.
- Without a key the integration shows **Not configured**, the built-in parser is used, and affected enquiries are marked "read without AI assistance — please check".
- A consumer ChatGPT subscription does **not** include API access; you need an API key from the provider.
- The AI never sees supplier costs, customer data beyond the message under review, or any secret. Prompts include a hard rule that document text is data, never instructions.

Test in **Settings → AI reading service → Test connection**: it asks for a fixed JSON shape and validates the reply.

---

## 4. Web search for supplier discovery

```
WEB_SEARCH_PROVIDER=none    # none | tavily | serper | brave
TAVILY_API_KEY=
SERPER_API_KEY=
BRAVE_SEARCH_API_KEY=
SEARCH_MAX_RESULTS=8
SEARCH_REQUEST_TIMEOUT_MS=15000
```

- **Automatic fallback**: Tavily is tried first. If it fails (quota exhausted, auth error, rate limit, or network error), the system automatically falls back to Serper, then Brave. Set multiple API keys to enable fallback. The provider used is recorded in the search results.
- Official APIs only: Tavily (`POST https://api.tavily.com/search`), Serper (`POST https://google.serper.dev/search`), Brave (`GET https://api.search.brave.com/res/v1/web/search`).
- Results are recorded with URL, title, snippet, displayed price text, retrieval time and the query used.
- Up to five result pages are fetched for evidence. Fetching checks `robots.txt`, blocks private/loopback hosts, caps response size and timeout, and honours HTTP errors.
- A listing without a visible price is stored as a potential source, never as a price.
- Marketplace APIs are deliberately **not** wired to guesses: the `B2B_MARKETPLACE` adapter reports `NOT_CONFIGURED` until real API access and terms are available.

---

## 5. Photo and scan reading (OCR)

```
OCR_PROVIDER=auto    # auto | tesseract | none
```

- Images (JPEG/PNG/WebP) are read with Tesseract.js. Language data is downloaded on first use; if that fails the image is kept for manual entry and the enquiry is flagged.
- HEIC/HEIF photos are converted with `sharp` when the native build supports the format; if conversion fails the image is kept and the note asks for a JPEG or manual entry.
- A scanned PDF with no embedded text is rendered page-by-page and read with Tesseract OCR when enabled. If OCR is disabled or language data is unavailable, it is marked **needs review** with an explicit note. It is never silently skipped and nothing is invented.

---

## 6. Currency rates

```
EXCHANGE_RATE_PROVIDER=none          # none | exchangerate_host | frankfurter | fixed
EXCHANGE_RATE_API_KEY=
FIXED_USD_AED=3.6725
```

- `fixed` supports the USD/AED peg and triangulates other conversions only between USD and AED.
- `exchangerate_host` calls the documented conversion endpoint with your access key.
- The rate and timestamp are stored on `ExchangeRate` and in the offer's landed-cost snapshot.
- **No rate, no comparison**: cross-currency totals are marked incomplete instead of using an assumed rate.

---

## 7. File storage

```
STORAGE_ROOT=./storage
MAX_UPLOAD_MB=12
UPLOAD_LINK_TTL_MINUTES=10
```

Attachments and quotation PDFs are stored under `STORAGE_ROOT`. Downloads go through `/api/files/[id]` and require a signed-in user or an HMAC-signed expiring token. Back up this folder with the database.

---

## Connection status meaning

| Shown | Meaning |
|---|---|
| **Connected** | A live test succeeded and was recorded with a timestamp |
| **Needs attention** | Credentials exist but the test failed; the reason is shown |
| **Not connected** | Missing configuration — setup guidance is displayed |
| **Disconnected** | Credentials were removed (e.g. mailbox disconnected) |

## Multi-company update (2026-11-19)

Every integration row is organization-scoped, with a composite unique `(organizationId, key)` and
per-company encrypted credentials. Application-level provider app credentials may be shared; customer
WhatsApp/mailbox credentials are never shared. Attendance routing: WhatsApp by Phone Number ID, Gmail
push by the saved mailbox address, Microsoft Graph by signed per-organization `clientState`, inbound
email forwarding by explicit `x-organization-slug`. See `docs/MULTITENANCY.md`.

## Outlook connection state

`Integration` (`key = MICROSOFT365`) keeps non-secret mailbox metadata in `configJson`: connected provider, authenticated mailbox address, display name, Graph user id, verified tenant id, mailbox mode (`user`), monitored folder, granted scopes, sending-enabled flag, first-scan status and window, delta cursor, subscription id/expiry, push status/error, last attempt/success, last error and cumulative sync counters. Tokens live only in encrypted `secretsJson`.

The Settings card shows the real mailbox identity and actual counts from the database (email messages, email enquiries, supplier replies, ignored messages, attachments needing review). It never shows a green Connected badge from the mere presence of a token: integration health requires a successful provider identity check and an active connection status.
