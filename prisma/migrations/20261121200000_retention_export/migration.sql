-- Additive: per-organization message/attachment retention (0 = keep forever).
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "messageRetentionDays" INTEGER NOT NULL DEFAULT 0;
