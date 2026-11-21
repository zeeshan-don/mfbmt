-- Phase 1 production safety: TOTP MFA.
-- Additive and forward-only. Existing users keep working with MFA disabled.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mfaRecoveryCodesJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "mfaLastUsedCounter" INTEGER;

CREATE TABLE IF NOT EXISTS "MfaChallenge" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT '__unset__',
  "userId"         TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "usedAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MfaChallenge_tokenHash_key"
  ON "MfaChallenge"("tokenHash");
CREATE INDEX IF NOT EXISTS "MfaChallenge_userId_idx"
  ON "MfaChallenge"("userId");
CREATE INDEX IF NOT EXISTS "MfaChallenge_expiresAt_idx"
  ON "MfaChallenge"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MfaChallenge_organizationId_fkey') THEN
    ALTER TABLE "MfaChallenge"
      ADD CONSTRAINT "MfaChallenge_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MfaChallenge_userId_fkey') THEN
    ALTER TABLE "MfaChallenge"
      ADD CONSTRAINT "MfaChallenge_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
