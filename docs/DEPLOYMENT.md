# Deployment

The app is a standard Next.js server plus a worker process. It needs a writable disk for the `storage` folder. It fits on a small VPS (2 vCPU / 2 GB RAM is enough for a trading office), a managed container host, or an on-premise machine.

## Requirements

- Node.js 20 or 22 (LTS)
- 1–2 GB RAM, 5 GB disk plus attachments
- HTTPS endpoint (reverse proxy or the platform's TLS)
- Ability to run one long-lived process for the worker

## 1. Configure

```bash
git clone <repository> mfbmt && cd mfbmt
npm ci
cp .env.example .env
```

Edit `.env`. At minimum in production:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `file:./prod.db` (or a PostgreSQL URL) |
| `AUTH_SECRET` | 32+ random bytes (`openssl rand -base64 32`) |
| `CREDENTIAL_ENCRYPTION_KEY` | 32-byte base64 key, **kept with the backups** |
| `APP_URL` | `https://procurement.example.com` |
| `NODE_ENV` | `production` |
| `STORAGE_ROOT` | absolute path outside the deploy folder, e.g. `/var/lib/mfbmt/storage` |
| `DEMO_MODE` | `false` |
| `SEED_DEMO_DATA` | `false` |
| `WORKER_SECRET` | random string if you use `/api/jobs/tick` |

Never reuse the example values. `AUTH_SECRET` or `CREDENTIAL_ENCRYPTION_KEY` changes invalidate sessions or stored integration tokens.

## 2. Migrate and seed

```bash
npx prisma migrate deploy
npm run build
```

Do **not** run `db:seed` on a production database unless you intend to create the demo owner, sample suppliers and demo enquiries. If you do, sign in and immediately change the password and remove the demo data.

## 3. Run

Two processes:

```bash
# web
npm start -- -p 3000

# background jobs
npm run worker
```

`npm start` serves the built app. The worker drains `BackgroundJob` rows (extraction, sourcing, emails, PDFs). Without it, work stays queued and the UI says so.

### systemd example

```ini
# /etc/systemd/system/mfbmt-web.service
[Unit]
Description=MFBMT web
After=network.target

[Service]
WorkingDirectory=/opt/mfbmt
EnvironmentFile=/opt/mfbmt/.env
ExecStart=/usr/bin/npm start -- -p 3000
Restart=always
User=mfbmt

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/mfbmt-worker.service
[Unit]
Description=MFBMT worker
After=network.target

[Service]
WorkingDirectory=/opt/mfbmt
EnvironmentFile=/opt/mfbmt/.env
ExecStart=/usr/bin/npm run worker
Restart=always
User=mfbmt

[Install]
WantedBy=multi-user.target
```

Both units need write access to `STORAGE_ROOT` and the SQLite file's directory.

### Docker sketch

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
ENV NODE_ENV=production
CMD ["npm", "start", "--", "-p", "3000"]
```

Run the worker as a second container with `command: npm run worker`, and mount the storage folder and database as volumes. Do not bake `.env` into the image.

## 4. Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name procurement.example.com;
  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

TLS terminates at the proxy; the app expects `X-Forwarded-Proto` to be set so secure cookies work. Webhook paths (`/api/webhooks/*`) must be publicly reachable over HTTPS; everything else can be restricted to the office network or VPN.

## 5. Verify after deploy

```bash
curl -fsS https://procurement.example.com/api/health
```

Expected: `{"status":"ok",...}`. Then:

1. Sign in as owner.
2. **Settings → Connections**: every integration shows its real state. Do not consider deployment complete while a required integration says **Needs attention**.
3. Open one enquiry, confirm the pipeline runs and the worker processes the job.
4. Generate a quotation PDF and check the company block, currency and terms.
5. Confirm a staff account cannot see settings, approvals or internal cost.

## 6. Upgrades

```bash
npm ci
npx prisma migrate deploy
npm run build
systemctl restart mfbmt-web mfbmt-worker
```

Back up before migrating (see `BACKUP.md`). Migrations are forward-only; keep the pre-upgrade backup until the new version has been used for a day.

## Operational notes

- **Time zone**: the server runs in UTC; business dates in the UI are displayed in the configured timezone (`BUSINESS_TIMEZONE`, default `Asia/Dubai`).
- **Process count**: run exactly one web process per SQLite file. Horizontal scaling needs PostgreSQL (see `DATABASE.md`).
- **Logs**: Next writes request logs to stdout; the worker logs job ids and failures. Ship them to your log collector; do not log request bodies.
- **Health checks**: `/api/health` is safe for load balancers and does not reveal configuration.
- **Disk**: attachments are never deleted automatically. Monitor `STORAGE_ROOT` and archive quotation PDFs if needed.
- **Node modules**: `serverExternalPackages` lists `pdfkit`, `pdf-parse`, `exceljs`, `tesseract.js` and `sharp`. Keep the platform's native builds consistent between machines.
