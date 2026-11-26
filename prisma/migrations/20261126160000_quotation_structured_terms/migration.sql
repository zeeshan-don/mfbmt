-- Separate structured commercial terms from generic legal quotation boilerplate.
-- Additive only: existing `terms` text is retained as legal boilerplate and is
-- never treated as a payment or delivery-term baseline.

ALTER TABLE "CustomerQuotation" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN "deliveryTerms" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN "deliveryAddress" TEXT;

ALTER TABLE "CustomerQuotationItem" ADD COLUMN "deliveryLocation" TEXT;
