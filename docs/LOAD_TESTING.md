# Load-test execution

`src/scripts/load-test.ts` is a repeatable synthetic harness for enquiry intake
and queue processing. It is **not** a production benchmark and must never run
against production.

## Safety guards

The script refuses to run unless all of these hold:

* `LOAD_TEST_DATABASE_URL` is a PostgreSQL URL;
* the host is `localhost`, `127.0.0.1` or `::1`;
* the database name contains `test` or `load`;
* the URL does not contain a hosted provider host (Neon, Supabase, RDS, Render,
  Vercel);
* `LOAD_TEST_CONFIRM=YES`;
* `LOAD_TEST_COUNT` is an integer from 1 to 300;
* `APP_URL` is not the production deployment.

Before importing application modules it forces `AI_PROVIDER=none`,
`EMAIL_INTAKE_PROVIDER=none`, `WEB_SEARCH_PROVIDER=none`, empty WhatsApp/Meta
credentials and fixed exchange rates. No external message can be sent.

## Workload

* `LOAD_TEST_COUNT` unique synthetic enquiries (default 30).
* Even-indexed requests use a WhatsApp-like intake, odd-indexed an email-like
  intake; categories rotate through all six OGS categories.
* Some requests contain multiple lines and delivery text.
* A burst starts every intake together, then the real `runNextJob` worker path
  drains the queue one job at a time (the deployed worker count is a separate
  deployment decision).
* One unique RFQ is one case; a follow-up message in the same conversation does
  not create a separate count in this harness.

## Run

```
LOAD_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_load_test \
LOAD_TEST_CONFIRM=YES LOAD_TEST_COUNT=30 LOAD_TEST_ORG_SLUG=ogs \
npx tsx src/scripts/load-test.ts
```

The database must already be migrated (`prisma migrate deploy`) and contain the
target organization. Use a disposable database; the harness does not delete
existing rows.

## Measurements

The JSON output records:

* ingest latency p50/p95/max;
* ingest failures;
* jobs seen, completed, failed, queued, processing;
* total worker wall time;
* queue wait p50/p95 (created → claimed);
* job completion p50/p95 (claimed → completed);
* queue after the run.

Interpret with the machine, database and worker concurrency in mind. A single
local worker is not evidence that one production worker can handle 20–30
enquiries/day plus bursts; repeat on staging with the intended worker count.

## Expected operating volume

20–30 enquiries/day is 440–660 per 22 working days or 600–900 per calendar
month. Most days are far below the burst scenario; the test exists to expose
queue backlog, duplicate processing and retry behaviour rather than to prove a
throughput number.

## Executed local run — 21 November 2026

Command (isolated local `mfbmt_test`, providers mocked, no production URL):

```bash
LOAD_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_test \
LOAD_TEST_CONFIRM=YES LOAD_TEST_COUNT=30 LOAD_TEST_ORG_SLUG=ogs \
npx tsx src/scripts/load-test.ts
```

Result after fixing the conversation race found by the first run:

- 30/30 synthetic enquiries ingested; 0 ingest failures.
- Ingest latency: p50 214.2 ms, p95 261 ms, max 270 ms (concurrent burst).
- 60/60 queued jobs completed, 0 failed, 0 left queued/processing.
- Queue wall time: 1,535 ms for one worker; queue wait and completion p50/p95 rounded to 0 ms at this volume.
- AI, email, WhatsApp, web-search and exchange-rate providers were disabled/mocked; no external request was made.

This is a local functional/concurrency measurement, not a production capacity guarantee. The initial run exposed a real read-then-create race (7/30 failures), which is now covered by `tests/concurrent-intake.test.ts`.
