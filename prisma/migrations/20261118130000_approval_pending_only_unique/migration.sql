-- Only one PENDING approval may exist per subject. Decided approvals are
-- history and must not collide when the owner re-decides later (for example,
-- switching to another supplier after an earlier approval).
DROP INDEX IF EXISTS "Approval_type_entityId_status_key";

CREATE UNIQUE INDEX "Approval_type_entityId_pending_key"
  ON "Approval" ("type", "entityId")
  WHERE status = 'PENDING';

CREATE INDEX "Approval_type_entityId_status_idx"
  ON "Approval" ("type", "entityId", "status");
