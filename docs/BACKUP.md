# Backup and restore

Two things hold business data: the PostgreSQL database and the attachment/PDF storage root
(`STORAGE_ROOT` or the S3-compatible bucket).

## What to back up

| Item | Where |
|---|---|
| Database | PostgreSQL `DATABASE_URL` — users, enquiries, stock, offers, approvals, audit log, encrypted integration secrets |
| Attachments and quotation PDFs | `STORAGE_ROOT` (local) or the S3 bucket |
| Secrets | `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` in the deployment secret store. Without the encryption key, stored integration credentials cannot be decrypted |

## Database backup

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" \
  > "backups/mfbmt-$(date +%F-%H%M).dump"
```

Verify the dump is readable before trusting it:

```bash
pg_restore --list backups/mfbmt-YYYY-MM-DD-HHMM.dump | head
```

For managed PostgreSQL, use the provider's automated snapshots **and** a logical dump before migrations.

## Storage backup

Local driver:

```bash
tar -czf "backups/storage-$(date +%F).tar.gz" -C "$STORAGE_ROOT" .
```

S3 driver: enable bucket versioning and replicate the bucket, or run a scheduled sync to a second bucket.

## Restore into a new environment

1. Create a new empty PostgreSQL database.
2. Restore:
   ```bash
   pg_restore --no-owner --dbname "$DATABASE_URL" backups/mfbmt-YYYY-MM-DD.dump
   ```
3. Apply forward migrations: `npx prisma migrate deploy`.
4. Restore the storage root or point the app at the restored bucket.
5. Restore `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` from the secret store.
6. Start the web app and worker, then check `/api/health` and one enquiry end to end.

Never test a restore into a database that contains the only copy of live data. Use a copy.

## Before an upgrade

1. Take a database dump and a storage snapshot.
2. Confirm the dump is readable.
3. Run `npx prisma migrate deploy`.
4. Keep the backup until the new version has been used for a day.

Migrations are forward-only. There is no destructive reset path and none should be added.
