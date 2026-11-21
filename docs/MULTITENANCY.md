# Multi-company tenancy

Last updated: 2026-11-19

## Tenants

| Tenant | ID | Slug | State |
|---|---|---|---|
| Multi Fasteners Building Materials Trading LLC | `org_mfbmt` | `mfbmt` | Preserved; owns all pre-existing records |
| OGS & Chemicals FZC | `org_ogs` | `ogs` | Independent and empty; legal details must be entered by OGS during onboarding |

No MFBMT record was copied into OGS. No OGS address, phone number, TRN, email address, owner
credential, supplier, product or price was invented.

## Where ownership lives

Every tenant business table has a required `organizationId` foreign key to `Organization`
(`ON DELETE CASCADE`). Unique keys that were global are now organization-scoped, including:

- `User(organizationId, email)`
- `Integration(organizationId, key)`
- `Enquiry(organizationId, publicRef)`
- `Product(organizationId, sku)`
- `Conversation(organizationId, channel, externalId)`
- `Message(organizationId, channel, externalMessageId)`
- `BackgroundJob(organizationId, idempotencyKey)`
- `CustomerQuotation(organizationId, quotationNumber)`
- `NumberSequence(organizationId, scope, period)`
- `AppSetting(organizationId, key)`

The forward migration is
`prisma/migrations/20261119170000_multi_company_tenancy/migration.sql`. It is additive: it adds
columns, backfills every historical row to `org_mfbmt`, changes uniques, adds foreign keys and only
then makes columns required. It never drops or truncates a business table.

## How the tenant is resolved

The application never accepts an organization id from a form, URL parameter or client JavaScript.

1. **Normal requests** — the httpOnly `mfbmt_session` cookie is hashed and looked up in `Session`.
   The session's `organizationId` is authoritative and must match the user's organization and an
   `ACTIVE` organization.
2. **Webhooks, supplier response tokens, OAuth callbacks and jobs** — trusted server code resolves
   the organization from provider evidence (WhatsApp Phone Number ID, Gmail mailbox, signed Graph
   `clientState`, unguessable supplier token, or the job row) and calls
   `runWithTenant({ organizationId, source }, work)`.
3. **No context** — in production, tenant queries throw `TenantContextError`. They do not fall back
   to MFBMT. The only unscoped client is `rawDb`, reserved for sign-in, webhook routing, the worker
   queue, provisioning and migrations.

### Why scoping is caller-side

`src/lib/db.ts` applies `scopeTenantArgs()` immediately before dispatching a Prisma query. It is
deliberately **not** a Prisma query extension: Prisma 6 executes extension callbacks outside the
caller's `AsyncLocalStorage`, which made explicit webhook/job tenants silently fall back to the
default tenant. The isolation suite (`tests/tenant-isolation.test.ts`) proves both directions.

Every read/aggregate/update/delete receives `WHERE organizationId = :tenant`; every create
(including nested relation creates) is stamped with the tenant. `db.$transaction` wraps the
callback's `tx` with the same rules. Raw SQL is not rewritten, so code using `$queryRaw` must pass
the tenant itself (the number sequence allocator does).

## Authentication and roles

- Sign-in requires a workspace slug (`/login?org=ogs`), the user's email and password. The same email
  can exist in two companies without ambiguity; a bare email matching several companies is refused.
- `OWNER` and `STAFF` roles are enforced per organization.
- Suspended organizations cannot sign in, and all their sessions are deleted when suspended.
- Password reset tokens are tenant-bound.
- There is no public organization registration. Tenant provisioning is an operator CLI:

```bash
ORG_ACTION=list npm run provision:org
ORG_ACTION=create ORG_SLUG=ogs ORG_NAME="OGS & Chemicals FZC" npm run provision:org
ORG_ACTION=suspend ORG_SLUG=ogs npm run provision:org
ORG_ACTION=activate ORG_SLUG=ogs npm run provision:org
```

The operator CLI creates no users and grants no access to customer data. Owner invitation is done
with `npm run provision:owner` (supports `ORG_SLUG`), which issues a one-time password-setup link.
A future platform console and audited support-access workflow are not implemented; support staff do
not have an automatic data-access path.

## Organization-specific integrations

Credentials are encrypted with AES-256-GCM and stored in the organization's own `Integration` row.

- **WhatsApp** — each company stores its own WABA ID, Phone Number ID and access token. Incoming
  webhooks are routed by the receiving Phone Number ID (`resolveWhatsAppOrganization`). A phone ID
  may belong to only one active integration. Delivery/read status events, duplicate Meta retries and
  failed sends are handled per company. Embedded Signup state is signed and bound to the initiating
  user and organization.
- **Gmail** — OAuth state is signed and cookie-bound; the callback stores tokens on the authenticated
  organization. Push notifications are routed by the mailbox address saved on that organization's
  integration (`resolveEmailOrganization`). An unroutable notification is ignored with `204`, never
  processed against another company's mailbox.
- **Microsoft 365** — each subscription carries `clientState = org:<organizationId>:<secret>`. The
  webhook verifies the secret, requires all notifications in one request to belong to one company,
  records a durable receipt and queues the delta sync in that tenant's context.
- **Inbound email forwarding** — the shared secret authenticates the sender, and the target company
  must be named explicitly with `x-organization-slug` (or `organizationSlug`). Unknown or inactive
  workspaces are rejected. This is a breaking change for older forwarders that named no workspace.
- **AI, search, FX** — configuration and usage accounting are resolved in tenant context; a company
  never borrows another company's key. Status is only `CONNECTED` after a successful provider test.

Application-level Meta/Google/Microsoft app credentials may be shared; customer mailbox and WABA
credentials are never shared.

## Branding and documents

Login/layout branding, PDF identity, quotation numbering (`quotationPrefix`), tax lines, currency,
terms, sender address and supplier RFQ wording are read from the authenticated organization. PDFs
never contain another company's legal name, TRN, address, logo, bank or terms.

## Industrial specifications (OGS)

`src/lib/catalog/industrialSpec.ts` defines configurable schemas for Pipes, Valves, Flanges,
Fittings, Chemicals and Industrial Spares, with required attributes and deterministic comparison:
`EXACT`, `EQUIVALENT` (only with an explicitly approved substitution), `INSUFFICIENT` (required
information missing) or `NO_MATCH` (critical conflict). Fastener matching remains the separate
versioned deterministic engine and is unchanged. The module is unit-tested; wiring every OGS
category into the enquiry extraction UI is still pending (see `docs/RELEASE_REPORT.md`).

## Verification

`tests/tenant-isolation.test.ts` creates overlapping SKUs, emails, integrations, jobs, sequences,
enquiries and offers in both organizations and verifies that neither tenant can read the other's
rows, that WhatsApp credentials route correctly, and that idempotency keys and document numbers are
independent. `tests/industrial-spec.test.ts` covers the OGS category rules.

## Operational notes

- Back up before `prisma migrate deploy`; the migration is forward-only.
- Provision a new tenant with the CLI, then have its owner complete company identity, currency, tax,
  terms, inventory and integrations from Settings/Onboarding.
- Never run `db:seed` in production (it refuses when `NODE_ENV=production` and demo data is off).
- Do not delete `org_mfbmt`; it owns all historical records.

## Tenant-scoped files and diagnostics (21 November 2026)

New storage keys are `organizations/{organizationId}/attachments/{yyyy-mm}/{random}` and `organizations/{organizationId}/quotations/{quote}-v{version}.pdf`. The organization id is taken from server-side tenant context, never from the request. Downloads verify the attachment's database ownership before a short-lived signed URL is issued. Legacy `attachments/...` keys remain readable through the same ownership check and are not rewritten automatically; use `npm run audit:attachments` to inventory them.

Supplier email replies, owner invitations and integration diagnostics are all organization-scoped models/operations. Diagnostics never read or refresh another tenant's credentials, and a supplier reply can only match an RFQ owned by the same organization.
