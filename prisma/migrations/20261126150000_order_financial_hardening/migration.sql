-- Additive hardening for supplier PO revisions and commitment tracking.
-- No existing column, table or row is dropped or rewritten.

ALTER TABLE "PurchaseOrderLine" ADD COLUMN "acknowledgedQuantity" DECIMAL(18,4);

CREATE TABLE "PurchaseOrderVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "purchaseOrderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "acknowledgementId" TEXT,
    "approvedById" TEXT,
    "snapshotJson" TEXT NOT NULL,
    "changeSummaryJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseOrderVersion_purchaseOrderId_version_key"
    ON "PurchaseOrderVersion"("purchaseOrderId", "version");

CREATE INDEX "PurchaseOrderVersion_organizationId_purchaseOrderId_idx"
    ON "PurchaseOrderVersion"("organizationId", "purchaseOrderId");

ALTER TABLE "PurchaseOrderVersion"
    ADD CONSTRAINT "PurchaseOrderVersion_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderVersion"
    ADD CONSTRAINT "PurchaseOrderVersion_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
