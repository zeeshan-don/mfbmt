-- Unified document-processing state, structured tables and package grouping.
-- Additive only: existing Attachment rows keep their extractionStatus and files.

ALTER TABLE "Attachment"
  ADD COLUMN "packageId" TEXT,
  ADD COLUMN "detectedFormat" TEXT,
  ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "processingStage" TEXT,
  ADD COLUMN "qualityJson" TEXT,
  ADD COLUMN "tablesJson" TEXT,
  ADD COLUMN "metadataJson" TEXT,
  ADD COLUMN "parserVersion" TEXT,
  ADD COLUMN "promptVersion" TEXT,
  ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "failureMessage" TEXT;

CREATE TABLE "DocumentPackage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "key" TEXT NOT NULL,
  "enquiryId" TEXT,
  "messageId" TEXT,
  "supplierReplyId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "summaryJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentPackage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentPackage_organizationId_key_key"
  ON "DocumentPackage"("organizationId", "key");
CREATE INDEX "DocumentPackage_organizationId_enquiryId_idx"
  ON "DocumentPackage"("organizationId", "enquiryId");
CREATE INDEX "DocumentPackage_organizationId_supplierReplyId_idx"
  ON "DocumentPackage"("organizationId", "supplierReplyId");
CREATE INDEX "Attachment_organizationId_packageId_idx"
  ON "Attachment"("organizationId", "packageId");
CREATE INDEX "Attachment_organizationId_processingStatus_idx"
  ON "Attachment"("organizationId", "processingStatus");

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "DocumentPackage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentPackage"
  ADD CONSTRAINT "DocumentPackage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentPackage"
  ADD CONSTRAINT "DocumentPackage_enquiryId_fkey"
  FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
