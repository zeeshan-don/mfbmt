# Human tasks before go-live

Only tasks that genuinely need a person are listed. The code and automated checks are expected to be complete first.

| # | Owner | Task | Expected time | Link / evidence |
| --- | --- | --- | --- | --- |
| 1 | MFBMT + OGS | Confirm contract, scope, data-processing terms and named approvers. | Commercial | Signed agreement |
| 2 | MFBMT | Create the `ogs` organization and invite its first owner. | 15 min | `npm run provision:org`, `npm run provision:owner:invite` |
| 3 | OGS | Supply legal name, address, TRN, phone, email, logo and quotation terms. | 30 min | Settings → Company |
| 4 | OGS | Supply inventory file and confirm units/locations. | 1–2 h | Settings → Inventory |
| 5 | OGS | Supply supplier list, payment terms, countries, currencies and do-not-contact list. | 1–2 h | Settings/Suppliers |
| 6 | OGS/MFBMT | Create AI provider account and API key; agree monthly budget. | 30 min | Provider console |
| 7 | OGS/MFBMT | Create search provider account (Tavily/Serper/Brave). | 30 min | Provider console |
| 8 | OGS/MFBMT | Create FX provider account or sign off the fixed USD/AED peg. | 15 min | Provider console / written approval |
| 9 | MFBMT | Create Vercel project, PostgreSQL database and private R2/S3 bucket; set DNS/TLS. | 2–4 h | Vercel, database and bucket consoles |
| 10 | OGS/Meta | Create Meta app, complete business verification, own WhatsApp Business number, approve templates. | 1–10 days | Meta Business Suite |
| 11 | OGS/Google | Create Google Cloud project, configure OAuth consent/verification and mailbox access. | 1–5 days | Google Cloud Console |
| 12 | OGS/Microsoft | Register app, grant admin consent and mailbox access if Outlook is used. | 1–2 days | Entra admin center |
| 13 | MFBMT | Enter production environment variables and run migrations after a verified backup. | 1 h | `.env.production.example`, RUNBOOK |
| 14 | MFBMT | Run `npm run check:storage`, `npm run verify:live` (when built) and `npm run check:golive`. | 1 h | Command output |
| 15 | MFBMT + OGS | Supervised pilot with real enquiries; compare extraction, sourcing and quotations to human work. | 1 week | Pilot notes |
| 16 | MFBMT | Tune vocabulary/prompts and rerun `npm run eval:extraction` on approved real examples. | Ongoing | Eval output |
| 17 | OGS | Formally accept limitations and begin live intake. | 30 min | Signed acceptance |

Provider dashboards and approval outcomes cannot be automated from this repository. A key being present is not proof of connection; only a recorded live test is.
