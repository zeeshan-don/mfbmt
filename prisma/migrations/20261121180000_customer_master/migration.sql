-- Phase 5 customer master and tier pricing. Additive and forward-only.
CREATE TABLE IF NOT EXISTS "Customer" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "taxNumber" TEXT,
  "country" TEXT,
  "tier" TEXT NOT NULL DEFAULT 'STANDARD',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "CustomerContact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "customerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Enquiry" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "CustomerQuotation" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "PricingRule" ADD COLUMN IF NOT EXISTS "customerTier" TEXT;
CREATE INDEX IF NOT EXISTS "Customer_organizationId_name_idx" ON "Customer"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "Customer_organizationId_email_idx" ON "Customer"("organizationId", "email");
CREATE INDEX IF NOT EXISTS "CustomerContact_customerId_idx" ON "CustomerContact"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerContact_organizationId_idx" ON "CustomerContact"("organizationId");
CREATE INDEX IF NOT EXISTS "Enquiry_customerId_idx" ON "Enquiry"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerQuotation_customerId_idx" ON "CustomerQuotation"("customerId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_organizationId_fkey') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerContact_organizationId_fkey') THEN
    ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerContact_customerId_fkey') THEN
    ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Enquiry_customerId_fkey') THEN
    ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerQuotation_customerId_fkey') THEN
    ALTER TABLE "CustomerQuotation" ADD CONSTRAINT "CustomerQuotation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
