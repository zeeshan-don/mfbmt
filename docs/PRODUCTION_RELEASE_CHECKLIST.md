# Production release checklist (controlled OGS onboarding)

Nothing here is applied automatically. Each production step requires separate
authorization. Do not apply the migration, change Vercel environment variables,
provision the real OGS owner or send external messages without it.

## 1. Pre-flight (local/staging)

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes against an isolated PostgreSQL database.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e` passes with the fixture server/browser.
- [ ] `npx prisma migrate diff` / migration review confirms the new migration is
      additive and does not rewrite history.
- [ ] The migration has been applied to a positively identified staging database
      only, and the app + worker start there.
- [ ] `npm run check:config` with production-shaped placeholders reports no
      storage/secret problems.

## 2. Backup

- [ ] Take a verified production database backup and record its restore point.
- [ ] Confirm the backup can be restored to an isolated branch.
- [ ] Record the current deployed commit (`8c4142e...`) and worker heartbeat.

## 3. Storage (before uploading files)

- [ ] Private R2/S3 bucket exists; public access is blocked.
- [ ] `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
      `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` are set
      in Vercel Production for both web and worker.
- [ ] `STORAGE_ALLOW_LOCAL_VOLUME` is `false` on Vercel.
- [ ] Deploy, then run Settings → File storage self-test (or
      `GET /api/health?deep=1` with the worker secret).
- [ ] Confirm an existing MFBMT attachment still downloads and a new upload lands
      under `organizations/org_mfbmt/attachments/yyyy-mm/...`.
- [ ] Run `npm run audit:attachments` against a read-only copy; record counts and
      whether legacy keys are readable. No key is rewritten.

## 4. Database migration (separate authorization)

- [ ] Verify the target hostname is the production Neon endpoint, not staging.
- [ ] Apply `20261121120000_ogs_procurement_hardening` with the approved
      procedure (`prisma migrate deploy` against that URL).
- [ ] Verify the new columns/tables exist and existing MFBMT rows are unchanged.
- [ ] Confirm a rollback plan is the pre-migration backup; do not run `db push`
      or `migrate reset`.
- [ ] Enable OGS's industrial profile only with explicit authorization:
      `UPDATE "Organization" SET "procurementProfile"='INDUSTRIAL' WHERE "slug"='ogs';`

## 5. Worker

- [ ] `npm run worker` starts with the same storage/database/encryption env.
- [ ] Heartbeat is HEALTHY in `/api/health`.
- [ ] A synthetic non-messaging job completes.
- [ ] Queue idempotency and expired-lease recovery were verified on staging.

## 6. OGS owner (separate authorization + approved identity)

- [ ] Approved owner email and name are supplied by the business owner.
- [ ] Run (invitation is the default):
      `ORG_SLUG=ogs CONFIRM_ORGANIZATION=ogs OWNER_EMAIL=<approved> OWNER_NAME="<approved>" npm run provision:owner`
- [ ] The command writes the single-use invite link to `owner-invite-ogs.txt`
      (0600). It does not print the token.
- [ ] Deliver the link through an approved channel; delete the file afterwards.
- [ ] The invitee visits `/accept-invite`, sets their own password, signs in.
- [ ] Do not reset or modify the existing MFBMT owner.

## 7. Integrations (manual, non-destructive)

- [ ] Set provider app credentials on Vercel; complete OAuth/Embedded Signup in
      Settings.
- [ ] Run diagnostics; only report CONNECTED/authenticated after a live check.
- [ ] Confirm no customer/supplier message is sent during diagnostics.
- [ ] Email intake syncs and supplier replies reach `/suppliers/replies` when
      ambiguous.
- [ ] Supplier RFQ sending, follow-ups and purchase orders still require owner
      approval.

## 8. Verification after cutover

- [ ] `/api/health` reports database reachable, worker healthy, storage ready.
- [ ] OGS cannot see MFBMT enquiries/attachments/integrations and vice versa.
- [ ] New attachment keys are tenant-scoped; a foreign key returns 404/401.
- [ ] Duplicate supplier email sync creates one reply/offer.
- [ ] A synthetic OGS enquiry can be reviewed, stock-checked, sourced and quoted
      without sending real messages.
- [ ] Audit log records provisioning, migration/owner actions and integration
      checks.

## 9. Stop conditions

Stop and escalate if: the migration is not additive, the target database is not
positively identified, storage self-test fails, the worker cannot read the same
bucket, an email/WhatsApp provider check reports an unexpected mailbox, or any
step would send a real external message without explicit approval.

## Verification status — 21 November 2026

- Typecheck, ESLint (0 errors), production build: passed.
- Vitest: 24 files / 206 tests passed. Playwright: 7/7 passed against isolated `mfbmt_e2e`.
- Local synthetic burst: 30/30 ingested, 60/60 jobs completed; providers mocked.
- Production migration: prepared, **not applied**. No production env var or data changed.
- OGS owner: invitation flow implemented; **no real owner provisioned**.
- Live providers: **not verified** (no credentials/dashboard actions); run owner diagnostics after configuration.
- Real supplier/customer messages and production deployment: **not performed**.
