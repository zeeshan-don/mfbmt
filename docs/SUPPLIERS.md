# Suppliers, sourcing and comparison

## Supplier records

A supplier is not just a name. The record carries what the comparison depends on:

- Legal/trading name, country, city, website, main phone and email
- WhatsApp number (used only after an approved send)
- Categories and brands they actually stock
- Payment terms, lead-time notes, minimum order value if known
- **Status** — `ACTIVE`, `PAUSED`, `BLOCKED`, `UNVERIFIED`
- **Verification** — whether identity/trade licence was checked, by whom, when
- Contacts, and recorded catalogue prices (`SupplierProduct`) with the date and the source URL

Rules:

- A `BLOCKED` supplier's offers can never be selected or ranked.
- `PAUSED` suppliers keep history but are not contacted.
- `UNVERIFIED` means the company has not been checked against a trade licence or a known contact. Its offers are shown with a warning and require an explicit owner override to be used.
- Prices and notes are evidence, not truth: every supplier price record shows where it came from and when.

## Where offers come from

| Source | `sourceType` | What is stored |
|---|---|---|
| Web search result page | `WEB_SEARCH` | URL, page title, visible price text, MOQ text, retrieval time, evidence snippet |
| Supplier email/WhatsApp quote typed in by staff | `MANUAL` | The quoted price and the correspondence reference |
| Supplier answered the RFQ link | `SUPPLIER_QUOTE` | Structured price, MOQ, lead time, validity, payment terms |

Nothing is marked verified just because it was found. `verificationStatus` starts as `UNVERIFIED` and is raised only by a human (`CONFIRMED_BY_OWNER`) or by a supplier submitting the RFQ form (`CONFIRMED_BY_SUPPLIER`, still subject to review).

## Matching rules

Each candidate is compared to the **original** requirement using normalised attributes:

- Product family/category
- Size and unit
- Material and grade
- Pressure rating / schedule / standard, where the customer specified one

Outcomes:

| Match | Meaning | Can fulfil? |
|---|---|---|
| `EXACT` | Every required attribute matches | Yes |
| `EQUIVALENT` | Same function, declared equivalent, no attribute is worse | Yes, marked as an alternative |
| `SIMILAR` | Close but a required attribute differs or is unstated | Shown only, needs owner confirmation |
| `NO_MATCH` | Different product, size, material or standard | Excluded |
| `INSUFFICIENT` | Listing does not state a required attribute | Excluded; cannot be assumed |

Only exact/equivalent matches consume stock or become the recommended offer. If the customer asks for SS316 and the listing says "stainless steel", the result is `INSUFFICIENT`, not a guess.

## Landed cost

For each offer the engine computes and stores a snapshot:

```
product cost   = unit price × max(required quantity, MOQ)
shipping       = stated shipping, else unknown
other charges  = stated, else unknown
purchase tax   = only if the quote states a non-recoverable tax
total          = product + shipping + other + tax, converted at the recorded FX rate
```

- **Unknown is not zero.** Missing shipping or another mandatory charge makes the total *incomplete* (`complete=false`) and the offer is not ranked, even if its unit price is the lowest.
- MOQ is respected: an offer cheaper per piece but with an MOQ above the requirement is costed at the MOQ quantity, and the price per required unit is what ranking uses.
- Recoverable VAT is not added to landed cost. It is tracked separately for the buyer's cash-flow view.
- Currency conversion records rate, source and timestamp; no rate means incomplete.

## Ranking and eligibility

1. Eligibility is decided first: match status, quantity available, MOQ ≤ required (or acceptable excess), quote validity, supplier status/verification, required specs known.
2. Among eligible offers with a complete total, rank is by landed cost per required unit.
3. Ineligible and incomplete offers remain visible with the reason, below the ranked list.
4. The owner sees the price difference against the recommended offer, not just an absolute number.
5. The ranking snapshot is stored on the offer, so an approval shows exactly the numbers that were ranked.

## Supplier RFQ (outbound)

From item detail → **Request supplier quote**:

1. The app drafts an item list (description, quantity, required specs, required-by date).
2. A `SupplierQuote` is created with status `AWAITING_APPROVAL`. **Nothing is sent at this point.**
3. An owner approves the send. Only then does the app:
   - email the supplier the item list and a single-use response link, and/or
   - send a WhatsApp message if the supplier has a WhatsApp number,
   - mark the quote `SENT` with a timestamp.
4. The link (`/supplier-response/<token>`) expires after **14 days**. The supplier sees only the requested items — no customer identity, no target price, no other suppliers' prices.
5. Submitting the form records the price, MOQ, lead time, validity, payment terms and notes, then:
   - creates a `SupplierOffer` with `sourceType=SUPPLIER_QUOTE`,
   - marks the item `QUOTE_RECEIVED`,
   - re-runs the comparison including the new offer.
6. A second submission on the same link is refused.

The supplier response page is public but token-scoped: the token is 24 random bytes, invalid tokens return not-found, expired tokens are refused, and the page can only write to that one quote.

## Manual supplier entry

Staff can add an offer found by phone or email:

- Price and currency are mandatory.
- Quantity, MOQ, shipping, lead time, validity and source reference are optional but improve the comparison.
- A manually entered offer is `MANUAL` / `UNVERIFIED` until an owner confirms it.
- It goes through exactly the same matching and landed-cost rules — nothing is bypassed.

## Demo suppliers

The seed creates three clearly-marked sample suppliers (Gulf Fasteners, Emirates Industrial Supply, Al Noor Trading) with different behaviours: a complete competitive offer, an offer whose MOQ makes it ineligible, and a wrong-material listing. They are for demonstration only; delete them before using the system commercially.
