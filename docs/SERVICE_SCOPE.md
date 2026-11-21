# Service scope

## Included

- Multi-tenant procurement workspace for OGS and MFBMT.
- WhatsApp/email intake, AI-assisted reading with a deterministic fallback, review, stock lookup, supplier discovery where a provider is connected, supplier RFQ drafting and matching replies, comparison, three human approvals, and customer quotation PDF/email/WhatsApp release.
- OGS product schemas for pipes, valves, flanges, fittings, gaskets, insulation kits, chemicals, industrial spares and service lines.
- AI/search usage metering, per-organization limits, monthly usage evidence, audit logs and operational alerts.
- Owner account security with TOTP MFA and recovery codes.

## Default limits

| Limit | Default |
| --- | --- |
| Sourced items per enquiry | 5 (configurable) |
| Search queries per item | 2; OGS default 3 |
| Web search | On; can be disabled per organization |
| Search cache | 7 days |
| Monthly AI budget | AED 100 general; AED 250 OGS default, configurable |
| Monthly enquiry allowance | 500 general; 1,200 OGS default, configurable |

Enquiries above a limit are retained for review; they are not silently dropped. AI budget exhaustion falls back to the rules parser. A missing FX rate makes a total incomplete rather than assumed.

## Not included / not claimed

- Regulatory, hazardous-material or SDS compliance advice. SDS/COA fields are evidence fields only.
- Purchasing, payment, customs clearance or logistics execution.
- Guaranteed supplier prices, stock availability or delivery dates. Supplier claims remain unverified until a human confirms them.
- Cloud hosting, provider subscription fees, Meta/Google/Microsoft approval outcomes, or client data cleanup.
- Automatic approval of any commercial commitment. A human must approve sourcing, quotation release and pricing exceptions.
- Features listed as not built in `docs/LIMITATIONS.md`, including the optional second AI pass, supplier prospect outreach, stock reservations, retention automation and full quotation outcome reporting.

## Client responsibilities

Provider accounts and approvals, mailbox/WhatsApp access, inventory and supplier data, letterhead/terms, approver identities, accurate business decisions and timely reconnect after token expiry. OGS remains responsible for the commercial quotation sent to its customers.
