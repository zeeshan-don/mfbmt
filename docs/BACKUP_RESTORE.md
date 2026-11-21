# Backup and restoration

## What must be backed up

1. PostgreSQL (Neon): database schema and data. Prefer provider point-in-time recovery plus a pre-deployment snapshot.
2. Object storage: the private bucket containing attachments and quotation PDFs. Enable versioning/lifecycle protection where the provider supports it.
3. Configuration: the names of required environment variables and their non-secret values. Secrets belong in the provider's secret manager, not in this repository.

## Restoration order

1. Restore the database to the chosen recovery point.
2. Restore/verify the object bucket. Attachment rows reference keys; a missing object does not corrupt the database but makes that file unavailable.
3. Run `npm run db:deploy` only if the restored schema predates the current migrations, using a verified database URL.
4. Start the web app and worker with the restored configuration, then run `npm run audit:attachments` and the storage self-test.

Do not delete objects or attachment rows during an incident. A legacy `attachments/...` key is still readable after an ownership check.

## Verification limits

No production backup or restore was executed as part of the 21 November 2026 hardening work. Test restores against an isolated copy before relying on this procedure.
