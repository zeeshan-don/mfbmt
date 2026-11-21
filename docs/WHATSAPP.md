# WhatsApp intake and sending

MFBMT uses the official **WhatsApp Business Platform (Meta Cloud API)** only. It cannot read a personal
WhatsApp inbox, chat history or groups, and it does not use unofficial clients.

## Setup

1. Create/confirm a Meta app and a WhatsApp Business Account with a dedicated business number.
2. Set the app-level variables in `.env`:
   - `META_APP_ID`, `META_APP_SECRET`
   - `META_EMBEDDED_SIGNUP_CONFIG_ID` (and `..._COEXISTENCE` if your account uses it)
   - `WHATSAPP_VERIFY_TOKEN` (any random string; enter the same value in the Meta app)
   - `APP_URL` (public HTTPS origin)
3. Start the app, sign in as owner, open **Settings → WhatsApp** and complete Embedded Signup.
   Per-account credentials are stored encrypted; they are not shared with other accounts.
4. In Meta, subscribe the webhook to `https://<APP_URL>/api/webhooks/whatsapp` and verify it.

## What is verified here

The code verifies `X-Hub-Signature-256` with `META_APP_SECRET`, stores a durable `WebhookEvent` before
acknowledging, deduplicates by provider message id, and downloads media in the worker with retry. Those
paths are covered by tests/mocks. **No live Meta call was made in this build** because no production
credentials were available; confirm onboarding in your own account before promising it to a customer.

## Sending rules

- Supplier requests and customer quotations require an owner approval before sending.
- Free-form messages are only allowed inside Meta's 24-hour service window; outside it a rejection is
  reported (an approved template is required).
- In demo mode, `sendWhatsAppText` / `sendWhatsAppDocument` return a simulation result and never call
  Meta. The activity log records `*.simulated_sent`.
- A failed send is recorded with the provider error; it is never reported as delivered.

Opt-in, template management and number quality are account-level responsibilities in Meta Business Manager.

## Multi-company update (2026-11-19)

Incoming Meta webhooks now resolve the company from the receiving Phone Number ID and execute inside
that company's tenant context. Each company stores its own WABA ID, Phone Number ID and access token;
a phone ID may be active for only one company. Delivery/read events, duplicate retries and send
failures remain idempotent and tenant-scoped. Embedded Signup state is signed and bound to the
initiating user and organization. Live Meta verification still requires real credentials.

## Intake concurrency and industrial extraction (21 November 2026)

Concurrent messages from one WhatsApp sender now resolve to a single conversation via an atomic database constraint with a unique-violation fallback, instead of a racy read-then-create. This was found by the 30-request synthetic burst. Inbound processing remains idempotent by provider message id, and WhatsApp sending still requires explicit owner approval and the existing template/window rules.

For `INDUSTRIAL` organizations, WhatsApp text and supported attachments feed the OGS industrial extraction path; `GENERAL` organizations keep the existing fastener behavior.
