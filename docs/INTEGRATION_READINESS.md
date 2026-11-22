# Integration readiness — 22 November 2026

This is a configuration and code-readiness report, **not** a live-delivery
certificate. Nothing below was sent to a real customer or supplier.

| Service | Configuration | Live proof | Status |
| --- | --- | --- | --- |
| PostgreSQL | Isolated Docker PostgreSQL 16 reachable; migrations applied | Local test only | **TEST PASS; production not tested** |
| S3 / R2 | Local storage used; no sandbox bucket credentials in this audit | None | **NOT TESTED** |
| Meta WhatsApp | No app/business/number credentials used | None | **NOT TESTED** |
| Gmail | No OAuth client/refresh token used | None | **NOT TESTED** |
| Microsoft 365 | No app registration/admin consent used | None | **NOT TESTED** |
| AI provider | No key used | None | **NOT TESTED** |
| Web search | No key used | None | **NOT TESTED** |
| Exchange rate | No provider key used | None | **NOT TESTED** |
| QStash | Signing/token variables are present enough for `check:config` to pass; no signed request was delivered | None | **CONFIGURED; DELIVERY UNTESTED** |
| Worker daemon | Not started during this audit; queue logic exercised with concurrent claims/leases | None | **LOGIC TESTED; DAEMON UNTESTED** |

`npm run check:config` returned **“Configuration OK for production.”** That only
means the configuration parser found no missing required variables. It does not
validate credentials, provider reachability, OAuth consent, sender identity,
WhatsApp template approval, or actual delivery. `npm run verify:live` was **not**
run because it would make real provider requests and no sandbox credentials were
provided.

## What “tested” would require

- A private S3/R2 bucket and a write/read/delete round trip.
- A Meta test business/number and an approved test template; message to a test
  recipient only.
- Google/Microsoft sandbox mailboxes with `Mail.Read`/`Mail.Send`, including
  revoked-token and timeout cases.
- AI/search/FX sandbox keys with spend caps.
- A signed QStash delivery to the deployed URL, or a local QStash dev receiver.
- A running worker with a fresh heartbeat and a controlled kill/restart.
