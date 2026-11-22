# Attack-testing runbook

This environment is synthetic and isolated. It must never point at production.

## Safety model

`src/scripts/safety.ts` accepts a database URL only when:

- `NODE_ENV` is not `production`;
- the host is `127.0.0.1`, `localhost` or `::1`;
- the database name contains a disposable marker: `_test`, `_attack`, `_e2e`, `_stress`, `_restore` or `_backup`;
- the database name does not look like production/live.

`backup-db.ts`, `restore-db.ts` and `attack-fixtures.ts` call this guard. The
attack fixture additionally deletes only organizations whose slug starts with
`attack-`; it never truncates a real tenant.

## Prerequisites

```bash
# Isolated PostgreSQL 16 (example: Docker container named mfbmt-test-pg)
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_test?schema=public'
export TEST_DATABASE_URL="$DATABASE_URL"
export NODE_ENV=test
npx prisma migrate deploy
```

No real provider request is made by these commands.

## Fixtures

```bash
npm run attack:seed      # creates attack-mfbmt and attack-ogs
npm run attack:inspect   # products, stock, reservations, outbound states, jobs
npm run attack:race      # two concurrent reservations for exact stock
npm run attack:cleanup   # deletes both attack-* organizations only
```

Seeded data includes:

- `attack-mfbmt` (GENERAL) and `attack-ogs` (INDUSTRIAL);
- one product per tenant with 2 units in each of two warehouses (4 total);
- one customer enquiry, one quotation awaiting approval, one pending approval;
- one supplier and one synthetic `UNKNOWN` outbound row per tenant;
- no real messages, no real business records.

`attack:race` on the current code returns one `created: 1` and one
`duplicates: 1`, with each warehouse reserved by 2 and one `ACTIVE` reservation
of 4. This proves the same-quotation concurrent idempotency fix.

Open **/observability** as an owner to see the synthetic `UNKNOWN` rows and the
reconciliation form. Staff are denied by `requireOwner`.

## Manual attack matrix

### Outbound reconciliation

1. In `/observability`, find an `UNKNOWN` synthetic message.
2. Choose **Provider confirmed not sent**, enter a note, record it.
3. Confirm the row becomes `PENDING`, attempts reset to 0, and an
   `outbound.reconciled_not_sent` audit entry exists.
4. Re-run the corresponding operation; it should transmit once, not twice.
5. For a live `SENDING` row (shortly after clicking send), confirm the
   reconciliation form is absent and direct reconciliation is rejected.
6. Kill the worker while a send is in flight; after the lease expires, confirm
   the row becomes `UNKNOWN` via the worker/QStash sweep and is visible.

### Reservations

1. `npm run attack:race`; confirm exactly one new reservation.
2. Approve the quotation with enough stock; confirm `ACTIVE` and reserved
   quantities across both locations.
3. Reject/cancel; confirm `RELEASED`, reserved stock returns, second release is
   a no-op.
4. Approve again; confirm the released reservation is reopened and stock is
   reserved again.
5. Reduce stock below requirement; approval must fail unless an owner enters a
   reason. An override must not create stock.
6. Try a quotation line with `stockQuantity > 0` but no matched product; confirm
   approval is blocked.
7. Use an OGS user/session against an MFBMT reservation/attachment/outbound id;
   confirm 404/not-found behavior.

### Units and documents

- `1 box` without a product factor must remain unknown.
- Configure `1 box = 20 pcs`, then test `carton → box → pcs`.
- Try a fixed unit (`m`) as a packaging unit; configuration must be rejected.
- Try huge/zero/negative/NaN factors and huge quantities; no `Infinity` result.
- Upload a ZIP with a 21 MB declared entry; it must be rejected before output.
- Upload a path-traversal archive; it must be rejected.
- Upload `.xls`; expect a visible “save as .xlsx/.csv” instruction, not parsed text.

### Security

- Replace ids in `/quotations/<id>/pdf`, `/files/<id>`, `/sourcing/<id>`,
  `/approvals/<id>` and outbound reconciliation with another tenant’s id.
- Call `/api/cron/email-sync` with no organization (expect 400) and with a
  foreign organization (must run only that tenant).
- Replay a webhook payload; confirm one row/one enquiry.
- Use a signed attachment URL after expiry; expect 401.
- Submit an owner-only server action as staff; expect `/login`/denial.
- Submit a `create-org` command with a password argument; expect refusal before
  any write.

### Backup and restore

Host PostgreSQL tools may be absent. The audit used the container binaries:

```bash
export MSYS_NO_PATHCONV=1   # Git Bash on Windows
docker exec mfbmt-test-pg pg_dump -U postgres -d mfbmt_test -Fc -f /tmp/mfbmt_test.dump
docker cp mfbmt-test-pg:/tmp/mfbmt_test.dump backups/mfbmt_test-audit.dump

docker exec mfbmt-test-pg psql -U postgres -d postgres \
  -c 'CREATE DATABASE mfbmt_restore;'
docker cp backups/mfbmt_test-audit.dump mfbmt-test-pg:/tmp/mfbmt_restore.dump
docker exec mfbmt-test-pg pg_restore -U postgres -d mfbmt_restore \
  --clean --if-exists --no-owner --no-acl /tmp/mfbmt_restore.dump
```

With local PostgreSQL client tools installed, the guarded scripts are:

```bash
BACKUP_DATABASE_URL="$TEST_DATABASE_URL" npm run backup:db
RESTORE_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_restore?schema=public' \
BACKUP_FILE=backups/<file>.dump npm run restore:db
```

A database dump does **not** include S3/R2 objects. Verify each attachment’s
`storagePath` separately. The audit database contained 0 attachments, so file
availability could not be proven.

## Last measured result (22 November 2026)

- Full suite: 42 files, **297/297**.
- Playwright: **14/14** (desktop + mobile Chrome).
- Build: PASS. Lint: 0 errors, 27 warnings.
- Backup/restore: 11 table counts matched; see `STATUS.md`.
- Stress: 30/30 reservations in 319 ms; contention exactly 10 reserved;
  300/300 jobs drained in 881 ms; 60 provider calls for 120 duplicate attempts.
