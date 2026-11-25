-- Semantic enquiry context (Part A) and supplier-facing RFQ draft quality (Part B).
-- Additive and backward compatible: existing rows receive an empty instruction
-- list and a null quality report.

ALTER TABLE "Enquiry"
  ADD COLUMN "urgency" TEXT,
  ADD COLUMN "requestedDeliveryTimeframe" TEXT,
  ADD COLUMN "customerInstructionsJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "SupplierQuote"
  ADD COLUMN "draftQualityJson" TEXT;
