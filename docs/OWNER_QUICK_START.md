# MFBMT Owner Quick Start

This guide describes the current owner workflow in the application. It is intentionally operational, not a feature catalogue.

## Start here: Overview → Your next actions

Open the Overview page after signing in. For an Owner account, the **Your next actions** list is the working queue.

Each row represents the most important outstanding action for an enquiry or active sales order. Open the row's action link, complete or resolve that step, then return to Overview. The queue is derived from the underlying enquiry, sourcing, approval, supplier, quotation and order records; it is not a separate task list.

Priorities mean:

- **Urgent** — a customer acceptance, blocking issue, overdue supplier delivery or overdue invoice needs attention.
- **Needs attention** — an approval, supplier offer, clarification or overdue response needs review.
- **Ready** — the enquiry/order has reached a stage where the next operational step can begin.

The queue intentionally displays one primary action per enquiry/order. When an enquiry has one active sales order, its remaining enquiry-level work is grouped with that order to reduce duplicate rows. If an enquiry has multiple active orders, it remains separate because the system must not guess which order owns the enquiry-level action.

## Typical enquiry-to-quotation flow

1. **Review the enquiry** when the queue says the customer request needs review. Check the extracted products, quantities, units and customer instructions against the original email and attachments.
2. **Resolve missing specifications** before relying on supplier matching. Do not guess a material, grade, size, standard or pressure class.
3. **Check stock and sourcing** from the enquiry/sourcing workspace. Review supplier evidence rather than treating a search result as proof of stock.
4. **Review supplier replies** when the queue asks for an offer to be verified. Check the original email/attachment, commercial fields and technical compatibility. Offers remain unverified until an owner confirms them.
5. **Approve supplier RFQs and customer quotations** from the approval workflow. Check the recipient, item descriptions, quantities, terms and generated message before sending.
6. **Follow up** when a customer quotation or supplier request has been waiting without a response. Check the conversation first; do not send a duplicate reminder if a reply has arrived but has not yet been processed.

## After the customer accepts

1. Review the customer PO/acceptance against the exact quotation version.
2. Resolve any changed quantities, prices, specifications, delivery or payment terms before confirming the order.
3. Open the sales order and review the procurement plan.
4. Approve and send supplier purchase orders where required.
5. Review supplier acknowledgements and deviations.
6. Record goods receipts and discrepancies as goods arrive.
7. Prepare and record customer deliveries.
8. Review invoices, receivables, supplier bills and payments.
9. Close the order only when the actual outstanding obligations are resolved under the organisation's closure policy.

## Commercial and safety rules

- Supplier offers are not purchasing commitments until reviewed and confirmed.
- A supplier RFQ is not a purchase order.
- A customer quotation is not an accepted sales order.
- A supplier's catalogue page does not prove current stock or quantity availability.
- Unknown values must remain unknown; do not enter zero to fill a missing price, tax, lead time or quantity.
- Review currency on every commercial amount. Never add AED, USD or other currencies into one total without a documented FX rate.
- Sending a supplier RFQ, customer quotation, supplier PO or invoice is an external action. Review the actual recipient and document and use the existing approval/send workflow.
- If a document was only partially read, resolve the exception before relying on the extracted values.

## What the Overview does not replace

The Overview is the starting point, not a replacement for the detailed enquiry, sourcing, approval, supplier reply, quotation or sales-order pages. Each action opens the module that owns the underlying business record. Use those pages for evidence, edits and approvals.

## Known handover limitation

The current owner queue is a record-backed starting point for the Owner account. It does not yet implement a separate Sales role, assigned customer portfolio or persistent customer follow-up task system. Do not promise those capabilities to staff until they are implemented and tested.
