# Email intake and sending

Two paths are implemented:

- **Gmail** — OAuth connection, history/polling sync, optional Pub/Sub push.
- **Microsoft 365 / Outlook** — OAuth connection, Graph delta sync, optional change-notification subscription renewal.
- **Forwarding endpoint** — `POST /api/webhooks/inbound-email` with the `INBOUND_EMAIL_SECRET` shared secret,
  for providers that can post JSON.

## Configuration

| Purpose | Variables |
|---|---|
| Gmail OAuth | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` (optional), `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_VERIFICATION_TOKEN` |
| Microsoft OAuth | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, `GRAPH_WEBHOOK_CLIENT_STATE` |
| Forwarding | `INBOUND_EMAIL_SECRET` |
| Sender identity | `COMPANY_EMAIL_FROM` |

Redirect URIs default to `${APP_URL}/api/integrations/gmail/callback` and
`${APP_URL}/api/integrations/microsoft/callback`. Connect the mailbox in **Settings → Email**.

## Intake behaviour

- A provider retry is idempotent: `Message.externalMessageId` is unique.
- Excluded contacts (family/personal) are checked before the body, subject, attachments or any job is stored.
- An unknown sender is classified locally and sent to owner review; it is not sent to an AI provider unless
  `AI_FOR_UNKNOWN_SENDERS=true`.
- Attachment types are content-sniffed and capped by `MAX_UPLOAD_MB` (effective maximum 12 MB).

## What is verified here

OAuth, sync and send code paths are exercised only in their unconfigured/mock form. **No live Google or
Microsoft credentials were available**, so onboarding, token refresh and provider delivery must be verified
in your own accounts. In demo mode, sending is simulated and no provider request is made.

## Multi-company update (2026-11-19)

Gmail and Microsoft 365 are connected per organization. Gmail push notifications are routed by the
mailbox address saved on the owning integration; Microsoft subscriptions use signed
`org:<organizationId>:<secret>` clientState. An unmatched notification is discarded, never processed
against another company's mailbox. Inbound forwarding now requires `x-organization-slug`; older
forwarders without a workspace are rejected. Outgoing mail always uses the authenticated company's
connected mailbox and sender identity. Live OAuth verification still requires provider credentials.

## Automatic supplier reply ingestion (21 November 2026)

Gmail and Microsoft 365 synchronization now inspects inbound mail for supplier replies. Correlation order is: provider message/thread id, `In-Reply-To`/`References`, stored `RFQ-` token, then sender identity. Subject similarity alone never attaches a reply to an RFQ. Confident matches create an UNVERIFIED supplier offer draft; ambiguous cases are marked NEEDS_REVIEW and shown at `/suppliers/replies`; unmatched supplier mail is retained rather than discarded.

Outbound RFQs still require owner approval, and a supplier reply never approves an offer, purchase order or customer quotation. See `docs/SUPPLIER_EMAIL_INGESTION.md`.
