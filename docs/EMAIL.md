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
