import { db } from "./db";
import { stringifyJson } from "./json";

export async function writeAudit(input: {
  actorId?: string | null;
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}) {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? "system",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metaJson: stringifyJson(input.meta ?? {}),
        ip: input.ip ?? null,
      },
    });
  } catch (error) {
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
