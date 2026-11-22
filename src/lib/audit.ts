import { db } from "./db";
import { rawDb } from "./db-base";
import { getTenantId, TenantContextError } from "./tenant";
import { getCurrentOrganization } from "./organization";
import { stringifyJson } from "./json";
import { outboundOperationKey, sendOutboundOnce } from "./outbound/messages";

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
    const notificationIds: string[] = [];
    const perOwner: Array<{ notificationId: string; owner: (typeof owners)[number] }> = [];
    if (owners.length === 0) {
      const created = await db.notification.create({ data: { ...input, userId: null } });
      notificationIds.push(created.id);
    } else {
      for (const owner of owners) {
        const created = await db.notification.create({ data: { ...input, userId: owner.id } });
        notificationIds.push(created.id);
        perOwner.push({ notificationId: created.id, owner });
      }
    }
    // In-app notification is durable; email is a best-effort deep-link. A
    // mailbox failure must never fail the business action that triggered it.
    try {
      const [{ sendEmail }, { env }] = await Promise.all([import("./email/send"), import("./env")]);
      const absoluteLink = input.link ? `${env.APP_URL.replace(/\/$/, "")}${input.link}` : null;
      for (const { notificationId, owner } of perOwner) {
        const body = [
          `Hello ${owner.name},`,
          "",
          input.body ?? input.title,
          absoluteLink ? `Open: ${absoluteLink}` : "",
          "",
          "This is an automated notification. No customer or supplier message was sent by this alert.",
        ].filter(Boolean).join("\n");
        // Alerts use the same ledger, so a retried business action cannot send
        // the same approval alert twice.
        await sendOutboundOnce(
          {
            operationKey: outboundOperationKey(["notification", notificationId, "email"]),
            kind: "NOTIFICATION",
            channel: "EMAIL",
            recipient: owner.email,
            subject: `[Procurement] ${input.title}`,
            body,
            relatedType: "Notification",
            relatedId: notificationId,
            maxAttempts: 2,
          },
          async () => {
            const sent = await sendEmail({
              to: owner.email,
              subject: `[Procurement] ${input.title}`,
              text: body,
            });
            if (sent.ok) {
              return {
                outcome: "SENT",
                simulated: sent.simulated,
                providerMessageId: sent.providerIds?.messageId ?? null,
                providerThreadId: sent.providerIds?.threadId ?? null,
              };
            }
            return sent.uncertain
              ? { outcome: "UNKNOWN", error: sent.error }
              : { outcome: "FAILED_SAFE", error: sent.error };
          },
        ).catch(() => undefined);
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
        const alertBody = `[Procurement] ${input.title}\n${body}`;
        const alertNotificationId = notificationIds[0];
        const sent = await sendOutboundOnce(
          {
            operationKey: outboundOperationKey(["notification", alertNotificationId, "whatsapp"]),
            kind: "NOTIFICATION",
            channel: "WHATSAPP",
            recipient: org.ownerWhatsappNumber,
            body: alertBody,
            relatedType: "Notification",
            relatedId: alertNotificationId,
            maxAttempts: 2,
          },
          async () => {
            const result = await sendWhatsAppText(org.ownerWhatsappNumber as string, alertBody);
            if (result.ok) {
              return {
                outcome: "SENT",
                simulated: result.simulated,
                providerMessageId: result.messageId ?? null,
              };
            }
            if (result.uncertain) return { outcome: "UNKNOWN", error: result.detail };
            return { outcome: "FAILED_SAFE", error: result.detail };
          },
        );
        const status =
          sent.status === "SENT"
            ? sent.simulated
              ? "WHATSAPP_SIMULATED"
              : "WHATSAPP_SENT"
            : sent.status === "UNCERTAIN" || sent.status === "IN_PROGRESS"
              ? "WHATSAPP_UNKNOWN"
              : /24-hour|service window|template/i.test(sent.detail)
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
