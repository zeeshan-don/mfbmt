"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { authorize } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { ingestInboundMessage, processInboundMessage } from "@/lib/workflow/enquiry";
import { recordSupplierResponse } from "@/lib/workflow/supplierQuotes";
import { db } from "@/lib/db";

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function createManualEnquiryAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");

  const text = str(formData.get("text"));
  const customer = str(formData.get("customerName")) ?? "Walk-in customer";
  const phone = str(formData.get("customerPhone"));
  const email = str(formData.get("customerEmail"));
  if (!text) redirect("/enquiries/new?error=Enter+the+customer+request");

  const attachments: Array<{ filename: string; buffer: Buffer }> = [];
  const files = formData.getAll("attachments").filter((file): file is File => file instanceof File && file.size > 0);
  for (const file of files.slice(0, 5)) {
    attachments.push({ filename: file.name, buffer: Buffer.from(await file.arrayBuffer()) });
  }

  const externalMessageId = `manual-${randomUUID()}`;
  const result = await ingestInboundMessage({
    channel: "MANUAL",
    externalMessageId,
    from: phone ?? email ?? customer,
    fromName: customer,
    body: text,
    attachments,
  });

  const message = await db.message.findUnique({ where: { id: result.messageId } });
  if (message) {
    await db.message.update({
      where: { id: message.id },
      data: {
        fromAddress: phone ?? email ?? customer,
        fromName: customer,
      },
    });
  }
  const conversation = message
    ? await db.conversation.findUnique({ where: { id: message.conversationId } })
    : null;
  if (conversation) {
    await db.contact.updateMany({
      where: { id: conversation.contactId ?? "" },
      data: {
        name: customer,
        phone: phone ?? null,
        email: email ?? null,
        kind: "CUSTOMER",
      },
    });
  }

  await processInboundMessage(result.messageId);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "enquiry.created_manually",
    entityType: "Message",
    entityId: result.messageId,
    meta: { warnings: result.warnings },
  });

  revalidatePath("/enquiries");
  redirect(`/enquiries?filter=all&created=1`);
}

export async function submitSupplierResponseAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const unitPrice = Number(String(formData.get("unitPrice") ?? "").replace(/,/g, ""));
  const currency = (str(formData.get("currency")) ?? "AED").toUpperCase();
  const moqRaw = str(formData.get("moq"));
  const leadRaw = str(formData.get("leadTimeDays"));
  const shippingRaw = str(formData.get("shippingCost"));
  const validityRaw = str(formData.get("validityDays"));

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    redirect(`/supplier-response/${token}?error=Enter+a+valid+unit+price`);
  }
  if (currency.length !== 3) {
    redirect(`/supplier-response/${token}?error=Use+a+three-letter+currency+such+as+AED`);
  }

  const result = await recordSupplierResponse({
    token,
    unitPrice,
    currency,
    moq: moqRaw ? Number(moqRaw) : null,
    leadTimeDays: leadRaw ? Number(leadRaw) : null,
    shippingCost: shippingRaw ? Number(shippingRaw) : null,
    validityDays: validityRaw ? Number(validityRaw) : null,
    availability: str(formData.get("availability")),
    notes: str(formData.get("notes")),
  });

  if (!result.ok) redirect(`/supplier-response/${token}?error=${encodeURIComponent(result.error)}`);
  redirect(`/supplier-response/${token}?submitted=1`);
}
