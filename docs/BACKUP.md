# Backup and restore

Two things must be backed up together: the **database** and the **storage folder**. A database restored without its attachments shows enquiries whose files are missing; attachments without the database are orphans.

## What to back up

| Item | Default location | Notes |
|---|---|---|
| Database | `prisma/prod.db` (SQLite file) | Contains all business data, sessions, audit log, encrypted integration secrets |
| Attachments and PDFs | `STORAGE_ROOT` (default `./storage`) | Files are named by random id; names are meaningless without the DB |
| `.env` | project root | Needed to decrypt integration secrets; store encrypted, separately |
| `CREDENTIAL_ENCRYPTION_KEY` | inside `.env` | Without it, stored OAuth tokens cannot be read; integrations must be reconnected |

## SQLite backup

The safe way is Prisma's online backup, which uses SQLite's backup API and is consistent while the app is running:

```bash
mkdir -p backups
npx prisma db execute --stdin <<'SQL'
VACUUM INTO 'backups/mfbmt-2026-11-17.db';
SQL
```

Or use `sqlite3`:

```bash
sqlite3 prisma/prod.db ".backup 'backups/mfbmt-$(date +%F).db'"
```

Do **not** copy the `.db` file with `cp` while the app is writing to it; you may capture a torn transaction.

Then copy the storage folder and verify:

```bash
tar czf "backups/mfbmt-storage-$(date +%F).tar.gz" -C "$STORAGE_ROOT" .
```

## PostgreSQL backup

```bash
pg_dump --format=custom --file="backups/mfbmt-$(date +%F).dump" "$DATABASE_URL"
```

## Suggested schedule

- Database + storage: daily, retained 30 days.
- `.env`: whenever it changes, stored in a password manager / secrets vault.
- Monthly: restore the latest backup into a scratch environment and check that files open.

Automate with cron:

```cron
15 1 * * * cd /opt/mfbmt && ./scripts/backup.sh >> /var/log/mfbmt-backup.log 2>&1
```

A minimal `scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
stamp="$(date +%F-%H%M)"
mkdir -p backups
sqlite3 prisma/prod.db ".backup 'backups/db-${stamp}.db'"
tar czf "backups/storage-${stamp}.tar.gz" -C "${STORAGE_ROOT:-./storage}" .
find backups -type f -mtime +30 -delete
```

Store backups off the server. They contain customer data, supplier prices and the encryption key context — treat them as confidential and encrypt at rest (`age`, `gpg`, or the storage provider's encryption).

## Restore

1. Stop web and worker so nothing writes.
2. Keep the current files (rename, do not delete) so a bad restore can be undone.
3. Restore the database:
   ```bash
   cp backups/db-2026-11-17-0115.db prisma/prod.db
   ```
4. Restore storage:
   ```bash
   mkdir -p "$STORAGE_ROOT" && tar xzf backups/storage-2026-11-17-0115.tar.gz -C "$STORAGE_ROOT"
   ```
5. Restore `.env` if it was lost. Use the same `CREDENTIAL_ENCRYPTION_KEY` as when the backup was taken.
6. Verify:
   ```bash
   npx prisma migrate status
   npm start -- -p 3000
   ```
7. Sign in, open an enquiry with an attachment, open a quotation PDF, and check **Activity** shows the audit history.
8. Restart the worker.

If the backup predates a migration, `prisma migrate status` reports pending migrations; run `npx prisma migrate deploy` only if the code deployed matches those migrations. Otherwise deploy the matching build first.

## Tests and demos

- `npm test` uses `prisma/test.db` and is reset every run; never point tests at the production database.
- `npm run db:reset` destroys the development database. It must never be run against production.
- Demo data (`isDemo` flags) can be filtered but not auto-deleted; remove it manually before going live if the seed was run.
