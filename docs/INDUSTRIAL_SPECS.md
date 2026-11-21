# OGS industrial specification extraction

The OGS tenant uses six deterministic, versioned specifications defined in
`src/lib/catalog/industrialSpec.ts`:

| Category | Required attributes (schema, not invented at request time) |
| --- | --- |
| Pipes | material, grade, nominal size, outside diameter, wall thickness, schedule, standard, end preparation |
| Valves | valve type, size, pressure class, end connection, body material, trim material, operation, standard |
| Flanges | flange type, nominal size, pressure class, facing, material, grade, standard |
| Fittings | fitting type, size, schedule, material, grade, connection, standard |
| Chemicals | product name, chemical grade, purity, physical form, packaging, quantity, unit |
| Industrial Spares | manufacturer, part number, compatible equipment, specifications |

## Enable per tenant

`Organization.procurementProfile` is `GENERAL` by default and keeps MFBMT's
existing generic/fastener behaviour unchanged. When it is `INDUSTRIAL`, the
enquiry extraction pipeline additionally produces an industrial specification.

The additive migration adds the column and the `EnquiryItem.industrialSpecJson`
/ `Product.industrialSpecJson` fields. It does **not** change any existing row.
Enabling OGS is a separate, auditable operator action:

```sql
UPDATE "Organization" SET "procurementProfile" = 'INDUSTRIAL' WHERE "slug" = 'ogs';
```

This is a production data change: apply it only with separate authorization and
after the migration is deployed.

## Extraction rules

1. AI may interpret the message or document, but deterministic code decides what
   is present and what is missing.
2. Only values stated in the source are stored. Missing material, grade,
   dimensions, standard, quantity or pressure rating is never guessed.
3. The customer's original description and source reference (page/sheet/row/message)
   are preserved alongside the structured values.
4. The result is a versioned JSON object:

```json
{
  "version": 1,
  "category": "Pipes",
  "attributes": { "material": "SS316", "schedule": "SCH40" },
  "missingRequired": ["Outside diameter", "Wall thickness"],
  "missingOptional": ["Coating"],
  "confidence": {},
  "source": "EXTRACTED"
}
```

`source` becomes `MANUAL` after an owner correction and
`SUPPLIER_CONFIRMED` when a supplier response states the value.

## Missing fields and clarification

Missing required attributes become owner-visible missing fields and a
clarification question, for example:

> Please confirm the outside diameter, wall thickness for 6 inch SCH 40 SS316.

Suppliers are not searched and stock is not promised while required attributes
are missing. The enquiry review screen shows each attribute, its source and
whether it is missing; the owner can correct and confirm it.

## Matching

`matchProduct()` uses `compareIndustrialSpec()` whenever the request carries an
industrial specification (and is not a fastener). The comparison is
deterministic:

* `EXACT` — every required attribute agrees after unit/normalisation.
* `EQUIVALENT` — only an explicitly owner-approved material substitution.
* `INSUFFICIENT` — a required attribute is missing on either side. Never EXACT.
* `NO_MATCH` — a required attribute conflicts (for example wall thickness or
  pressure class). Price can never override this.

MFBMT fastener items never enter this path: they keep the versioned
`src/lib/fasteners/spec.ts` matcher. Items without an industrial specification
keep the existing generic matcher unchanged.

## Tests

`tests/industrial-spec.test.ts`, `tests/industrial-extraction.test.ts`,
`tests/matching.test.ts` and `tests/fastener-inventory.test.ts` cover category
detection, missing-field behaviour, no invented values, exact/conflicting/
insufficient comparisons and fastener non-regression.
