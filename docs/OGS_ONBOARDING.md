# OGS onboarding

This is the client-facing hand-off. Work through it in order; the code cannot invent business identity, provider approvals or stock data.

## 1. Commercial and account setup (owner: MFBMT)

- [ ] Confirm the OGS legal entity, billing contact, approved users and who may approve supplier RFQs and customer quotations.
- [ ] Create the `ogs` organization with `npm run provision:org` and invite the owner with `npm run provision:owner:invite`.
- [ ] Record the commercial scope and limits in `docs/SERVICE_SCOPE.md`.

## 2. Company identity (owner: OGS)

- [ ] Registered legal name, trading name, TRN, address, phone, email and website.
- [ ] Logo for the quotation letterhead (PNG/JPG, private storage or HTTPS URL).
- [ ] Default quotation terms and validity period.
- [ ] Confirmation that OGS uses the industrial procurement profile.

## 3. Intake channels

### WhatsApp
- [ ] Meta Business account and app; business verification completed by OGS/Meta.
- [ ] Dedicated WhatsApp Business number that OGS controls.
- [ ] `META_APP_ID`, `META_APP_SECRET`, Embedded Signup configuration and verify token set.
- [ ] Owner completes Embedded Signup and a live connection test.
- [ ] If business-initiated messages are needed, submit message templates to Meta and configure them per organization. Free-form sends outside the 24-hour window are expected to fail visibly.

### Email
- [ ] Choose Gmail, Microsoft 365 or inbound forwarding.
- [ ] Google Cloud project, OAuth consent screen and `gmail.readonly`/`gmail.send` scopes; add test users while in testing mode.
- [ ] Or Microsoft Entra app registration, `Mail.Read`/`Mail.Send`, admin consent and redirect URI.
- [ ] Connect the mailbox in Settings and run a live test.
- [ ] Know that Google testing-mode refresh tokens expire; reconnect when the banner appears.

## 4. Sourcing and cost inputs

- [ ] AI provider account, API key, model and an agreed monthly AI budget.
- [ ] Web-search provider account (Tavily, Serper or Brave).
- [ ] FX provider account, or written acceptance of the fixed USD/AED peg. Cross-currency totals without a rate stay incomplete.
- [ ] Private S3-compatible bucket (Cloudflare R2 or AWS S3) with credentials, endpoint and region.
- [ ] Inventory export in the supported Excel/CSV format; confirm units and stock locations.
- [ ] Supplier list with categories, countries, currencies, payment terms and contacts.
- [ ] Do-not-contact list and any existing customer exclusions.

## 5. Verification before go-live

```bash
npm run verify:live        # not yet implemented; see LIMITATIONS
npm run check:storage
npm run eval:extraction
npm run check:golive
```

`check:golive` must pass except for checks listed in `docs/HUMAN_TASKS.md`. Run one supervised pilot with real enquiries and compare extracted fields and quotations against human work before switching intake over.

## 6. Operating routine

- Owner reviews needs-review enquiries and the three approvals daily.
- Owner checks `/usage` monthly for AI/search/quote evidence.
- Reconnect expired mailboxes immediately; do not assume polling is healthy without the Settings connection state.
- Export or delete tenant data only through the documented operator process.
