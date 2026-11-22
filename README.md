# MFBMT Procurement Intelligence

Procurement system for **Multi Fasteners Building Materials Trading LLC** (UAE).

A customer asks for products. The system answers three questions for the owner: *what do we already have, what must we buy, and which supplier gives the best real total cost?*

```
Customer message (WhatsApp / email / manual)
  → identity check + exclusion list (before anything is stored)
  → is this a genuine RFQ? (local rules first, AI only when appropriate)
  → read the product lines (text, PDF, scanned PDF, Excel/CSV, photo)
  → check MFBMT inventory → exact shortage quantity
  → supplier discovery + supplier RFQ → supplier responses via expiring links
  → landed-cost comparison with missing costs kept visible
  → owner approves a supplier option          (approval #1)
  → owner approves sending the supplier RFQ   (approval #2)
  → customer quotation prepared from approved costs + pricing rules
  → owner approves the customer quotation     (approval #3)
  → PDF released by email/WhatsApp, or recorded as sent manually
```

Nothing is purchased, paid for, committed, or sent automatically. Every commercial decision is a recorded human decision, and the customer PDF never contains supplier cost or margin.

## Requirements

- Node.js 20+ (24 tested), npm 10+
- **PostgreSQL 14+** (local, Neon, RDS, Supabase — any PostgreSQL)
- Optional: an S3-compatible bucket (Cloudflare R2 / S3 / MinIO) for production file storage
- A continuously running worker process (`npm run worker`)

## Setup

```bash
npm install

# 1. Configuration
cp .env.example .env
#   set DATABASE_URL, APP_URL, AUTH_SECRET, CREDENTIAL_ENCRYPTION_KEY
#   generate secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Database schema (PostgreSQL migrations are committed)
npx prisma generate
npx prisma migrate deploy

# 3. Create a tenant + one-time owner invitation (no password on the CLI)
npm run operator -- create-org --name "OGS & Chemicals FZC" --slug ogs \
  --owner-email owner@ogs.example --owner-name "OGS Owner"
#   The command prints a single-use invitation URL once. The owner sets their
#   own password. Passwords are refused on the command line and in the environment.
#   Existing tenant: ORG_SLUG=ogs CONFIRM_ORGANIZATION=ogs OWNER_EMAIL=... \
#     OWNER_NAME=... npm run provision:owner:invite

# 4. Web app + worker (two terminals)
npm run dev        # http://localhost:3000
npm run worker     # reading, stock checks, supplier searches, mailbox sync
```

A clean installation shows empty states and points the owner at **/onboarding**. Demo data exists only for local development: it requires **both** `DEMO_MODE=true` and `SEED_DEMO_DATA=true`, and the seed refuses to run when `NODE_ENV`, `APP_ENV` or `VERCEL_ENV` is `production`.

### Fastener owner demo

```bash
# .env (local demo only)
#   DEMO_MODE=true
#   SEED_DEMO_DATA=true
#   NODE_ENV=development
npm run db:seed
npm run dev
```

Sign in with the demo accounts shown on `/login` (only displayed in demo mode) and open **/demo**. The
walkthrough is separate from the original sample enquiries and can be restored from that page; restoring
touches only the two records marked `ENQ-DEMO-FASTENER-01/02`. All prices, suppliers and contacts are
illustrative sample data, not live market quotations. Demo sending is simulated: no e-mail, WhatsApp,
purchase order or payment is created.

## What is implemented

| Area | State |
| --- | --- |
| WhatsApp intake | Meta **Embedded Signup** in Settings → WhatsApp (ported from CoolCare v4 flow), encrypted per-account credentials, signature-verified webhook, durable receipt before acknowledgement, media downloaded by the worker with retry |
| Personal/family numbers | Exclusion list checked on canonical E.164/email **before** any body, subject, attachment or job is written; excluded content is never sent to an AI provider |
| Email intake | Gmail (history + optional Pub/Sub push) and Microsoft Graph (delta + subscription renewal), or the authenticated forwarding endpoint; persistent cursors, pagination, dedupe, no manual sync required |
| Documents | Text, text PDF, **scanned PDF via page render + Tesseract OCR**, XLSX (multi-sheet, header detection), CSV, DOCX and bounded ZIP extraction, JPEG/PNG/WebP and HEIC/HEIF (converted when `sharp` supports it); page/sheet/row references preserved. Legacy `.xls`, `.xlsb` and `.doc` are rejected with a re-save instruction, never guessed |
| Fastener specification | Structured, versioned model (type, diameter, thread/pitch, length, head/drive, material, property class, finish, standard, certification, pack basis). Deterministic matching: conflicts are `NO_MATCH`, unstated required fields are `INSUFFICIENT`. Other categories keep the generic matcher |\n| Inventory | Catalogue + locations, stock import with preview/mapping/validation (including fastener columns), stock states (not configured / not found / zero / partial / full), sourcing-first policy, MOQ-aware shortage |
| Supplier discovery | Internal directory, recorded supplier products, configured web-search APIs (Tavily/Serper/Brave), permitted public pages with robots.txt, SSRF-hardened fetching; coverage report per search |
| Supplier quotes | RFQ drafted from the specification, explicit send approval, email/WhatsApp delivery, expiring response links, server-validated responses stored as **unverified** evidence |
| Landed cost | Product + freight + other charges + tax + FX, MOQ overbuy disclosed, unknown components keep the total null, unknown currency never assumed to be AED |
| Quotations | Per-line stock/procure split, no zero-priced lines, owner override with reason, atomic numbering, three separate approvals, customer-only PDF, real send or explicit manual confirmation |
| Jobs | PostgreSQL `FOR UPDATE SKIP LOCKED` claims, leases + heartbeat (double execution prevented), crash recovery, dead-letter + manual retry |
| Scheduling | Worker daemon is the primary processor and polls each active tenant's mailbox inside that tenant's context; one Hobby-compatible QStash watchdog calls `/api/cron/process-jobs` every 5 minutes with signature verification. There is **no** tenant-less email-sync schedule |
| Storage | Local disk or S3-compatible private bucket, authenticated expiring downloads, size/type validation |
| Security | Fail-closed production config, AES-256-GCM credentials, CSP, rate-limited login, TOTP MFA for owners/admins, per-action authorisation, password change/reset, no credential logging |

## Commands

```bash
npm run dev            # web app
npm run worker         # background worker (required in production)
npm run build          # prisma generate + next build
npm run typecheck      # tsc --noEmit
npm test               # vitest against the isolated PostgreSQL test database
npm run db:migrate     # create a migration in development
npm run db:deploy      # apply migrations (production)
npm run provision:owner
npm run db:seed        # local demo data only (refuses in production)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Database and migrations](docs/DATABASE.md)
- [Deployment, worker, backups](docs/DEPLOYMENT.md) · [Backup and restore](docs/BACKUP.md)
- [WhatsApp Embedded Signup](docs/WHATSAPP.md) · [Email intake](docs/EMAIL.md)
- [Integrations and providers](docs/INTEGRATIONS.md)
- [Owner onboarding](docs/ONBOARDING.md)
- [Inventory import](docs/INVENTORY_IMPORT.md) · [Supplier discovery](docs/SUPPLIERS.md)
- [Security](docs/SECURITY.md) · [Known limitations](docs/LIMITATIONS.md) · [Test report](docs/TEST_REPORT.md)
- [Production hardening audit](docs/IMPLEMENTATION_AUDIT.md)

## Honest status

The workflow, controls, privacy rules and pricing logic are implemented and covered by automated tests. Live provider calls (Meta, Google, Microsoft, AI, web search) can only be verified with MFBMT's own credentials: the code paths, setup UI and failure reporting are complete, but no live call has been made without credentials. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before promising anything to the customer.

## Production hardening — 21 November 2026

Private object storage (Cloudflare R2 / AWS S3) is now required in production; local disk is development-only unless a persistent volume is explicitly allowed. New attachments and quotation PDFs use tenant-scoped keys under `organizations/{organizationId}/...`, with legacy `attachments/...` keys accepted only after an ownership check. See `docs/STORAGE.md`.

OGS industrial extraction is opt-in per organization through `Organization.procurementProfile` (`GENERAL` by default, `INDUSTRIAL` for OGS). MFBMT's fastener engine is unchanged. Supplier email replies from Gmail and Microsoft 365 are correlated to RFQs using provider IDs, reply headers or a stored `RFQ-` token; ambiguous replies go to `/suppliers/replies` for owner review. Owner onboarding now uses a single-use invitation instead of an initial password, and `/integrations` exposes non-destructive provider diagnostics.

Implementation details and the deployment checklist are in `docs/INDUSTRIAL_SPECS.md`, `docs/SUPPLIER_EMAIL_INGESTION.md`, `docs/ONBOARDING.md`, `docs/INTEGRATION_DIAGNOSTICS.md` and `docs/PRODUCTION_RELEASE_CHECKLIST.md`.

## Release-candidate audit — 22 November 2026

The engineering-hardening release candidate has these verified results:

- `npm run typecheck`: PASS, 0 errors
- `npm test`: PASS, 42 files, 297/297 tests
- `npm run build`: PASS
- `npm run lint`: PASS, 0 errors, 27 warnings
- `npm run test:e2e`: PASS, 14/14 (desktop + mobile Chrome)
- `npm run check:config`: PASS (required-variable presence only; not provider proof)
- `npm run stress`: PASS on isolated PostgreSQL (see `docs/LOAD_TESTING.md`)
- Isolated backup/restore drill: PASS, 11 table counts matched
- Synthetic attack environment: seeded and race-tested (`npm run attack:seed`, `attack:race`, `attack:inspect`, `attack:cleanup`)

No production deployment, production migration, real business data, or real
supplier/customer/WhatsApp message was created during this audit.

### Additional commands

```bash
npm run restore:db     # restore a guarded pg_dump into an isolated database
npm run attack:seed    # seed synthetic attack-mfbmt / attack-ogs tenants
npm run attack:race    # concurrent reservation race check
npm run attack:inspect # inspect synthetic attack data
npm run attack:cleanup # delete synthetic attack tenants only
```

See `docs/ENGINEERING_HARDENING.md`, `docs/ATTACK_TESTING.md`,
`docs/INTEGRATION_READINESS.md`, `docs/LOAD_TESTING.md` and
`docs/LIMITATIONS.md`.
