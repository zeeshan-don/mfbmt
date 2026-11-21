-- Phase 5 quotation quality. Additive and forward-only.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "minMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "changeSummary" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "outcomeReason" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "outcomeAt" TIMESTAMP(3);
ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "marginExceptionReason" TEXT;

ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "countryOfOrigin" TEXT;
ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "certification" TEXT;
ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "leadTimeDays" INTEGER;
ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "deliveryTerms" TEXT;
ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "validityDate" TIMESTAMP(3);
ALTER TABLE "CustomerQuotationItem" ADD COLUMN IF NOT EXISTS "technicalNotes" TEXT;
