# Persistent file storage

Customer RFQs, supplier quotations and quotation PDFs must survive deployments.
Vercel's filesystem is ephemeral, so production **must** use private S3-compatible
object storage. The application refuses file operations when storage is not
configured correctly instead of silently writing to local disk.

## Drivers

| `STORAGE_DRIVER` | Use |
| --- | --- |
| `s3` | Cloudflare R2, AWS S3, MinIO or another S3 API. Production default. |
| `local` | Development, or a self-hosted server with a mounted persistent volume. |

An unknown driver value is a configuration error. There is no fallback to local.

## Environment variables

```
STORAGE_DRIVER="s3"
STORAGE_ROOT="./storage"                 # local driver only
STORAGE_ALLOW_LOCAL_VOLUME="false"       # true only with a real mounted volume
S3_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
S3_REGION="auto"
S3_BUCKET="<PRIVATE_BUCKET_NAME>"
S3_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
S3_SECRET_ACCESS_KEY="<R2_SECRET_ACCESS_KEY>"
S3_FORCE_PATH_STYLE="false"
```

### Cloudflare R2

* Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
* Region: `auto`
* Bucket: private; do not enable public access or a public custom domain.
* Create an R2 API token with object read/write permission for that bucket only.

### AWS S3

* Leave `S3_ENDPOINT` empty.
* Use the bucket's real region, for example `eu-central-1`. `auto` is an R2
  convention and is rejected for AWS.
* The bucket must block public access. The application sets `ACL: private` and
  SSE-S3 on AWS; bucket policy should still deny public reads.

### MinIO / other compatible providers

Set the provider's endpoint, its expected region and `S3_FORCE_PATH_STYLE=true`
when the server does not support virtual-hosted bucket URLs.

## Object keys and tenant isolation

New objects use:

```
organizations/{organizationId}/attachments/{yyyy-mm}/{random-object-id}{safe-extension}
```

* `organizationId` comes from server-side tenant context, never a browser field.
* The object name is 32 random hex characters, so URLs are unguessable.
* Only known-safe extensions are kept; archive/script/executable suffixes are
  dropped. Path traversal, absolute keys, NUL bytes and dot segments are rejected.
* A download via `/api/files/[id]` requires an authenticated user in the owning
  organization or a short-lived HMAC-signed token. A key under another
  organization's prefix is refused even if a database row was tampered with.
* Attachments written before this change use `attachments/yyyy-mm/...`. They are
  **legacy** keys: there is no tenant inside the key, so ownership is taken from
  the `Attachment.organizationId` row that authorizes the download. Do not
  rewrite or migrate existing keys without a verified, backed-up migration.

## Readiness and health

* `storageReadiness()` reports configured/ready without a network call and
  without exposing bucket names or credentials.
* `GET /api/health` includes `checks.storage` (`ready` or `unavailable`).
  `GET /api/health?deep=1` with `x-health-token: $WORKER_SECRET` runs the
  write/read/delete self-test and reports driver/mode.
* Settings → Integrations → File storage runs the same self-test explicitly.
* A missing bucket, unknown driver or production local disk blocks uploads with a
  clear error and is recorded in the audit log. Other application features keep
  working; the worker uses the same storage environment.

## Existing attachments audit

Before a production cutover, run the read-only inspection:

```
npx tsx src/scripts/audit-attachments.ts
```

It reports the number of attachment records, key prefixes, and whether a sample
of objects can be read. It never deletes, overwrites or rewrites a key. The
script requires `DATABASE_URL` and a configured storage driver; run it against an
isolated copy first.

## Manual production steps

1. Create a private R2 or S3 bucket.
2. Set the environment variables above in Vercel (Production scope).
3. Deploy, then run a storage self-test from Settings or
   `GET /api/health?deep=1` with the worker secret.
4. Verify an existing MFBMT attachment still opens and a new upload is written
   under `organizations/org_mfbmt/attachments/...`.
5. Do not delete the old object prefix until a verified migration has been
   completed and backed up.
