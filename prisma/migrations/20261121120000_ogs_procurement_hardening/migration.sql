-- Additive OGS procurement hardening migration.
--
-- Safety contract:
--   * No table, column or row is dropped, truncated or rewritten.
--   * Every new column is nullable or has a default, so existing MFBMT rows stay valid.
--   * New tenant tables carry organizationId and are covered by the tenant guard.
--   * Rollback: restore the pre-migration backup. A reverse migration would only
--     drop the new tables/columns/indexes.
--
-- This migration has NOT been applied to production. Apply it only through a
-- separately authorised, verified staging/production deployment procedure.

-- ── 1. Organization procurement profile ──────────────────────────────────────
-- GENERAL keeps MFBMT's existing generic/fastener behaviour. INDUSTRIAL enables
-- the versioned OGS industrial schemas for that tenant.
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "procurementProfile" TEXT NOT NULL DEFAULT 'GENERAL';

-- ── 2. Versioned industrial specifications ───────────────────────────────────
ALTER TABLE "EnquiryItem"
  ADD COLUMN IF NOT EXISTS "industrialSpecJson" TEXT;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "industrialSpecJson" TEXT;

-- ── 3. Supplier RFQ correlation identifiers ──────────────────────────────────
ALTER TABLE "SupplierQuote"
  ADD COLUMN IF NOT EXISTS "correlationToken" TEXT,
  ADD COLUMN IF NOT EXISTS "providerThreadId" TEXT,
  ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuote_correlationToken_key"
  ON "SupplierQuote"("correlationToken");

-- ── 4. Inbound supplier email replies ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SupplierEmailReply" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL DEFAULT '__unset__',
  "supplierQuoteId"   TEXT,
  "supplierId"        TEXT,
  "externalMessageId" TEXT NOT NULL,
  "provider"          TEXT NOT NULL,
  "providerThreadId"  TEXT,
  "internetMessageId" TEXT,
  "inReplyTo"         TEXT,
  "referencesHeader"  TEXT,
  "fromAddress"       TEXT NOT NULL,
  "fromName"          TEXT,
  "subject"           TEXT,
  "bodySummary"       TEXT,
  "attachmentsJson"   TEXT NOT NULL DEFAULT '[]',
  "extractedJson"     TEXT,
  "extractionStatus"  TEXT NOT NULL DEFAULT 'PENDING',
  "matchingStatus"    TEXT NOT NULL DEFAULT 'UNMATCHED',
  "reviewStatus"      TEXT NOT NULL DEFAULT 'PENDING',
  "correlationJson"   TEXT NOT NULL DEFAULT '{}',
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierEmailReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierEmailReply_organizationId_provider_externalMessageId_key"
  ON "SupplierEmailReply"("organizationId", "provider", "externalMessageId");
CREATE INDEX IF NOT EXISTS "SupplierEmailReply_organizationId_matchingStatus_receivedAt_idx"
  ON "SupplierEmailReply"("organizationId", "matchingStatus", "receivedAt");
CREATE INDEX IF NOT EXISTS "SupplierEmailReply_supplierQuoteId_idx"
  ON "SupplierEmailReply"("supplierQuoteId");
CREATE INDEX IF NOT EXISTS "SupplierEmailReply_supplierId_idx"
  ON "SupplierEmailReply"("supplierId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierEmailReply_organizationId_fkey') THEN
    ALTER TABLE "SupplierEmailReply"
      ADD CONSTRAINT "SupplierEmailReply_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierEmailReply_supplierQuoteId_fkey') THEN
    ALTER TABLE "SupplierEmailReply"
      ADD CONSTRAINT "SupplierEmailReply_supplierQuoteId_fkey"
      FOREIGN KEY ("supplierQuoteId") REFERENCES "SupplierQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierEmailReply_supplierId_fkey') THEN
    ALTER TABLE "SupplierEmailReply"
      ADD CONSTRAINT "SupplierEmailReply_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Attachment gains an optional link to the supplier reply. Existing attachments
-- keep their message/enquiry links and are untouched.
ALTER TABLE "Attachment"
  ADD COLUMN IF NOT EXISTS "supplierReplyId" TEXT;

CREATE INDEX IF NOT EXISTS "Attachment_supplierReplyId_idx"
  ON "Attachment"("supplierReplyId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attachment_supplierReplyId_fkey') THEN
    ALTER TABLE "Attachment"
      ADD CONSTRAINT "Attachment_supplierReplyId_fkey"
      FOREIGN KEY ("supplierReplyId") REFERENCES "SupplierEmailReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 5. One-time owner invitations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OwnerInvitation" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "email"          TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "role"           TEXT NOT NULL DEFAULT 'OWNER',
  "tokenHash"      TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "usedAt"         TIMESTAMP(3),
  "createdByLabel" TEXT NOT NULL DEFAULT 'provisioning',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OwnerInvitation_tokenHash_key"
  ON "OwnerInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "OwnerInvitation_organizationId_email_idx"
  ON "OwnerInvitation"("organizationId", "email");
CREATE INDEX IF NOT EXISTS "OwnerInvitation_expiresAt_idx"
  ON "OwnerInvitation"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OwnerInvitation_organizationId_fkey') THEN
    ALTER TABLE "OwnerInvitation"
      ADD CONSTRAINT "OwnerInvitation_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
