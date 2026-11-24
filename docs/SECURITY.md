# Security

This is a small internal tool for one company, but it holds supplier costs, customer identities and owner approvals. The controls below are the ones actually implemented. Anything not implemented is listed in **Limitations** rather than implied.

## Authentication

- Email + password, hashed with bcrypt (cost 12). Passwords are never logged or returned.
- Sessions are database-backed: a random 32-byte token is stored in the `Session` row as a SHA-256 hash and sent in an `HttpOnly`, `SameSite=Lax` cookie. `Secure` is set in production. Sessions expire after 7 days.
- Deactivating a user does not leave them logged in: session lookup requires an active user, and the user's sessions can be revoked.
- **Sign-in throttling**: failed attempts are written to the audit log and counted per email address and per IP over 15 minutes. At 8 failures for an email or 30 for an IP, sign-in is refused for the rest of the window. Because the counter lives in the database it survives restarts.
- The login error message is identical for unknown email, wrong password and deactivated account.

Create the first owner with `npm run provision:owner`. Demo data requires `DEMO_MODE=true` + `SEED_DEMO_DATA=true` outside production and is refused in production regardless of flags. Demo credentials are shown only on the demo sign-in page, never in README, logs, health responses or production builds.

## Authorisation

- Two roles: `OWNER` and `STAFF`. Staff have an explicit permission list; anything not granted is refused.
- Server components and server actions both re-check the session. A hidden button is never the only control: the action verifies role/permissions again.
- Owner-only by default: settings and integrations, sourcing approvals, quotation approval, supplier quotes sending, internal cost/margin visibility, user management, audit log.
- Staff can view enquiries they are working on and prepare data, but cannot approve spend, see supplier cost/margin, or send anything.

## Secrets

- All secrets live in `.env` on the server; only `NEXT_PUBLIC_*` values are ever exposed to the browser, and none are secrets.
- OAuth client secrets and refresh tokens are encrypted with AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY` before being written to `Integration.secretsJson`. Decryption happens only in server code.
- `.env` is git-ignored. `.env.example` contains only placeholders.
- Rotating `CREDENTIAL_ENCRYPTION_KEY` makes stored tokens unreadable; reconnect each integration afterwards.

## Webhook and API security

| Endpoint | Control |
|---|---|
`POST /api/webhooks/whatsapp` | `X-Hub-Signature-256` HMAC-SHA256 over the raw body with `META_APP_SECRET`; constant-time compare; 403 on mismatch.
`GET /api/webhooks/whatsapp` | Verify token checked against `WHATSAPP_VERIFY_TOKEN`.
`POST /api/webhooks/inbound-email` | `x-inbound-secret` compared in constant time; 503 when unset, 401 on mismatch.
`/api/jobs/tick` | `WORKER_SECRET` bearer token; 503 when unset.
`/api/files/[id]` | Signed-in user, or an HMAC token with expiry bound to the file id.
`/api/quotations/[id]/pdf` | Signed-in owner or staff with access; internal cost is excluded from the PDF.
`/api/health` | Public, returns database reachability, verified worker liveness (healthy/stale/unknown) and a timestamp. Queue/storage detail requires `?deep=1` plus the `x-health-token` header matching `WORKER_SECRET`. No secrets or tenant data.
`/supplier-response/<token>` | Token-scoped public page; 24-byte random token; expired/used tokens refused; response writes only to that quote.

Webhook routes are excluded from session checks but are never able to act as a logged-in user. All actions they trigger are recorded with actor `system` plus the provider message id.

## Input handling

- Every server action validates input with zod; free text is length-limited and trimmed. Invalid input produces a field error, not a partial write.
- Uploads are content-sniffed, not trusted by extension. Accepted: PDF, XLSX, CSV, JPEG, PNG, WebP, plain text. Unknown types are rejected. Size is capped by `MAX_UPLOAD_MB` and Next's action body limit.
- Uploaded files are stored under a random name in `STORAGE_ROOT`; the original filename is metadata only, so path traversal is impossible.
- SQL is only executed through Prisma parameters. No raw string interpolation.
- HTML from email bodies is not rendered; text is extracted and escaped by React. Links are opened with `rel="noopener noreferrer"`.
- Page fetching for sourcing evidence validates the URL scheme, resolves DNS, and refuses loopback/private/link-local addresses (SSRF protection), then checks `robots.txt`, caps redirects/size/time.

## AI-specific risks

- Prompt-injection is expected: document and message text is labelled as untrusted data, and the model has no tools and no ability to write to the database.
- Model output is schema-validated; numbers, prices, quantities, MOQs and eligibility are never taken from the model. They are parsed deterministically from the source and computed in code.
- The AI never receives credentials, other customers' data, supplier cost or internal margins.
- Classification of excluded contacts happens before any AI call, so personal message bodies are not sent to a third party.

## Transport and headers

- Run behind HTTPS. The app sets `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive `Permissions-Policy`.
- A strict Content-Security-Policy with per-request nonces is not configured (Next's inline bootstrap scripts would need a nonce pipeline); add one at the reverse proxy if your environment requires it.

## Audit trail

Recorded in `AuditLog` (append-only in the UI):

- sign-in success and failure,
- inbound message received / excluded / duplicate,
- classification, extraction, documented corrections,
- stock check, sourcing run and adapter failures,
- approval decisions with reason,
- supplier quote send, customer quotation approval and send,
- inventory imports and stock adjustments,
- integration connect/disconnect/test and settings changes.

Entries include actor, action, entity, timestamp, IP and a JSON snapshot. The audit log is readable by owners under **Activity** and cannot be edited from the UI.

## Data protection

- Excluded personal/family messages: body not retained, no attachment kept, only a minimal record that a message was received and skipped.
- Customer data stays in the app; nothing is shared with integrations except the specific message sent for interpretation.
- Backups contain the database and attachment folder; treat them as confidential (see `BACKUP.md`).

## Known gaps

See `LIMITATIONS.md`. The important ones: no SSO/MFA, no per-field encryption at rest, no built-in malware scanning of attachments, and no third-party penetration test has been performed. Before exposing the app publicly, put it behind a VPN or an authenticating reverse proxy.

## Multi-company update (2026-11-19)

A fail-closed tenant guard now applies `organizationId` to every tenant read, aggregate, update and
delete, and stamps every create, including nested writes. Tenant context comes only from the session
row or trusted server-side evidence (provider phone ID, mailbox, signed OAuth/Graph state, supplier
token, job row). Browser-supplied organization IDs are ignored. Integration secrets remain
AES-256-GCM encrypted per organization. `tests/tenant-isolation.test.ts` proves cross-company reads
return nothing and credentials do not cross tenants. Platform operators cannot read customer data
through the provisioning CLI.

## Hardening changes (21 November 2026)

Production file storage is private and fail-closed; no public ACL is applied, MIME is detected from content, size limits are enforced, filenames are sanitized, and database ownership is checked before a signed download. Tenant prefixes prevent cross-organization object access, with legacy keys handled by ownership checks.

Owner invitations store only a token hash, are single-use and expire. Provisioning masks password entry, never accepts passwords on the command line, logs an audit record, and refuses cross-tenant email reuse or implicit owner resets.

Integration diagnostics are owner-only and tenant-scoped, display no secrets, and perform no outbound customer/supplier messages. Regression coverage includes cross-tenant file access, supplier reply correlation/isolation, invitation conflicts and diagnostics isolation.

## Microsoft OAuth and mailbox credentials

- Microsoft sign-in uses the Authorization Code flow with PKCE (S256). The `state` value is 192 bits of randomness inside an HMAC-signed, HttpOnly, SameSite=Lax cookie bound to the initiating organisation and owner, expires after 10 minutes, and is deleted before the callback is processed (single use).
- The callback verifies the signed state, the PKCE verifier and the currently signed-in owner's organisation. Mailbox identity comes from Graph `/me`; a typed email address or `login_hint` is never treated as identity proof.
- Access and refresh tokens are AES-256-GCM encrypted with `CREDENTIAL_ENCRYPTION_KEY` and stored per organisation. They are never logged, placed in URLs, or returned to the browser. Decryption failure marks the integration as needing attention instead of pretending it is connected.
- Initial consent requests only `openid profile email offline_access User.Read Mail.Read`. `Mail.Send` is a separate owner action and is re-checked at send time; supplier RFQs remain gated by the existing approval workflow.
- A webhook batch is validated per notification: the per-organisation client state must match the platform secret and the subscription id must belong to that company. Invalid notifications are rejected, never re-routed.
- Email bodies, attachment contents, customer pricing and tokens are never written to logs. Customer-facing errors are sanitised.
