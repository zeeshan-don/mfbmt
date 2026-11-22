"use server";

import { revalidateOrgPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { authorize } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { ingestInboundMessage, processInboundMessage } from "@/lib/workflow/enquiry";
import { recordSupplierResponse } from "@/lib/workflow/supplierQuotes";
import { db } from "@/lib/db";
import { rawDb } from "@/lib/db-base";
import { runWithTenant } from "@/lib/tenant";

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

  revalidateOrgPath(user.organizationId, "/enquiries");
  redirect(`/enquiries?filter=all&created=1`);
}

function optionalNumber(value: FormDataEntryValue | null): number | null {
  const text = str(value)?.replace(/,/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Public supplier response. The token is the only credential and it is
 * single-use by state; every value is validated again on the server because the
 * form is submitted by an outside party.
 */
export async function submitSupplierResponseAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const unitPrice = Number(String(formData.get("unitPrice") ?? "").replace(/,/g, ""));
  const currency = (str(formData.get("currency")) ?? "").toUpperCase();

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    redirect(`/supplier-response/${token}?error=Enter+a+valid+unit+price`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    redirect(`/supplier-response/${token}?error=Use+a+three-letter+currency+such+as+AED`);
  }

  // The public form has no session. The token identifies the tenant; the
  // response is then written entirely inside that tenant's context.
  const tokenQuote = await rawDb.supplierQuote.findFirst({
    where: { token },
    select: { organizationId: true },
  });
  if (!tokenQuote) redirect(`/supplier-response/${token}?error=This+link+is+not+valid`);

  const result = await runWithTenant(
    { organizationId: tokenQuote.organizationId, source: "explicit" },
    () => recordSupplierResponse({
    token,
    unitPrice,
    currency,
    offeredDescription: str(formData.get("offeredDescription")),
    size: str(formData.get("size")),
    material: str(formData.get("material")),
    grade: str(formData.get("grade")),
    pressureRating: str(formData.get("pressureRating")),
    standard: str(formData.get("standard")),
    fastenerType: str(formData.get("fastenerType")),
    threadSeries: str(formData.get("threadSeries")),
    pitchMm: optionalNumber(formData.get("pitchMm")),
    lengthMm: optionalNumber(formData.get("lengthMm")),
    propertyClass: str(formData.get("propertyClass")),
    finish: str(formData.get("finish")),
    moq: optionalNumber(formData.get("moq")),
    quantityAvailable: optionalNumber(formData.get("quantityAvailable")),
    leadTimeDays: optionalNumber(formData.get("leadTimeDays")),
    shippingCost: optionalNumber(formData.get("shippingCost")),
    otherCharges: optionalNumber(formData.get("otherCharges")),
    taxes: optionalNumber(formData.get("taxes")),
    deliveryLocation: str(formData.get("deliveryLocation")),
    paymentTerms: str(formData.get("paymentTerms")),
    validityDays: optionalNumber(formData.get("validityDays")),
    availability: str(formData.get("availability")),
    notes: str(formData.get("notes")),
    }),
  );

  if (!result.ok) redirect(`/supplier-response/${token}?error=${encodeURIComponent(result.error)}`);
  redirect(`/supplier-response/${token}?submitted=1`);
}
