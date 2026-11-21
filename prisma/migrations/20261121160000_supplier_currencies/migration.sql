-- Additive directory field for currencies a supplier quotes in.
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "currencies" TEXT NOT NULL DEFAULT '[]';
