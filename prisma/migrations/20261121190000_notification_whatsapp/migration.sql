-- Additive: owner WhatsApp alert configuration and notification delivery state.
-- Existing rows keep the in-app-only behaviour because the default is false.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "ownerWhatsappNumber" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "whatsappApprovalAlerts" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "channelsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT NOT NULL DEFAULT 'IN_APP';
