# Real-enquiry evaluation folder

This folder is for **anonymised** customer enquiries supplied by OGS. Do not put
names, phone numbers, email addresses, prices or other customer identifiers here.
Keep the original documents in the client's system and use neutral IDs.

Create `eval/real-enquiries/` with one `.txt` or `.md` file per enquiry, named by
its ID:

```
eval/real-enquiries/enquiry-001.txt
eval/real-enquiries/enquiry-002.txt
```

Copy `real-labels.template.json` to `eval/real-enquiries/labels.json` and fill in
the expected classification and first product line for each file:

```json
{
  "cases": [
    {
      "id": "enquiry-001",
      "sourceKind": "EMAIL",
      "expected": { "rfq": true, "quantity": 2, "category": "Valves" }
    }
  ]
}
```

Run:

```bash
npm run eval:extraction -- --folder eval/real-enquiries
npm run eval:extraction -- --folder eval/real-enquiries --both
```

`--both` runs the rules-only parser and the configured AI provider separately.
If no AI key is configured, the AI section is reported as skipped, never as a
pass. The report is measured only against the labels you supplied; it is not an
OGS-wide accuracy claim.
