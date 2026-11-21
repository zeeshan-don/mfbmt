# Production Migration Safety Audit — 2026-11-19

## 0. Strict execution compliance

- No production database was modified.
- `prisma migrate deploy` was **not** run against production.
- `vercel --prod` was **not** run.
- No database reset, deletion, or data overwrite was performed.
- No migration history was modified.
- The audit itself was read-only. A later, separate Preview-isolation change removed only Preview-scoped database environment variables; no Production variable, database row, migration or Production deployment was changed.
- Preview-only deployments were created during the isolation work; none used `vercel --prod`, and no Production deployment was created. The first deployment accidentally included the local `.env`; it and a later deployment that restored its build cache were removed. The remaining clean Preview is intentionally fail-closed.
- This report stops after Preview deployment preparation. Production deployment and the Production migration still require explicit authorization.

## 1. Target database and environment

| Item | Value |
|---|---|
| Provider | Neon (PostgreSQL) |
| Host | `ep-royal-recipe-bag133h2-pooler.c-8.eu-central-1.aws.neon.tech` |
| Database | `neondb` |
| Schema | `public` |
| Vercel-stored `DATABASE_URL` | **Production only** as of the 2026-11-19 Preview isolation change. All Preview-scoped database variables were removed. The Neon integration still injects a Production `DATABASE_URL` into Preview at runtime; the fail-closed guard refuses it. |
| Neon branch | Not exposed by the connection string. Confirm in the Neon console; do **not** assume the branch is named `main` or `production`. |
| Other Vercel DB env vars | `DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `PGHOST`, `PGHOST_UNPOOLED`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DATABASE`, `NEON_PROJECT_ID`, `NEON_AUTH_BASE_URL` — Production scope only after the isolation change |

Historical observation: Preview and Production originally shared the same Neon database endpoint. Every database-related Preview variable stored in Vercel was removed, but the Neon integration still injects the Production endpoint into Preview at runtime. The fail-closed guard prevents any connection, so Preview is non-functional until the integration's Preview binding is disabled or pointed at the staging branch. Production was not changed.

## 2. Migration status

Applied migrations (from `_prisma_migrations`, read-only):

1. `20261117191151_init_postgres`
2. `20261118120000_fastener_specs_and_worker_heartbeat`
3. `20261118130000_approval_pending_only_unique`

Pending migration:

- `20261119170000_multi_company_tenancy` (339 lines, forward-only)

`npx prisma migrate status` confirms only this migration is pending. `prisma validate` passes.

## 3. Pending migration operations

### Safe / additive operations

- `INSERT INTO "Organization"` for `org_mfbmt` only if no organization exists.
- `INSERT INTO "Organization"` for `org_ogs` only if it does not already exist.
- `ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS ...` for tenant configuration fields.
- `RENAME COLUMN "trn" TO "taxRegistrationNumber"` if present.
- `ADD COLUMN "organizationId" TEXT` to 36 tenant tables.
- `UPDATE ... SET "organizationId" = ...` backfill statements (see section 4).
- `ALTER COLUMN "organizationId" SET NOT NULL` after backfill.
- `CREATE INDEX ...` for `organizationId` on each tenant table.
- `CREATE UNIQUE INDEX ...` organization-scoped replacements.
- `CREATE INDEX ...` for `Organization(status)`.
- `CREATE UNIQUE INDEX ...` for `Organization(slug)`.
- Default sentinel `__unset__` applied to `organizationId` columns.

### Constraint changes (metadata, not data deletion)

- `DROP INDEX IF EXISTS` on 14 global unique indexes, then recreate them as composite organization-scoped unique indexes.
- `ALTER TABLE "NumberSequence" DROP CONSTRAINT "NumberSequence_pkey"`, then add composite primary key `("organizationId", "scope")`.
- `ALTER TABLE "AppSetting" DROP CONSTRAINT "AppSetting_pkey"`, then add composite primary key `("organizationId", "key")`.
- `ADD CONSTRAINT ... FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE` for tenant tables.

### No destructive data operations

The migration contains **no** `DROP TABLE`, `TRUNCATE`, `DELETE`, or row-removing statements. Existing MFBMT records are retained and reassigned to `org_mfbmt`.

## 4. Data migration and backfill behavior

All pre-existing tenant rows are assigned to `org_mfbmt`:

- Direct backfill: `User`, `Contact`, `ExcludedContact`, `Conversation`, `Message`, `Attachment`, `Enquiry`, `Product`, `InventoryLocation`, `Supplier`, `PricingRule`, `MaterialEquivalence`, `Integration`, `BackgroundJob`, `WebhookEvent`, `Notification`, `ExchangeRate`, `NumberSequence`, `AppSetting`, `AuditLog` (nullable).
- Derived backfill:
  - `Session.organizationId` from its `User`.
  - `EnquiryItem`, `ProductSpecification`, `InventoryStock`, `InventoryMovement`, `SupplierContact`, `SupplierProduct`, `SupplierOffer`, `SupplierQuote`, `SupplierQuoteItem`, `Approval`, `CustomerQuotation`, `CustomerQuotationItem` from their parent enquiry/product/supplier/quotation.
  - `SearchSession`, `SearchQuery`, `SearchResult` from their search session/enquiry item.
- `AuditLog.organizationId` remains nullable for platform/auth events that occur before a tenant is known.
- `org_ogs` is inserted as an independent, empty tenant. No MFBMT data, legal details, users, suppliers, prices, or credentials are copied or invented.

Global unique keys become organization-scoped. This is a relaxation for existing data and cannot violate existing rows because all existing rows share one organization.

## 5. Backward compatibility with the currently deployed production application

The migration is **not backward-compatible** with the currently deployed production application code.

- The currently deployed code expects the old schema: no `organizationId` columns and single-column primary keys on `NumberSequence` and `AppSetting`.
- The new application code expects the migrated schema: `organizationId` columns, composite primary keys, and organization-scoped unique indexes.
- Before Preview isolation, Preview returned HTTP 500 because the new code was running against the old schema.
- Preview still receives the Production database URL from the Neon integration at runtime, but the fail-closed guard refuses to start rather than connect. Preview remains non-functional until the integration's Preview binding is removed or pointed at `tenancy-staging-20261119`. This does not affect Production.
- Therefore, code deployment and database migration must be coordinated in a maintenance window. Do not apply the migration alone while old code is serving traffic, and do not deploy new code alone against the old database.

## 6. Current production data profile (read-only audit)

Production database currently contains minimal data:

- Organizations: 1 (`org_mfbmt`)
- Users: 1
- Sessions: 1
- Integrations: 8
- AuditLog: 15
- All business tables (enquiries, products, inventory, suppliers, quotations, jobs, etc.): 0 rows

This reduces migration risk, but it does not remove the need for a verified backup or staging validation.

## 7. Backup verification

- `pg_dump`, `psql`, and `neonctl` are **not installed** in this environment.
- No production database backup file was created during this audit.
- No verified non-empty backup exists.
- **Do not proceed** with production migration until a verified backup is obtained.

Recommended backup methods:

1. Neon Console: create a branch from the current database (point-in-time snapshot) before migration. Record the branch name and creation time.
2. Install PostgreSQL client tools, then run a verified dump:
   - `pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" --file=mfbmt-pre-tenancy-<timestamp>.dump`
   - Verify the file exists and is non-empty (`ls -lh`, `test -s`).
   - Optionally verify restore into an isolated database.
3. If using Neon branching, document the branch ID and restore command.

Restore instruction template:

- Neon branch restore: restore the production branch from the pre-migration branch in the Neon console, or reset the production branch to the snapshot.
- `pg_restore` restore: `pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" mfbmt-pre-tenancy-<timestamp>.dump`

## 8. Staging / isolated migration results

- The migration was applied successfully to isolated local databases:
  - `mfbmt_test`
  - `mfbmt_e2e`
- Both completed all 4 migrations, including `20261119170000_multi_company_tenancy`.
- Local Vitest: 17 files / 164 tests passed.
- Local Playwright: 7/7 passed in Google Chrome.
- Production-data-equivalent migration has **not** been tested. Production contains 1 user and 8 integrations; the local test databases contain demo data, but no restore of the production database was possible because `pg_dump` is unavailable.

Recommended next validation:

1. Create a Neon branch from production.
2. Run `npx prisma migrate deploy` against that branch only.
3. Run the application against that branch in a Preview deployment or local process.
4. Verify login, integrations, audit logs, and health endpoint.
5. Only after that, consider production.

## 8a. Preview database isolation implementation (2026-11-19)

Preview is no longer allowed to share the production database.

### Environment variables actually used

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | `prisma/schema.prisma`, `src/lib/db-base.ts`, `src/lib/db.ts`, `src/lib/env.ts` | The only database URL the application reads. Prisma uses it for runtime queries and migrations. |
| `DIRECT_URL` | **Nothing** | Not present in the datasource, code, scripts, docs or Vercel configuration. Do not add it unless the Prisma datasource is changed to use `directUrl`. |
| `SHADOW_DATABASE_URL` | **Nothing** | Only relevant to `prisma migrate dev`; it is not used by `prisma migrate deploy`, the build, or the runtime. |
| `TEST_DATABASE_URL` | `tests/global-setup.ts`, `tests/setup.ts` | Test-only. Defaults to local `mfbmt_test`. |
| `TEST_E2E_DATABASE_URL` | `playwright.config.ts`, `tests/e2e/prepare.ts` | Test-only. Defaults to local `mfbmt_e2e`. |
| `DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `PGHOST`, `PGHOST_UNPOOLED`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DATABASE`, `NEON_PROJECT_ID`, `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`, `POSTGRES_HOST` | Injected by the Vercel/Neon integration, **not read by this application** | Removed from Preview so no alternate connection path remains. Production values are unchanged. |
| `STAGING_DATABASE_HOST` | New staging guard | Non-secret hostname of the isolated staging branch. Required for Preview startup and staging migrations. |
| `PRODUCTION_DATABASE_HOSTS` | New staging guard | Optional comma-separated override. Defaults to the known production pooled **and** unpooled Neon hosts. |

Verification: `vercel env ls preview` shows **no** `DATABASE_URL`, `POSTGRES_*`, `PG*` or `NEON_*` variables. However, a clean `--force` Preview deployment still received the Production `DATABASE_URL` at runtime from the Neon marketplace integration, proving that `vercel env ls` does not list integration-injected variables. The guard rejected the host. Production still has its original `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`, `PGHOST`, `PGHOST_UNPOOLED`, `NEON_PROJECT_ID` and related values.

### Automatic migrations: none

- `npm run build` is `prisma generate && next build`. It does **not** run migrations.
- `npm start` is `next start`. It does not run migrations.
- There is no `postinstall`, `prebuild`, `prestart` or `predeploy` hook.
- `vercel.json` contains only `{"framework":"nextjs"}`.
- There are no GitHub Actions or other CI workflow files.
- The only migration commands are explicit operator scripts: `db:deploy` (`prisma migrate deploy`), `db:migrate` (`prisma migrate dev`) and `db:reset` (`prisma migrate reset --force`).

A Preview deployment therefore cannot migrate the database by itself. Migration remains a deliberate operator action.

### Fail-closed staging guard

New files:

- `src/lib/db-target.ts` — parses only host/database, recognises pooled and unpooled production hosts, and never formats credentials.
- `src/scripts/verify-staging-db.ts` — non-connecting guard used before staging migrations.
- `src/lib/env.ts` — `previewConfigProblems()` refuses Preview startup unless `DATABASE_URL` matches `STAGING_DATABASE_HOST` and is not a production host.
- `src/instrumentation.ts` — calls `assertRuntimeConfig()`, which combines production and Preview checks.

New scripts:

```bash
npm run db:verify:staging   # verify target only; does not connect
npm run db:deploy:staging   # verify target, then prisma migrate deploy
```

The guard rejects:

- the production pooled host `ep-royal-recipe-bag133h2-pooler.c-8.eu-central-1.aws.neon.tech`;
- the production unpooled host `ep-royal-recipe-bag133h2.c-8.eu-central-1.aws.neon.tech`;
- any host that does not exactly equal `STAGING_DATABASE_HOST`;
- a missing or malformed `DATABASE_URL`.

Guard verification performed:

- Against the current production pooled URL: refusal, exit code 1.
- Against the production unpooled host: refusal, exit code 1.
- Against a local isolated database with `STAGING_DATABASE_HOST=127.0.0.1`: accepted, exit code 0.
- Preview runtime check with `VERCEL_ENV=preview` and a production host: one `DATABASE_URL` problem, as expected.
- Preview runtime check with a declared staging host: no problems.
- No credentials were printed by any run.

Limitation: a raw `npx prisma migrate deploy` invocation bypasses the npm guard. There is no automatic invocation anywhere in the repository, so the safe procedure is to use `npm run db:deploy:staging` only. Do not run raw Prisma migration commands with a Preview or Production URL.

### Preview environment configuration

Before staging is connected, Preview receives a Production `DATABASE_URL` from the Neon integration and refuses to start. This is intentional fail-closed behaviour. Do not weaken the guard to make this deployment usable; remove the integration's Preview binding instead.

Once the staging branch exists, add **Preview-only** values:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Staging branch connection string. Use the unpooled endpoint for a one-off migration, or the pooled endpoint for the Preview runtime. The host must match the next variable. |
| `STAGING_DATABASE_HOST` | The exact hostname of that staging connection string (no credentials, no port). |

Commands (paste values at the prompts, never into shell history or logs):

```bash
vercel env add DATABASE_URL preview
vercel env add STAGING_DATABASE_HOST preview
```

Do not copy Production values. Do not add `DIRECT_URL` or `SHADOW_DATABASE_URL`.

Preview also needs its own runtime configuration to start and to exercise login:

- `AUTH_SECRET` — a new random value, not the Production one.
- `CREDENTIAL_ENCRYPTION_KEY` — a new random value. Note: integration tokens copied from Production were encrypted with the Production key. They will not decrypt in Preview unless the Production key is deliberately supplied; do not silently reuse it. For staging, verify integration **records and routing** and treat live token decryption as unverified unless the original key is explicitly used in a protected Preview environment.
- `APP_URL` — the protected Preview URL once known.
- `NODE_ENV=production`, `DEMO_MODE=false`, `SEED_DEMO_DATA=false` if the Preview does not inherit them.

Do not change any Production variable.

### Vercel CLI upload exclusion

`vercel deploy` does not honor `.gitignore` for arbitrary files. The first Preview created during this audit loaded the local `.env` in the remote build (Next.js reported `Environments: .env`), so that deployment contained the local Production database URL and other local secrets. The guard refused to start it, and the deployment was removed immediately.

`.vercelignore` now excludes `.env` and `.env.*`. Never run a Vercel CLI deployment without this file, and verify the build log does **not** contain `Environments: .env`.

Treat the credentials that were present in `.env` as exposed to the Vercel build source, including the Production database URL, `AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, provider API keys, and webhook secrets. Rotating Production credentials is a separate Production change and was not performed here. Rotate them under explicit authorization; changing `CREDENTIAL_ENCRYPTION_KEY` requires re-encrypting stored integration tokens.

### Preview deployment result (2026-11-19)

Three Preview deployments were created; none was a Production deployment.

| Deployment | Build source | Result | Action |
|---|---|---|---|
| `dpl_7btqUEaKrRWktq2h7rdwWb5Q7zXc` | 515 files; loaded local `.env` | Guard refused Production database; local secrets reached the build source | Removed |
| `dpl_FECqA6j1PhSMvPCkrA2jWCe56Qnh` | 510 files; no `.env`, but restored build cache from the exposed deployment | Guard refused Production database; contaminated cache | Removed |
| `dpl_2WA6buMvjbRDzJSDm8cHL3MXz3q7` | 510 files; no `.env`; `--force` skipped build cache | Build log has no `Environments: .env`; runtime guard still rejects the Production host injected by Neon | Remains live, intentionally fail-closed |

Clean Preview URL: `https://mfbmt-93bgnm0n4-zeesh.vercel.app` (protected by Vercel Authentication).

### Vercel Neon integration warning

The Neon marketplace resource `mfbmt` (`store_yJMj7iUWcX2X4kOs`) is still connected to the project for both Preview and Production. **Confirmed:** even after all Preview database variables were removed and a `--force` deployment was built with no `.env` and no build cache, the Preview runtime still received the Production `DATABASE_URL` from this integration. The guard refused to start. `vercel env ls preview` does not show integration-injected variables, so its output alone is not proof that Preview is isolated.

Do not run `vercel integration resource disconnect mfbmt` — it disconnects the whole project and would affect Production. In the Vercel dashboard, open the Neon integration settings for this project and either disable its Preview environment or bind Preview to `tenancy-staging-20261119`. Leave the Production binding untouched. After any Neon integration change, redeploy a clean Preview and check `/api/health` for the absence of the Production host, not just `vercel env ls`.

## 8b. Exact Neon branch instructions

Neon credentials are **not available in this environment**. `neonctl` is not installed and no `NEON_API_KEY` is present, so no branch was created and no staging migration was run. Use the following manually.

### 1. Confirm the actual production branch

Do not assume `main` or `production`. Console-created Neon projects often use `production`; CLI/API-created projects often use `main`, but the only reliable proof is the endpoint host matching the Production `DATABASE_URL`.

Print only the production hostname (no credentials):

```bash
node --env-file=.env -e "console.log(new URL(process.env.DATABASE_URL).hostname)"
```

In the Neon Console:

1. Open the project backing Vercel resource `mfbmt` (`store_yJMj7iUWcX2X4kOs`).
2. Open **Branches**.
3. Find the branch whose compute endpoint hostname matches the hostname printed above. The default branch is marked with `✱`.
4. Record its **branch ID** (`br-...`) as `<PRODUCTION_BRANCH_ID>`. Do not record it by name alone.

CLI alternative:

```bash
npx neonctl@latest auth
npx neonctl@latest projects list
npx neonctl@latest branches list --project-id <PROJECT_ID> --output json
```

To compare a candidate branch endpoint without printing its password (Neon CLI 4.9.0+):

```bash
npx neonctl@latest connection-string <BRANCH_ID> --project-id <PROJECT_ID> --no-secrets
```

Compare the hostname only. If `--no-secrets` is unsupported, use the Neon Console connection details and do not paste the full string into logs.

### 2. Create the two branches from that exact parent

Create the backup branch first, then staging, both from `<PRODUCTION_BRANCH_ID>`:

```bash
npx neonctl@latest branches create \
  --project-id <PROJECT_ID> \
  --name pre-tenancy-backup-20261119 \
  --parent <PRODUCTION_BRANCH_ID>

npx neonctl@latest branches create \
  --project-id <PROJECT_ID> \
  --name tenancy-staging-20261119 \
  --parent <PRODUCTION_BRANCH_ID>
```

Console equivalent: **Branches → Create branch**, name it exactly, select the confirmed production branch as the parent, and keep data included (do not use schema-only branching).

Record both branch IDs. Neon branches are copy-on-write. Creating `pre-tenancy-backup-20261119` is not, by itself, a verified backup. It must still be validated by reading its row counts and, ideally, restoring it into a disposable database. No `pg_dump`/`pg_restore` verification was possible here.

### 3. Get the staging connection without leaking it

```bash
npx neonctl@latest connection-string tenancy-staging-20261119 \
  --project-id <PROJECT_ID> \
  --database-name neondb \
  --role-name neondb_owner
```

Paste the result directly into the Neon-aware secret prompt or a local password manager. Do not paste it into a shell command that is logged, into this document, or into a chat.

For the one-off migration, use the **unpooled** staging URL and set its hostname explicitly:

```bash
export DATABASE_URL='<staging-unpooled-url>'
export STAGING_DATABASE_HOST="$(node -e "console.log(new URL(process.env.DATABASE_URL).hostname)")"
npm run db:verify:staging
npm run db:deploy:staging
```

Expected: the guard prints only host/database and exits 0, then Prisma applies exactly one pending migration, `20261119170000_multi_company_tenancy`. Confirm with:

```bash
npx prisma migrate status
```

Expected: 4 migrations applied, none pending, no failed migration.

### 4. Configure Preview only after migration succeeds

```bash
vercel env add DATABASE_URL preview
vercel env add STAGING_DATABASE_HOST preview
```

Use the staging branch URL and its exact host. Then redeploy a Preview (never `vercel --prod`) and check `/api/health`.

## 8c. Staging verification status

**Blocked: no staging connection was supplied.** No Neon API key or console session is available, `neonctl` is not installed, and no staging branch exists yet. The clean Preview deployment is live but fail-closed, so no application verification is possible. Therefore:

- No branch was created.
- No migration was applied to staging.
- No application test was run against production-derived data.
- No post-migration row counts exist.

The following checks remain to be run after `tenancy-staging-20261119` exists and is migrated:

1. Login as the existing MFBMT user.
2. Confirm the 8 existing integrations and 15 AuditLog rows are present and assigned to `org_mfbmt`.
3. Confirm every tenant row has `organizationId = 'org_mfbmt'` (except nullable platform audit rows).
4. Confirm `org_ogs` exists and owns no MFBMT records.
5. Attempt OGS reads for MFBMT enquiries, suppliers, quotations, inventory and approvals; expect zero rows.
6. Test organization-scoped uniqueness (same email/slug/number in both organizations; duplicate within one organization must fail).
7. Test background jobs and webhooks with explicit tenant contexts.
8. Test login, approvals, inventory, supplier discovery, quotation creation and PDF generation.
9. Compare the pre-migration row counts in section 6 with post-migration counts per table; any non-zero delta outside seeded test fixtures is a failure.

Do not claim these tests passed until they are actually run against the staging branch.

## 9. Potentially destructive or high-risk operations

| Risk | Assessment |
|---|---|
| Table locks during `ALTER TABLE` | Low for current data volume, but non-zero. Use a maintenance window. |
| `CREATE INDEX` without `CONCURRENTLY` | Locks writes while indexes build. Acceptable for small tables; risky for large tables. |
| Unique index creation failure | Could fail if unexpected duplicate `(organizationId, ...)` values. With one tenant and current data, unlikely. |
| Foreign key creation failure | Could fail if orphaned rows exist. Current counts suggest minimal risk. |
| Composite primary key changes on `NumberSequence` / `AppSetting` | Metadata change; old application code may not tolerate it. Coordinate deploy. |
| Sentinel default `__unset__` | Prevents silent unowned inserts by failing the foreign key. This is intentional. |
| OGS tenant insertion | Adds an empty second organization. No MFBMT data is touched. |
| Deployment protection | Preview is protected by Vercel Authentication; external webhook testing requires bypass or production. |

## 10. Remaining risks

- No verified production backup; the backup branch is not created yet.
- No staging branch or staging migration yet; Neon credentials are unavailable.
- No post-migration row-count comparison exists.
- The Vercel Neon integration is still project-wide and injects the Production `DATABASE_URL` into Preview; the Preview binding must be disabled in the Vercel dashboard.
- Preview is intentionally non-functional: the guard refuses the injected Production database host until the staging branch is supplied.
- Migration and code deployment must be coordinated.
- Live provider credentials are not configured, and copied integration tokens may not decrypt under a new Preview encryption key.
- OGS extraction-screen wiring and automatic supplier email reply matching remain unimplemented.
- No platform-admin web UI or audited support-access workflow.

## 11. Recommendation

Do not apply the migration or deploy production yet.

Completed for Preview:

1. All Preview-stored database variables removed; Production variables unchanged.
2. No automatic migration runs on build, install, start or deploy.
3. A fail-closed staging target guard and Preview runtime check were added.
4. A clean Preview was deployed with `.vercelignore` excluding local env files. It intentionally fails closed because the Neon integration still injects the Production database host.

Still required before Production migration:

1. Confirm the actual production branch in Neon and create `pre-tenancy-backup-20261119` and `tenancy-staging-20261119` from it.
2. Verify the backup branch by reading its counts and, independently, by restoring it into a disposable database. A branch alone is not a verified backup.
3. Apply the migration only to `tenancy-staging-20261119` with `npm run db:deploy:staging`.
4. Run the full staging verification in section 8c, including row-count comparison.
5. Schedule a maintenance window.
6. Apply the Production migration with `npx prisma migrate deploy` only after separate explicit authorization and a verified backup.
7. Deploy the already-committed application with `vercel --prod` only after separate explicit authorization.
8. Run post-deployment health, worker, and provider checks.

This report stops after Preview preparation and waits for the staging connection and explicit authorization.
## Addendum — 21 November 2026 (production hardening; NOT applied)

A new additive, forward-only migration was prepared: `20261121120000_ogs_procurement_hardening`. It adds `Organization.procurementProfile`, industrial spec JSON on enquiry items/products, supplier reply correlation fields, `SupplierEmailReply`, `Attachment.supplierReplyId`, and `OwnerInvitation`. Existing columns and records are not rewritten.

This migration was applied and tested only against isolated local databases (`mfbmt_test`, `mfbmt_e2e`). It has **not** been applied to the production Neon database, and no production schema or data was modified. The historical audit above is unchanged. A future migration remains a separately authorized deployment step, after a verified backup and with the release checklist.
