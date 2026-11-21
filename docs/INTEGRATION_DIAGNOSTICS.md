# Organization-scoped integration diagnostics

`src/lib/integrations/diagnostics.ts` reports, per tenant:

| Field | Meaning |
| --- | --- |
| configured | The app-level credentials/keys for this provider exist. |
| connected | The stored integration row was successfully checked. |
| authenticated | A real provider check succeeded most recently (`lastSuccessAt`). |
| usable | Connected, authenticated and no recorded error. |
| lastCheckedAt / lastSuccessAt / lastSyncAt | Timestamps recorded for this tenant. |
| detail / remediation | What is wrong and the next manual step. No secret values. |

Merely storing credentials never produces `connected`. A new connection is
`NOT_VERIFIED` until a live check succeeds.

## Endpoint

`GET /api/integrations/diagnostics` — owner only, current organization only.
`POST /api/integrations/diagnostics` with `{"key":"STORAGE"}` — runs one explicit
check. Both responses set `Cache-Control: no-store` and never include the
`secretsJson` column, tokens, keys or authorization headers.

Supported keys: `WHATSAPP`, `GMAIL`, `MICROSOFT365`, `AI_PROVIDER`, `WEB_SEARCH`,
`OCR`, `STORAGE`, `EXCHANGE_RATE`.

## Live checks

* Gmail/Microsoft: identity/profile read only.
* WhatsApp: business/phone metadata read; no message is sent.
* AI: one minimal JSON completion.
* Web search: one diagnostic query.
* Storage: write/read/delete a small probe object in the private store.
* Exchange rate: one rate lookup.

Checks are non-destructive and never send a customer or supplier message. They do
not modify credentials or disconnect an integration.

## Tenant isolation

Every read and write goes through the tenant-scoped Prisma client (`getIntegration`
/ `saveIntegration`), so an owner in one workspace cannot see or refresh another
workspace's connection. `tests/integration-diagnostics.test.ts` proves that MFBMT
and OGS do not share integration state and that no secret appears in the response.

## Honest results

If credentials are absent, the result is `NOT_CONFIGURED`. If they exist but no
successful provider check has been recorded, it is `NOT_VERIFIED`. Do not describe
a provider as live until the diagnostic has actually succeeded.
