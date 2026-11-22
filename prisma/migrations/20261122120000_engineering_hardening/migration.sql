-- Durable inventory reservations, explicit product packaging factors and the
-- outbound-message ledger. Additive only: no existing table, column or row is
-- dropped or rewritten by this migration.

-- CreateTable
CREATE TABLE "public"."ProductPackaging" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPackaging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StockReservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "quotationId" TEXT,
    "quotationItemId" TEXT,
    "enquiryItemId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "allocationsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "overrideReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OutboundMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "operationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "relatedType" TEXT,
    "relatedId" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPackaging_organizationId_productId_idx" ON "public"."ProductPackaging"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPackaging_productId_unit_key" ON "public"."ProductPackaging"("productId", "unit");

-- CreateIndex
CREATE INDEX "StockReservation_organizationId_status_expiresAt_idx" ON "public"."StockReservation"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "StockReservation_quotationId_idx" ON "public"."StockReservation"("quotationId");

-- CreateIndex
CREATE INDEX "StockReservation_productId_idx" ON "public"."StockReservation"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_organizationId_idempotencyKey_key" ON "public"."StockReservation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_organizationId_status_idx" ON "public"."OutboundMessage"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_leaseExpiresAt_idx" ON "public"."OutboundMessage"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_organizationId_operationKey_key" ON "public"."OutboundMessage"("organizationId", "operationKey");

-- AddForeignKey
ALTER TABLE "public"."ProductPackaging" ADD CONSTRAINT "ProductPackaging_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductPackaging" ADD CONSTRAINT "ProductPackaging_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockReservation" ADD CONSTRAINT "StockReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockReservation" ADD CONSTRAINT "StockReservation_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "public"."CustomerQuotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundMessage" ADD CONSTRAINT "OutboundMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
