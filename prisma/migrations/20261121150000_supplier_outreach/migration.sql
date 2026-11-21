-- Phase 4 supplier outreach. Additive and forward-only.
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "domain" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "typicalLeadTimeDays" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "lastQuotedAt" TIMESTAMP(3);
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "doNotContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "discoveredFromUrl" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "discoveredAt" TIMESTAMP(3);
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3);
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bounceReason" TEXT;

ALTER TABLE "SupplierContact" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
ALTER TABLE "SupplierContact" ADD COLUMN IF NOT EXISTS "retrievedAt" TIMESTAMP(3);

ALTER TABLE "SupplierQuote" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);
ALTER TABLE "SupplierQuote" ADD COLUMN IF NOT EXISTS "reminderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SupplierQuote" ADD COLUMN IF NOT EXISTS "bounceAt" TIMESTAMP(3);
ALTER TABLE "SupplierQuote" ADD COLUMN IF NOT EXISTS "bounceReason" TEXT;

CREATE INDEX IF NOT EXISTS "Supplier_organizationId_domain_idx" ON "Supplier"("organizationId", "domain");
