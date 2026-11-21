# 15-minute OGS demo

Use only synthetic data. Do not use real supplier or customer contacts.

## Setup

```bash
npm run db:seed          # requires DEMO_MODE=true and SEED_DEMO_DATA=true; refused in production
npm run dev
```

Seed demo records use the non-deliverable `.test` domain and are labelled as sample data. The walkthrough does not call Meta, Google, Microsoft, AI, search, FX or storage providers unless those connections are explicitly configured.

## Click path

1. **Overview** — point out the queue, worker state and sample-data badge.
2. **Enquiries → synthetic OGS RFQ** — show the customer message, extracted line items, missing technical fields and the clarification prompt.
3. **Sourcing** — show stock coverage and supplier evidence. Emphasise that a web listing is evidence, never a confirmed price.
4. **Supplier reply** — open a synthetic reply, show unverified draft offer and the one-click human confirmation.
5. **Approvals** — show the three separate approvals: supplier/offer, quotation, release. No bulk bypass.
6. **Quotation** — show letterhead, technical line fields, validity, PDF and the no-cost/no-margin customer rule.
7. **Usage & cost** — show the monthly evidence page and the AED conversion; explain incomplete FX.
8. **Settings → MFA** — show TOTP setup and recovery codes on the owner account.
9. **Activity** — show audit entries and dead-letter retry visibility.

## What to say honestly

- The 60-case evaluation is synthetic and rules-only; real OGS mail must be used in a supervised pilot.
- Live provider checks are required before calling any integration connected.
- Supplier discovery/outreach, the optional second AI pass, stock reservations and several Phase 5/6 reports are not built (see LIMITATIONS).
- No purchase, payment or customer send happens without recorded human approval.
