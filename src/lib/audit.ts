import { db } from "./db";
import { rawDb } from "./db-base";
import { getTenantId, TenantContextError } from "./tenant";
import { getCurrentOrganization } from "./organization";
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
    const owners = await db.user.findMany({ where: { role: "OWNER", isActive: true }, select: { id: true, email: true, name: true } });
    let notificationIds: string[] = [];
    if (owners.length === 0) {
      const created = await db.notification.create({ data: { ...input, userId: null } });
      notificationIds = [created.id];
    } else {
      await db.notification.createMany({
        data: owners.map((owner) => ({ ...input, userId: owner.id })),
      });
      // Re-fetch the just-created ids so delivery state can be recorded.
      const recent = await db.notification.findMany({
        where: { type: input.type, title: input.title, createdAt: { gte: new Date(Date.now() - 5000) } },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        take: owners.length,
      });
      notificationIds = recent.map((n) => n.id);
    }
    // In-app notification is durable; email is a best-effort deep-link. A
    // mailbox failure must never fail the business action that triggered it.
    try {
      const [{ sendEmail }, { env }] = await Promise.all([import("./email/send"), import("./env")]);
      const absoluteLink = input.link ? `${env.APP_URL.replace(/\/$/, "")}${input.link}` : null;
      for (const owner of owners) {
        await sendEmail({
          to: owner.email,
          subject: `[Procurement] ${input.title}`,
          text: [
            `Hello ${owner.name},`,
            "",
            input.body ?? input.title,
            absoluteLink ? `Open: ${absoluteLink}` : "",
            "",
            "This is an automated notification. No customer or supplier message was sent by this alert.",
          ].filter(Boolean).join("\n"),
        }).catch(() => undefined);
      }
    } catch {
      // The in-app notification remains available.
    }

    // WhatsApp approval alerts are opt-in and best-effort. Meta may reject a
    // business-initiated message outside the 24-hour window; that outcome is
    // recorded on the notification instead of being hidden.
    try {
      const org = await getCurrentOrganization();
      if (org?.whatsappApprovalAlerts && org.ownerWhatsappNumber) {
        const { sendWhatsAppText } = await import("./intake/whatsapp");
        const absoluteLink = input.link ? `${process.env.APP_URL?.replace(/\/$/, "") ?? ""}${input.link}` : null;
        const body = [input.body ?? input.title, absoluteLink ? `Open: ${absoluteLink}` : ""].filter(Boolean).join("\n");
        const sent = await sendWhatsAppText(org.ownerWhatsappNumber, `[Procurement] ${input.title}\n${body}`);
        const status = sent.ok
          ? sent.simulated
            ? "WHATSAPP_SIMULATED"
            : "WHATSAPP_SENT"
          : sent.outsideServiceWindow
            ? "WHATSAPP_OUTSIDE_WINDOW"
            : "WHATSAPP_FAILED";
        const channels = stringifyJson({ inApp: true, whatsapp: status });
        if (notificationIds.length > 0) {
          await db.notification.updateMany({
            where: { id: { in: notificationIds } },
            data: { deliveryStatus: status, channelsJson: channels },
          });
        }
      }
    } catch {
      // Notification delivery state is best-effort.
    }
  } catch (error) {
    console.error("[notify] failed", input.type, error);
  }
}
