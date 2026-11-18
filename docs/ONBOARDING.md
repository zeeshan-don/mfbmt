# Owner onboarding

Open **/onboarding** after the first sign-in. The checklist reflects verified state, not a decorative
completion flag.

| Step | What counts as done |
|---|---|
| Company details | Legal name/address/email and either TRN or legal name are recorded |
| Owner account | Signed in as an owner |
| WhatsApp | A real per-account connection exists (`CONNECTED`) |
| Email | Gmail or Microsoft 365 reports `CONNECTED` |
| AI document reading | Provider configured **and** the stored integration has been tested successfully |
| Supplier web search | A provider and its key are configured |
| Inventory or sourcing-first | Stock imported/configured **or** the organization policy is `SOURCING_FIRST` |
| Supplier directory | At least one supplier recorded |
| Pricing rules | At least one active rule exists (otherwise every price must be entered manually) |
| Personal contacts | Exclusion list is populated (optional, but recommended) |
| Background worker | A fresh `WorkerHeartbeat` exists. Zero failed jobs does **not** count |

## Worker

Run `npm run worker` as a long-lived process. It writes a heartbeat on every poll and every job, renews
job leases, and recovers expired leases. `/api/health` and the app shell show **Active**, **Not responding**
or **Unknown** from that heartbeat only.

If the worker is not running:

- queued extraction, stock checks, sourcing, e-mail sync and sends do not move;
- the dashboard shows the queue depth and a warning;
- onboarding step 11 stays open.

## Demo onboarding

`DEMO_MODE=true` + `SEED_DEMO_DATA=true` + `npm run db:seed` creates demo accounts, suppliers, products and
two walkthrough enquiries. The password is displayed only on the demo sign-in page; it is never printed by
the seed and never available in production builds. Replace the demo accounts and password before real use.
