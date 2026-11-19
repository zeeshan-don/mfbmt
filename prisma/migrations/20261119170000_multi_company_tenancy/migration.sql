-- Forward-only multi-tenancy migration.
--
-- Safety contract:
--   * No table is dropped, recreated or truncated.
--   * Existing rows are backfilled to MFBMT's organization before any column
--     becomes NOT NULL, so historical data keeps its ownership.
--   * Global unique keys become organization-scoped keys, which is a relaxation
--     for existing data: no existing row can violate the new index.
--   * Rollback: restore the pre-migration backup (see docs/DATABASE.md). The SQL
--     is additive; a reverse migration would only drop the new columns/indexes.

-- ── 1. Organization: preserve MFBMT, add tenant configuration ────────────────

INSERT INTO "Organization" ("id", "name", "updatedAt")
SELECT 'org_mfbmt', 'Multi Fasteners Building Materials Trading LLC', now()
WHERE NOT EXISTS (SELECT 1 FROM "Organization");

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "slug" TEXT,
  ADD COLUMN IF NOT EXISTS "country" TEXT NOT NULL DEFAULT 'AE',
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
  ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "logo" TEXT,
  ADD COLUMN IF NOT EXISTS "quotationPrefix" TEXT NOT NULL DEFAULT 'QT',
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'trn') THEN
    ALTER TABLE "Organization" RENAME COLUMN "trn" TO "taxRegistrationNumber";
  END IF;
END $$;

UPDATE "Organization"
   SET "slug" = CASE
     WHEN "id" = 'org_mfbmt' THEN 'mfbmt'
     ELSE lower(regexp_replace(coalesce("name", "id"), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(md5("id"), 6)
   END
 WHERE "slug" IS NULL;

ALTER TABLE "Organization" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX IF NOT EXISTS "Organization_status_idx" ON "Organization"("status");

-- OGS is provisioned as an independent, empty tenant. No MFBMT record is
-- copied and no legal detail is invented: the owner completes onboarding.
INSERT INTO "Organization" ("id", "slug", "name", "country", "timezone", "defaultCurrency", "quotationPrefix", "status", "taxEnabled", "updatedAt")
SELECT 'org_ogs', 'ogs', 'OGS & Chemicals FZC', 'AE', 'Asia/Dubai', 'AED', 'OGS', 'ACTIVE', false, now()
WHERE NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = 'org_ogs');

-- ── 2. Add organization ownership to every tenant table ─────────────────────
-- MFBMT is the single pre-existing tenant, so every historical row belongs to it.

ALTER TABLE "User" ADD COLUMN "organizationId" TEXT;
UPDATE "User" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

ALTER TABLE "Session" ADD COLUMN "organizationId" TEXT;
UPDATE "Session" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "User" WHERE "User"."id" = "Session"."userId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "Session" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Session_organizationId_idx" ON "Session"("organizationId");

ALTER TABLE "Contact" ADD COLUMN "organizationId" TEXT;
UPDATE "Contact" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Contact" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");

ALTER TABLE "ExcludedContact" ADD COLUMN "organizationId" TEXT;
UPDATE "ExcludedContact" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "ExcludedContact" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ExcludedContact" ADD CONSTRAINT "ExcludedContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ExcludedContact_organizationId_idx" ON "ExcludedContact"("organizationId");

ALTER TABLE "Conversation" ADD COLUMN "organizationId" TEXT;
UPDATE "Conversation" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Conversation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Conversation_organizationId_idx" ON "Conversation"("organizationId");

ALTER TABLE "Message" ADD COLUMN "organizationId" TEXT;
UPDATE "Message" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Message" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Message_organizationId_idx" ON "Message"("organizationId");

ALTER TABLE "Attachment" ADD COLUMN "organizationId" TEXT;
UPDATE "Attachment" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Attachment" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Attachment_organizationId_idx" ON "Attachment"("organizationId");

ALTER TABLE "Enquiry" ADD COLUMN "organizationId" TEXT;
UPDATE "Enquiry" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Enquiry" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Enquiry_organizationId_idx" ON "Enquiry"("organizationId");

ALTER TABLE "EnquiryItem" ADD COLUMN "organizationId" TEXT;
UPDATE "EnquiryItem" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Enquiry" WHERE "Enquiry"."id" = "EnquiryItem"."enquiryId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "EnquiryItem" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "EnquiryItem" ADD CONSTRAINT "EnquiryItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "EnquiryItem_organizationId_idx" ON "EnquiryItem"("organizationId");

ALTER TABLE "Product" ADD COLUMN "organizationId" TEXT;
UPDATE "Product" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Product" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Product_organizationId_idx" ON "Product"("organizationId");

ALTER TABLE "ProductSpecification" ADD COLUMN "organizationId" TEXT;
UPDATE "ProductSpecification" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Product" WHERE "Product"."id" = "ProductSpecification"."productId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "ProductSpecification" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ProductSpecification" ADD CONSTRAINT "ProductSpecification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ProductSpecification_organizationId_idx" ON "ProductSpecification"("organizationId");

ALTER TABLE "InventoryLocation" ADD COLUMN "organizationId" TEXT;
UPDATE "InventoryLocation" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "InventoryLocation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "InventoryLocation_organizationId_idx" ON "InventoryLocation"("organizationId");

ALTER TABLE "InventoryStock" ADD COLUMN "organizationId" TEXT;
UPDATE "InventoryStock" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Product" WHERE "Product"."id" = "InventoryStock"."productId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "InventoryStock" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InventoryStock" ADD CONSTRAINT "InventoryStock_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "InventoryStock_organizationId_idx" ON "InventoryStock"("organizationId");

ALTER TABLE "InventoryMovement" ADD COLUMN "organizationId" TEXT;
UPDATE "InventoryMovement" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Product" WHERE "Product"."id" = "InventoryMovement"."productId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "InventoryMovement" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "InventoryMovement_organizationId_idx" ON "InventoryMovement"("organizationId");

ALTER TABLE "Supplier" ADD COLUMN "organizationId" TEXT;
UPDATE "Supplier" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Supplier" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Supplier_organizationId_idx" ON "Supplier"("organizationId");

ALTER TABLE "SupplierContact" ADD COLUMN "organizationId" TEXT;
UPDATE "SupplierContact" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Supplier" WHERE "Supplier"."id" = "SupplierContact"."supplierId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SupplierContact" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SupplierContact_organizationId_idx" ON "SupplierContact"("organizationId");

ALTER TABLE "SupplierProduct" ADD COLUMN "organizationId" TEXT;
UPDATE "SupplierProduct" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Supplier" WHERE "Supplier"."id" = "SupplierProduct"."supplierId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SupplierProduct" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SupplierProduct_organizationId_idx" ON "SupplierProduct"("organizationId");

ALTER TABLE "SearchSession" ADD COLUMN "organizationId" TEXT;
UPDATE "SearchSession" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "EnquiryItem" WHERE "EnquiryItem"."id" = "SearchSession"."enquiryItemId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SearchSession" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SearchSession" ADD CONSTRAINT "SearchSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SearchSession_organizationId_idx" ON "SearchSession"("organizationId");

ALTER TABLE "SearchQuery" ADD COLUMN "organizationId" TEXT;
UPDATE "SearchQuery" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "SearchSession" WHERE "SearchSession"."id" = "SearchQuery"."sessionId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SearchQuery" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SearchQuery" ADD CONSTRAINT "SearchQuery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SearchQuery_organizationId_idx" ON "SearchQuery"("organizationId");

ALTER TABLE "SearchResult" ADD COLUMN "organizationId" TEXT;
UPDATE "SearchResult" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "SearchSession" WHERE "SearchSession"."id" = "SearchResult"."sessionId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SearchResult" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SearchResult_organizationId_idx" ON "SearchResult"("organizationId");

ALTER TABLE "SupplierOffer" ADD COLUMN "organizationId" TEXT;
UPDATE "SupplierOffer" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "EnquiryItem" WHERE "EnquiryItem"."id" = "SupplierOffer"."enquiryItemId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SupplierOffer" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SupplierOffer" ADD CONSTRAINT "SupplierOffer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SupplierOffer_organizationId_idx" ON "SupplierOffer"("organizationId");

ALTER TABLE "SupplierQuote" ADD COLUMN "organizationId" TEXT;
UPDATE "SupplierQuote" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Supplier" WHERE "Supplier"."id" = "SupplierQuote"."supplierId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SupplierQuote" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SupplierQuote" ADD CONSTRAINT "SupplierQuote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SupplierQuote_organizationId_idx" ON "SupplierQuote"("organizationId");

ALTER TABLE "SupplierQuoteItem" ADD COLUMN "organizationId" TEXT;
UPDATE "SupplierQuoteItem" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "SupplierQuote" WHERE "SupplierQuote"."id" = "SupplierQuoteItem"."quoteId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "SupplierQuoteItem" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SupplierQuoteItem" ADD CONSTRAINT "SupplierQuoteItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SupplierQuoteItem_organizationId_idx" ON "SupplierQuoteItem"("organizationId");

ALTER TABLE "Approval" ADD COLUMN "organizationId" TEXT;
UPDATE "Approval" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Enquiry" WHERE "Enquiry"."id" = "Approval"."enquiryId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "Approval" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Approval_organizationId_idx" ON "Approval"("organizationId");

ALTER TABLE "CustomerQuotation" ADD COLUMN "organizationId" TEXT;
UPDATE "CustomerQuotation" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "Enquiry" WHERE "Enquiry"."id" = "CustomerQuotation"."enquiryId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "CustomerQuotation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "CustomerQuotation" ADD CONSTRAINT "CustomerQuotation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CustomerQuotation_organizationId_idx" ON "CustomerQuotation"("organizationId");

ALTER TABLE "CustomerQuotationItem" ADD COLUMN "organizationId" TEXT;
UPDATE "CustomerQuotationItem" SET "organizationId" = COALESCE((SELECT "organizationId" FROM "CustomerQuotation" WHERE "CustomerQuotation"."id" = "CustomerQuotationItem"."quotationId"), 'org_mfbmt') WHERE "organizationId" IS NULL;
ALTER TABLE "CustomerQuotationItem" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "CustomerQuotationItem" ADD CONSTRAINT "CustomerQuotationItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CustomerQuotationItem_organizationId_idx" ON "CustomerQuotationItem"("organizationId");

ALTER TABLE "PricingRule" ADD COLUMN "organizationId" TEXT;
UPDATE "PricingRule" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "PricingRule" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PricingRule_organizationId_idx" ON "PricingRule"("organizationId");

ALTER TABLE "MaterialEquivalence" ADD COLUMN "organizationId" TEXT;
UPDATE "MaterialEquivalence" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "MaterialEquivalence" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "MaterialEquivalence" ADD CONSTRAINT "MaterialEquivalence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MaterialEquivalence_organizationId_idx" ON "MaterialEquivalence"("organizationId");

ALTER TABLE "Integration" ADD COLUMN "organizationId" TEXT;
UPDATE "Integration" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Integration" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");

ALTER TABLE "BackgroundJob" ADD COLUMN "organizationId" TEXT;
UPDATE "BackgroundJob" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "BackgroundJob" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "BackgroundJob_organizationId_idx" ON "BackgroundJob"("organizationId");

ALTER TABLE "WebhookEvent" ADD COLUMN "organizationId" TEXT;
UPDATE "WebhookEvent" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "WebhookEvent" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "WebhookEvent_organizationId_idx" ON "WebhookEvent"("organizationId");

ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;
UPDATE "AuditLog" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
-- Null remains valid for platform/auth events that occur before a tenant is known.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

ALTER TABLE "Notification" ADD COLUMN "organizationId" TEXT;
UPDATE "Notification" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

ALTER TABLE "ExchangeRate" ADD COLUMN "organizationId" TEXT;
UPDATE "ExchangeRate" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "ExchangeRate" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ExchangeRate_organizationId_idx" ON "ExchangeRate"("organizationId");

-- ── 3. Organization-scoped unique keys ──────────────────────────────────────

DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

DROP INDEX IF EXISTS "ExcludedContact_identifier_key";
CREATE UNIQUE INDEX "ExcludedContact_organizationId_identifier_key" ON "ExcludedContact"("organizationId", "identifier");

DROP INDEX IF EXISTS "Conversation_channel_externalId_key";
CREATE UNIQUE INDEX "Conversation_organizationId_channel_externalId_key" ON "Conversation"("organizationId", "channel", "externalId");

DROP INDEX IF EXISTS "Message_externalMessageId_key";
CREATE UNIQUE INDEX "Message_organizationId_channel_externalMessageId_key" ON "Message"("organizationId", "channel", "externalMessageId");

DROP INDEX IF EXISTS "Enquiry_publicRef_key";
CREATE UNIQUE INDEX "Enquiry_organizationId_publicRef_key" ON "Enquiry"("organizationId", "publicRef");

DROP INDEX IF EXISTS "Product_sku_key";
CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON "Product"("organizationId", "sku");

DROP INDEX IF EXISTS "InventoryLocation_code_key";
CREATE UNIQUE INDEX "InventoryLocation_organizationId_code_key" ON "InventoryLocation"("organizationId", "code");

DROP INDEX IF EXISTS "MaterialEquivalence_requestedMaterial_offeredMaterial_reque_key";
CREATE UNIQUE INDEX "MaterialEquivalence_organizationId_requestedMaterial_offere_key"
  ON "MaterialEquivalence"("organizationId", "requestedMaterial", "offeredMaterial", "requestedGrade", "offeredGrade");

DROP INDEX IF EXISTS "Integration_key_key";
CREATE UNIQUE INDEX "Integration_organizationId_key_key" ON "Integration"("organizationId", "key");

DROP INDEX IF EXISTS "BackgroundJob_idempotencyKey_key";
CREATE UNIQUE INDEX "BackgroundJob_organizationId_idempotencyKey_key" ON "BackgroundJob"("organizationId", "idempotencyKey");

DROP INDEX IF EXISTS "WebhookEvent_provider_externalId_key";
CREATE UNIQUE INDEX "WebhookEvent_organizationId_provider_externalId_key" ON "WebhookEvent"("organizationId", "provider", "externalId");

DROP INDEX IF EXISTS "CustomerQuotation_quoteNumber_key";
CREATE UNIQUE INDEX "CustomerQuotation_organizationId_quoteNumber_key" ON "CustomerQuotation"("organizationId", "quoteNumber");

DROP INDEX IF EXISTS "Approval_type_entityId_pending_key";
CREATE UNIQUE INDEX "Approval_organizationId_type_entityId_pending_key"
  ON "Approval"("organizationId", "type", "entityId")
  WHERE status = 'PENDING';

-- ── 4. Composite primary keys for per-tenant counters and settings ──────────

ALTER TABLE "NumberSequence" ADD COLUMN "organizationId" TEXT;
UPDATE "NumberSequence" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "NumberSequence" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "NumberSequence" DROP CONSTRAINT "NumberSequence_pkey";
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("organizationId", "scope");
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppSetting" ADD COLUMN "organizationId" TEXT;
UPDATE "AppSetting" SET "organizationId" = 'org_mfbmt' WHERE "organizationId" IS NULL;
ALTER TABLE "AppSetting" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "AppSetting" DROP CONSTRAINT "AppSetting_pkey";
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("organizationId", "key");
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 5. Fail-closed default ──────────────────────────────────────────────────
-- Prisma create inputs need a default so every model stays type-safe, but the
-- guard always overwrites it with the authenticated tenant. Any unguarded raw
-- insert therefore uses a sentinel that has no matching Organization and fails
-- the foreign key instead of silently writing into another company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','Session','Contact','ExcludedContact','Conversation','Message','Attachment',
    'Enquiry','EnquiryItem','Product','ProductSpecification','InventoryLocation',
    'InventoryStock','InventoryMovement','Supplier','SupplierContact','SupplierProduct',
    'SearchSession','SearchQuery','SearchResult','SupplierOffer','SupplierQuote',
    'SupplierQuoteItem','Approval','CustomerQuotation','CustomerQuotationItem',
    'PricingRule','MaterialEquivalence','Integration','BackgroundJob','WebhookEvent',
    'NumberSequence','AuditLog','Notification','ExchangeRate','AppSetting'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "organizationId" SET DEFAULT ''__unset__''', t);
  END LOOP;
END $$;
