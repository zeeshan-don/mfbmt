-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'STAFF',
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "passwordResetTokenHash" TEXT,
    "passwordResetExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Organization" (
    "id" TEXT NOT NULL DEFAULT 'org_mfbmt',
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "trn" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "website" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'AED',
    "quotationValidityDays" INTEGER NOT NULL DEFAULT 14,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "taxRatePct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "taxLabel" TEXT NOT NULL DEFAULT 'VAT',
    "inventoryMode" TEXT NOT NULL DEFAULT 'STOCK_FIRST',
    "inventoryConfiguredAt" TIMESTAMP(3),
    "taxInLandedCost" BOOLEAN NOT NULL DEFAULT false,
    "onboardingCompletedAt" TIMESTAMP(3),
    "quotationTerms" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Contact" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "companyName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "supplierId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExcludedContact" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "label" TEXT,
    "category" TEXT NOT NULL DEFAULT 'PERSONAL',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExcludedContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Conversation" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT,
    "contactId" TEXT,
    "subject" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'INBOUND',
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddress" TEXT,
    "toPhoneNumberId" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "bodyRetained" BOOLEAN NOT NULL DEFAULT true,
    "bodyHash" TEXT,
    "skipReason" TEXT,
    "mediaType" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawMeta" TEXT,
    "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "classification" TEXT,
    "classificationSource" TEXT,
    "classificationConfidence" DOUBLE PRECISION,
    "classificationReason" TEXT,
    "enquiryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "enquiryId" TEXT,
    "filename" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "detectedMime" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "pageCount" INTEGER,
    "textExtract" TEXT,
    "extractionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "extractionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Enquiry" (
    "id" TEXT NOT NULL,
    "publicRef" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "rawText" TEXT NOT NULL,
    "extractedJson" TEXT,
    "deliveryLocation" TEXT,
    "deliveryDate" TIMESTAMP(3),
    "currency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "classification" TEXT NOT NULL DEFAULT 'RFQ',
    "classificationConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extractionConfidence" DOUBLE PRECISION,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnquiryItem" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "rawText" TEXT,
    "category" TEXT,
    "brand" TEXT,
    "size" TEXT,
    "material" TEXT,
    "grade" TEXT,
    "pressureRating" TEXT,
    "schedule" TEXT,
    "standard" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "quantity" DOUBLE PRECISION NOT NULL,
    "missingFields" TEXT NOT NULL DEFAULT '[]',
    "confidence" TEXT NOT NULL DEFAULT '{}',
    "sourceRef" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "clarificationQuestion" TEXT,
    "inventoryStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "quantityFromStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantityToSource" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inventoryCheckedAt" TIMESTAMP(3),
    "stockIsStale" BOOLEAN NOT NULL DEFAULT false,
    "stockMatchStatus" TEXT,
    "sourcingStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "matchedProductId" TEXT,
    "matchedStockJson" TEXT,
    "extractedJson" TEXT,
    "approvedOfferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnquiryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT,
    "material" TEXT,
    "grade" TEXT,
    "size" TEXT,
    "pressureRating" TEXT,
    "schedule" TEXT,
    "standard" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "specs" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductSpecification" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "ProductSpecification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryLocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryStock" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantityOnHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantityReserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT,
    "delta" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "country" TEXT,
    "city" TEXT,
    "address" TEXT,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "categories" TEXT NOT NULL DEFAULT '[]',
    "brands" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "identityStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "notes" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierContact" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierProduct" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "specs" TEXT NOT NULL DEFAULT '{}',
    "unitPrice" DOUBLE PRECISION,
    "currency" TEXT,
    "moq" DOUBLE PRECISION,
    "availability" TEXT,
    "sourceUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SearchSession" (
    "id" TEXT NOT NULL,
    "enquiryItemId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "sourcesJson" TEXT NOT NULL DEFAULT '[]',
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SearchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SearchQuery" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SearchResult" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "supplierId" TEXT,
    "supplierName" TEXT,
    "title" TEXT NOT NULL,
    "snippet" TEXT,
    "priceText" TEXT,
    "currency" TEXT,
    "moq" DOUBLE PRECISION,
    "availability" TEXT,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "matchStatus" TEXT NOT NULL DEFAULT 'INSUFFICIENT',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SearchResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierOffer" (
    "id" TEXT NOT NULL,
    "enquiryItemId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT NOT NULL,
    "searchResultId" TEXT,
    "productTitle" TEXT NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'POSSIBLE',
    "unitPrice" DOUBLE PRECISION,
    "currency" TEXT,
    "quantityAvailable" DOUBLE PRECISION,
    "moq" DOUBLE PRECISION,
    "shippingCost" DOUBLE PRECISION,
    "otherCharges" DOUBLE PRECISION,
    "taxes" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "deliveryLocation" TEXT,
    "validityDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "sourceType" TEXT NOT NULL DEFAULT 'PUBLIC_WEB',
    "sourceUrl" TEXT,
    "quotedAt" TIMESTAMP(3),
    "quoteRef" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "landedCostJson" TEXT NOT NULL DEFAULT '{}',
    "isEligible" BOOLEAN NOT NULL DEFAULT false,
    "ineligibilityReason" TEXT,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "procurementQuantity" DOUBLE PRECISION,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "quoteItemId" TEXT,

    CONSTRAINT "SupplierOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierQuote" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "enquiryItemId" TEXT,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "channel" TEXT,
    "sentTo" TEXT,
    "lastError" TEXT,
    "subject" TEXT,
    "messageBody" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "responseNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierQuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "specs" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "unitPrice" DOUBLE PRECISION,
    "currency" TEXT,
    "moq" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "shippingCost" DOUBLE PRECISION,
    "otherCharges" DOUBLE PRECISION,
    "taxes" DOUBLE PRECISION,
    "validityDate" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "SupplierQuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Approval" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enquiryId" TEXT,
    "requestedBy" TEXT NOT NULL DEFAULT 'SYSTEM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "reason" TEXT,
    "riskNotes" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerQuotation" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "currency" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "internalCostTotal" DOUBLE PRECISION,
    "internalCostComplete" BOOLEAN NOT NULL DEFAULT false,
    "terms" TEXT,
    "notes" TEXT,
    "validityDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "pricingExceptionById" TEXT,
    "pricingExceptionAt" TIMESTAMP(3),
    "pricingExceptionReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentChannel" TEXT,
    "sentTo" TEXT,
    "sendError" TEXT,
    "pdfPath" TEXT,
    "pdfGeneratedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerQuotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerQuotationItem" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "specs" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "costPrice" DOUBLE PRECISION,
    "unitPrice" DOUBLE PRECISION,
    "lineTotal" DOUBLE PRECISION,
    "priceStatus" TEXT NOT NULL DEFAULT 'UNPRICED',
    "costStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "pricingSource" TEXT,
    "overrideReason" TEXT,
    "overrideById" TEXT,
    "overrideAt" TIMESTAMP(3),
    "stockQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "procureQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockUnitCost" DOUBLE PRECISION,
    "procureUnitCost" DOUBLE PRECISION,
    "costIncomplete" BOOLEAN NOT NULL DEFAULT true,
    "supplierOfferId" TEXT,
    "enquiryItemId" TEXT,

    CONSTRAINT "CustomerQuotationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PricingRule" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "category" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PERCENT_MARKUP',
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MaterialEquivalence" (
    "id" TEXT NOT NULL,
    "requestedMaterial" TEXT NOT NULL,
    "offeredMaterial" TEXT NOT NULL,
    "requestedGrade" TEXT NOT NULL DEFAULT '',
    "offeredGrade" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaterialEquivalence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Integration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "secretsJson" TEXT NOT NULL DEFAULT '{}',
    "accountLabel" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT NOT NULL,
    "progress" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NumberSequence" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExchangeRate" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "public"."User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "public"."Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId");

-- CreateIndex
CREATE INDEX "Contact_phone_idx" ON "public"."Contact"("phone");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "public"."Contact"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ExcludedContact_identifier_key" ON "public"."ExcludedContact"("identifier");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "public"."Conversation"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channel_externalId_key" ON "public"."Conversation"("channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalMessageId_key" ON "public"."Message"("externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_enquiryId_key" ON "public"."Message"("enquiryId");

-- CreateIndex
CREATE INDEX "Message_conversationId_receivedAt_idx" ON "public"."Message"("conversationId", "receivedAt");

-- CreateIndex
CREATE INDEX "Message_processingStatus_idx" ON "public"."Message"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storedName_key" ON "public"."Attachment"("storedName");

-- CreateIndex
CREATE INDEX "Attachment_enquiryId_idx" ON "public"."Attachment"("enquiryId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_messageId_sha256_key" ON "public"."Attachment"("messageId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Enquiry_publicRef_key" ON "public"."Enquiry"("publicRef");

-- CreateIndex
CREATE INDEX "Enquiry_status_idx" ON "public"."Enquiry"("status");

-- CreateIndex
CREATE INDEX "Enquiry_createdAt_idx" ON "public"."Enquiry"("createdAt");

-- CreateIndex
CREATE INDEX "EnquiryItem_enquiryId_idx" ON "public"."EnquiryItem"("enquiryId");

-- CreateIndex
CREATE INDEX "EnquiryItem_sourcingStatus_idx" ON "public"."EnquiryItem"("sourcingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "public"."Product"("sku");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "public"."Product"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSpecification_productId_key_key" ON "public"."ProductSpecification"("productId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_code_key" ON "public"."InventoryLocation"("code");

-- CreateIndex
CREATE INDEX "InventoryStock_productId_idx" ON "public"."InventoryStock"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStock_productId_locationId_key" ON "public"."InventoryStock"("productId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_productId_createdAt_idx" ON "public"."InventoryMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "Supplier_name_idx" ON "public"."Supplier"("name");

-- CreateIndex
CREATE INDEX "SupplierContact_supplierId_idx" ON "public"."SupplierContact"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_idx" ON "public"."SupplierProduct"("supplierId");

-- CreateIndex
CREATE INDEX "SearchSession_enquiryItemId_idx" ON "public"."SearchSession"("enquiryItemId");

-- CreateIndex
CREATE INDEX "SearchQuery_sessionId_idx" ON "public"."SearchQuery"("sessionId");

-- CreateIndex
CREATE INDEX "SearchResult_sessionId_idx" ON "public"."SearchResult"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOffer_searchResultId_key" ON "public"."SupplierOffer"("searchResultId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOffer_quoteItemId_key" ON "public"."SupplierOffer"("quoteItemId");

-- CreateIndex
CREATE INDEX "SupplierOffer_enquiryItemId_idx" ON "public"."SupplierOffer"("enquiryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierQuote_token_key" ON "public"."SupplierQuote"("token");

-- CreateIndex
CREATE INDEX "SupplierQuote_supplierId_idx" ON "public"."SupplierQuote"("supplierId");

-- CreateIndex
CREATE INDEX "Approval_status_createdAt_idx" ON "public"."Approval"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_enquiryId_idx" ON "public"."Approval"("enquiryId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_type_entityId_status_key" ON "public"."Approval"("type", "entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerQuotation_quoteNumber_key" ON "public"."CustomerQuotation"("quoteNumber");

-- CreateIndex
CREATE INDEX "CustomerQuotation_enquiryId_idx" ON "public"."CustomerQuotation"("enquiryId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerQuotation_enquiryId_version_key" ON "public"."CustomerQuotation"("enquiryId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialEquivalence_requestedMaterial_offeredMaterial_reque_key" ON "public"."MaterialEquivalence"("requestedMaterial", "offeredMaterial", "requestedGrade", "offeredGrade");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_key_key" ON "public"."Integration"("key");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_idempotencyKey_key" ON "public"."BackgroundJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAfter_idx" ON "public"."BackgroundJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_leaseExpiresAt_idx" ON "public"."BackgroundJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "public"."WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "public"."WebhookEvent"("provider", "externalId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "public"."AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "public"."Notification"("isRead");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_base_quote_fetchedAt_key" ON "public"."ExchangeRate"("base", "quote", "fetchedAt");

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Enquiry" ADD CONSTRAINT "Enquiry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnquiryItem" ADD CONSTRAINT "EnquiryItem_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductSpecification" ADD CONSTRAINT "ProductSpecification_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryStock" ADD CONSTRAINT "InventoryStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryStock" ADD CONSTRAINT "InventoryStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "public"."InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "public"."InventoryLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierContact" ADD CONSTRAINT "SupplierContact_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierProduct" ADD CONSTRAINT "SupplierProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SearchSession" ADD CONSTRAINT "SearchSession_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "public"."EnquiryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SearchQuery" ADD CONSTRAINT "SearchQuery_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."SearchSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SearchResult" ADD CONSTRAINT "SearchResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."SearchSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierOffer" ADD CONSTRAINT "SupplierOffer_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "public"."EnquiryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierOffer" ADD CONSTRAINT "SupplierOffer_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierOffer" ADD CONSTRAINT "SupplierOffer_searchResultId_fkey" FOREIGN KEY ("searchResultId") REFERENCES "public"."SearchResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierOffer" ADD CONSTRAINT "SupplierOffer_quoteItemId_fkey" FOREIGN KEY ("quoteItemId") REFERENCES "public"."SupplierQuoteItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierQuote" ADD CONSTRAINT "SupplierQuote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierQuote" ADD CONSTRAINT "SupplierQuote_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "public"."EnquiryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierQuoteItem" ADD CONSTRAINT "SupplierQuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "public"."SupplierQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotation" ADD CONSTRAINT "CustomerQuotation_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotation" ADD CONSTRAINT "CustomerQuotation_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotation" ADD CONSTRAINT "CustomerQuotation_pricingExceptionById_fkey" FOREIGN KEY ("pricingExceptionById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotationItem" ADD CONSTRAINT "CustomerQuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "public"."CustomerQuotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotationItem" ADD CONSTRAINT "CustomerQuotationItem_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "public"."SupplierOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuotationItem" ADD CONSTRAINT "CustomerQuotationItem_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "public"."EnquiryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
