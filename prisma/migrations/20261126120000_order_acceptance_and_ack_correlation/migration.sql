-- Customer acceptance review and deterministic reply correlation.
--
-- Additive only: existing quotations and purchase orders keep their current
-- values. The correlation columns stay null until a document is next sent, and
-- inbound correlation falls back to thread/header/sender evidence for records
-- created before this migration.

-- AlterTable
ALTER TABLE "CustomerQuotation" ADD COLUMN "correlationToken" TEXT,
ADD COLUMN "providerThreadId" TEXT,
ADD COLUMN "providerMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerQuotation_correlationToken_key" ON "CustomerQuotation"("correlationToken");

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "correlationToken" TEXT,
ADD COLUMN "providerThreadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_correlationToken_key" ON "PurchaseOrder"("correlationToken");

-- AlterTable
ALTER TABLE "SupplierEmailReply" ADD COLUMN "purchaseOrderId" TEXT;

-- CreateIndex
CREATE INDEX "SupplierEmailReply_purchaseOrderId_idx" ON "SupplierEmailReply"("purchaseOrderId");

-- AddForeignKey
ALTER TABLE "SupplierEmailReply" ADD CONSTRAINT "SupplierEmailReply_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "SupplierAcknowledgement" ADD COLUMN "supplierReplyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAcknowledgement_supplierReplyId_key" ON "SupplierAcknowledgement"("supplierReplyId");

-- AddForeignKey
ALTER TABLE "SupplierAcknowledgement" ADD CONSTRAINT "SupplierAcknowledgement_supplierReplyId_fkey" FOREIGN KEY ("supplierReplyId") REFERENCES "SupplierEmailReply"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "CustomerAcceptanceReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "quotationId" TEXT NOT NULL,
    "quotationVersion" INTEGER NOT NULL,
    "customerId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'EMAIL',
    "provider" TEXT,
    "externalMessageId" TEXT,
    "fromAddress" TEXT,
    "subject" TEXT,
    "bodySummary" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '[]',
    "extractionJson" TEXT NOT NULL DEFAULT '{}',
    "comparisonJson" TEXT NOT NULL DEFAULT '{}',
    "customerPoNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "salesOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAcceptanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAcceptanceReview_organizationId_externalMessageId_key" ON "CustomerAcceptanceReview"("organizationId", "externalMessageId");

-- CreateIndex
CREATE INDEX "CustomerAcceptanceReview_organizationId_status_idx" ON "CustomerAcceptanceReview"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CustomerAcceptanceReview_quotationId_idx" ON "CustomerAcceptanceReview"("quotationId");

-- CreateIndex
CREATE INDEX "CustomerAcceptanceReview_salesOrderId_idx" ON "CustomerAcceptanceReview"("salesOrderId");

-- AddForeignKey
ALTER TABLE "CustomerAcceptanceReview" ADD CONSTRAINT "CustomerAcceptanceReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAcceptanceReview" ADD CONSTRAINT "CustomerAcceptanceReview_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "CustomerQuotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAcceptanceReview" ADD CONSTRAINT "CustomerAcceptanceReview_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "acceptanceReviewId" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_acceptanceReviewId_idx" ON "Attachment"("acceptanceReviewId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_acceptanceReviewId_fkey" FOREIGN KEY ("acceptanceReviewId") REFERENCES "CustomerAcceptanceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
