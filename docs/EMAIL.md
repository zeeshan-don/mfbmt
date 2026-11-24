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

## Microsoft Outlook connection (one-click, read-only first)

A company owner connects their own Microsoft 365 mailbox from **Settings → Email intake**. The platform administrator registers the Microsoft Entra application once; individual customers never see OAuth settings or enter a mailbox password.

### Platform administrator setup (once)

1. Register an application in Microsoft Entra ID. Supported account types: accounts in any organisational directory (multi-tenant) for a SaaS deployment, or single-tenant for one company.
2. Add a **Web** redirect URI exactly matching `MICROSOFT_REDIRECT_URI`, e.g. `https://app.example.com/api/integrations/microsoft/callback`. It must be HTTPS in production and must match character for character.
3. Create a client secret and set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (`common`, `organizations`, or a tenant id) and `MICROSOFT_REDIRECT_URI`.
4. Add delegated Microsoft Graph permissions: `User.Read`, `Mail.Read` (initial), and `Mail.Send` (optional, granted later by the owner). `offline_access`, `openid`, `profile` and `email` are requested as OIDC scopes.
5. Grant tenant-wide admin consent only if the customer's Microsoft policy requires it. Otherwise each owner consents during sign-in.
6. Set `GRAPH_WEBHOOK_CLIENT_STATE` to a long random secret. The Graph notification URL is `https://<APP_URL>/api/webhooks/microsoft` and must be publicly reachable over HTTPS. Set `GRAPH_SUBSCRIPTION_MINUTES` (default 4200).
7. Run the worker (`npm run worker`) with `EMAIL_AUTO_SYNC=true`. The worker performs the scheduled delta reconciliation and subscription renewal.

### Scopes

- First connection (read-only): `openid profile email offline_access User.Read Mail.Read`.
- Optional sending, requested only after the owner clicks **Enable email sending**: adds `Mail.Send`.
- `Mail.Read` grants delegated access to the signed-in user's mailbox. MFBMT itself reads only the configured folder, but the permission is mailbox-wide and the consent screen says so.
- Reconnecting read-only preserves an existing `Mail.Send` grant.

### Behaviour

- The OAuth callback verifies the signed, single-use state and PKCE verifier, then reads `/me` from Graph. The mailbox address is taken from the verified Graph identity, never from a form field or `login_hint`.
- Credentials are encrypted with `CREDENTIAL_ENCRYPTION_KEY` and stored per organisation. Tokens never appear in URLs, logs or browser state.
- The callback only verifies the mailbox and queues a durable `SYNC_EMAIL` job. It does not scan the mailbox inline.
- The first scan covers the most recent `EMAIL_INITIAL_SYNC_DAYS` days (default 30, owner-adjustable) using a bounded Graph delta with `$filter=receivedDateTime ge …`. The opaque `@odata.deltaLink` is stored and reused verbatim.
- Scheduled polling is the source of truth. Graph change notifications are an optimisation; push is marked unavailable (not faked) when it is not configured. The webhook validates every notification's per-organisation client state and subscription id, groups a mixed batch by company and queues one durable job per company.
- HTTP 401 triggers one forced token refresh, HTTP 410 rebuilds a bounded delta, HTTP 429/503/504 and network timeouts retry with `Retry-After`/backoff. A cursor is only advanced when a page round completes, so a failed run never skips messages.
- Attachments: file attachments only, paginated, at most 10 per message, a combined byte cap, content sniffing via the existing upload validator, inline signature images skipped, and item/reference attachments reported as unsupported. Extraction uses the current `extractDocument()` pipeline and stores per-file status/notes.
- Shared mailboxes: **not supported in this release**. Delegated shared folders cannot use Outlook change notifications, and MFBMT does not use application-level mailbox permissions. Connect the owner's own mailbox (or forward the shared mailbox to it) instead.
- Disconnect deletes the Graph subscription where possible, clears credentials, cursor and subscription state, and stops scheduling. Historical enquiries, supplier replies, quotations and attachments are retained.

### Common failures shown to the owner

- Microsoft app not configured → the owner sees that Outlook sign-in is unavailable and to contact the administrator.
- Consent denied / sign-in cancelled → no connection is stored.
- Admin approval required (`AADSTS65001`) → actionable message to ask the Microsoft administrator.
- Mailbox inaccessible (403) → reconnect and approve `Mail.Read`.
- Token revoked/expired → integration shows **Needs attention**; reconnect Outlook.
