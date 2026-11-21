-- Phase 2: deterministic AI cost evidence and repeat-search cache.
-- Additive and forward-only. No existing rows or columns are changed.

CREATE TABLE IF NOT EXISTS "AiUsage" (
  "id"               TEXT NOT NULL,
  "organizationId"   TEXT NOT NULL DEFAULT '__unset__',
  "jobType"          TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "model"            TEXT NOT NULL,
  "inputTokens"      INTEGER NOT NULL DEFAULT 0,
  "outputTokens"     INTEGER NOT NULL DEFAULT 0,
  "estimatedCostUsd" DOUBLE PRECISION,
  "enquiryId"        TEXT,
  "success"          BOOLEAN NOT NULL DEFAULT true,
  "error"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiUsage_organizationId_createdAt_idx"
  ON "AiUsage"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_organizationId_jobType_idx"
  ON "AiUsage"("organizationId", "jobType");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiUsage_organizationId_fkey') THEN
    ALTER TABLE "AiUsage"
      ADD CONSTRAINT "AiUsage_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "SearchCache" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "cacheKey"       TEXT NOT NULL,
  "kind"           TEXT NOT NULL DEFAULT 'SEARCH',
  "payloadJson"    TEXT NOT NULL,
  "sourceUrl"      TEXT,
  "fetchedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SearchCache_organizationId_cacheKey_key"
  ON "SearchCache"("organizationId", "cacheKey");
CREATE INDEX IF NOT EXISTS "SearchCache_organizationId_expiresAt_idx"
  ON "SearchCache"("organizationId", "expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SearchCache_organizationId_fkey') THEN
    ALTER TABLE "SearchCache"
      ADD CONSTRAINT "SearchCache_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
