import { db } from "./db";
import { rawDb } from "./db-base";
import { getTenantId, TenantContextError } from "./tenant";
import { stringifyJson } from "./json";

export async function writeAudit(input: {
  actorId?: string | null;
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  /** Only for platform/auth events that occur before a tenant is known. */
  organizationId?: string | null;
}) {
  const organizationId = input.organizationId ?? getTenantId();
  const data = {
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel ?? "system",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metaJson: stringifyJson(input.meta ?? {}),
    ip: input.ip ?? null,
  };
  try {
    await db.auditLog.create({ data: { ...data, organizationId: organizationId ?? undefined } });
  } catch (error) {
    // Sign-in failures happen before a tenant is known. They are still audited,
    // with a null organization, using the unscoped client.
    if (error instanceof TenantContextError || (!organizationId && process.env.NODE_ENV !== "test")) {
      try {
        await rawDb.auditLog.create({ data: { ...data, organizationId: organizationId ?? null } });
        return;
      } catch (fallbackError) {
        console.error("[audit] failed to write pre-tenant entry", input.action, fallbackError);
        return;
      }
    }
    // Audit failures must never take down a business operation, but they are logged.
    console.error("[audit] failed to write entry", input.action, error);
  }
}

export async function notifyOwner(input: {
  type: string;
  title: string;
  body?: string;
  link?: string;
}) {
  try {
    const owners = await db.user.findMany({ where: { role: "OWNER", isActive: true }, select: { id: true } });
    if (owners.length === 0) {
      await db.notification.create({ data: { ...input, userId: null } });
      return;
    }
    await db.notification.createMany({
      data: owners.map((owner) => ({ ...input, userId: owner.id })),
    });
  } catch (error) {
    console.error("[notify] failed", input.type, error);
  }
}
