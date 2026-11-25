-- Deep Supplier Research: durable, bounded, evidence-backed research runs.
-- Additive only. Existing quick sourcing tables and data are untouched.

CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "enquiryId" TEXT NOT NULL,
    "enquiryItemId" TEXT,
    "activeKey" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'DEEP',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT NOT NULL DEFAULT 'QUEUED',
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "planJson" TEXT NOT NULL DEFAULT '{}',
    "limitsJson" TEXT NOT NULL DEFAULT '{}',
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "coverageJson" TEXT NOT NULL DEFAULT '[]',
    "budgetAed" DOUBLE PRECISION,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searchRequests" INTEGER NOT NULL DEFAULT 0,
    "pageFetches" INTEGER NOT NULL DEFAULT 0,
    "documentsProcessed" INTEGER NOT NULL DEFAULT 0,
    "aiCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchQuery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "round" INTEGER NOT NULL DEFAULT 1,
    "query" TEXT NOT NULL,
    "productTarget" TEXT,
    "objective" TEXT,
    "location" TEXT,
    "requiredEvidence" TEXT,
    "category" TEXT,
    "reason" TEXT,
    "provider" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchQuery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "queryId" TEXT,
    "sourceUrl" TEXT,
    "domain" TEXT,
    "title" TEXT NOT NULL,
    "snippet" TEXT,
    "supplierName" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'SEARCH_RESULT',
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchPage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "candidateKey" TEXT,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "domain" TEXT,
    "title" TEXT,
    "pageType" TEXT NOT NULL DEFAULT 'OTHER',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "contentHash" TEXT,
    "excerpt" TEXT,
    "text" TEXT,
    "linksJson" TEXT NOT NULL DEFAULT '[]',
    "documentLocation" TEXT,
    "pageCount" INTEGER,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchCandidate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "description" TEXT,
    "classification" TEXT,
    "country" TEXT,
    "city" TEXT,
    "contactJson" TEXT NOT NULL DEFAULT '{}',
    "productCategoriesJson" TEXT NOT NULL DEFAULT '[]',
    "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "certificationsJson" TEXT NOT NULL DEFAULT '[]',
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "branchesJson" TEXT NOT NULL DEFAULT '[]',
    "matchStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "matchJson" TEXT NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "supplierId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "candidateId" TEXT,
    "pageId" TEXT,
    "field" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "value" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "pageTitle" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'PAGE',
    "excerpt" TEXT,
    "documentLocation" TEXT,
    "pageNumber" INTEGER,
    "sheetName" TEXT,
    "rowNumber" INTEGER,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractionMethod" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "verificationStatus" TEXT NOT NULL DEFAULT 'SUPPORTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "runId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchRun_activeKey_key" ON "ResearchRun"("activeKey");
CREATE INDEX "ResearchRun_organizationId_status_idx" ON "ResearchRun"("organizationId", "status");
CREATE INDEX "ResearchRun_enquiryId_idx" ON "ResearchRun"("enquiryId");
CREATE INDEX "ResearchRun_enquiryItemId_idx" ON "ResearchRun"("enquiryItemId");
CREATE INDEX "ResearchRun_organizationId_createdAt_idx" ON "ResearchRun"("organizationId", "createdAt");

CREATE UNIQUE INDEX "ResearchQuery_runId_query_provider_key" ON "ResearchQuery"("runId", "query", "provider");
CREATE INDEX "ResearchQuery_runId_iteration_idx" ON "ResearchQuery"("runId", "iteration");
CREATE INDEX "ResearchQuery_organizationId_idx" ON "ResearchQuery"("organizationId");

CREATE INDEX "ResearchSource_runId_domain_idx" ON "ResearchSource"("runId", "domain");
CREATE INDEX "ResearchSource_organizationId_idx" ON "ResearchSource"("organizationId");

CREATE UNIQUE INDEX "ResearchPage_runId_url_key" ON "ResearchPage"("runId", "url");
CREATE INDEX "ResearchPage_runId_candidateKey_idx" ON "ResearchPage"("runId", "candidateKey");
CREATE INDEX "ResearchPage_organizationId_idx" ON "ResearchPage"("organizationId");

CREATE UNIQUE INDEX "ResearchCandidate_runId_candidateKey_key" ON "ResearchCandidate"("runId", "candidateKey");
CREATE INDEX "ResearchCandidate_runId_matchStatus_idx" ON "ResearchCandidate"("runId", "matchStatus");
CREATE INDEX "ResearchCandidate_organizationId_idx" ON "ResearchCandidate"("organizationId");

CREATE INDEX "ResearchEvidence_runId_candidateId_idx" ON "ResearchEvidence"("runId", "candidateId");
CREATE INDEX "ResearchEvidence_organizationId_idx" ON "ResearchEvidence"("organizationId");

CREATE INDEX "ResearchEvent_runId_createdAt_idx" ON "ResearchEvent"("runId", "createdAt");
CREATE INDEX "ResearchEvent_organizationId_idx" ON "ResearchEvent"("organizationId");

ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "EnquiryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchQuery" ADD CONSTRAINT "ResearchQuery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchQuery" ADD CONSTRAINT "ResearchQuery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPage" ADD CONSTRAINT "ResearchPage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPage" ADD CONSTRAINT "ResearchPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchCandidate" ADD CONSTRAINT "ResearchCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchCandidate" ADD CONSTRAINT "ResearchCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchCandidate" ADD CONSTRAINT "ResearchCandidate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ResearchCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ResearchPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchEvent" ADD CONSTRAINT "ResearchEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchEvent" ADD CONSTRAINT "ResearchEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
