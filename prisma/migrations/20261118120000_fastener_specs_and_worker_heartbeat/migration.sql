-- Forward-only, additive migration.
-- Existing demo data, IDs and relationships are preserved: every column is
-- nullable or has a default, no table is dropped or rewritten.

-- Structured fastener specification on enquiry lines.
ALTER TABLE "EnquiryItem"
  ADD COLUMN "fastenerSpecJson" TEXT,
  ADD COLUMN "fastenerType" TEXT,
  ADD COLUMN "diameter" TEXT,
  ADD COLUMN "threadSeries" TEXT,
  ADD COLUMN "pitchMm" DOUBLE PRECISION,
  ADD COLUMN "lengthMm" DOUBLE PRECISION,
  ADD COLUMN "propertyClass" TEXT,
  ADD COLUMN "finish" TEXT,
  ADD COLUMN "specSource" TEXT NOT NULL DEFAULT 'EXTRACTED',
  ADD COLUMN "specConfirmedAt" TIMESTAMP(3);

CREATE INDEX "EnquiryItem_fastenerType_diameter_idx"
  ON "EnquiryItem"("fastenerType", "diameter");

-- Structured specification on stock products and supplier offers.
ALTER TABLE "Product" ADD COLUMN "fastenerSpecJson" TEXT;
ALTER TABLE "SupplierOffer" ADD COLUMN "offeredSpecJson" TEXT;

-- Real worker liveness instead of inferring from a cleared job heartbeat.
CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "processName" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metaJson" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerHeartbeat_workerId_key" ON "WorkerHeartbeat"("workerId");
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");
