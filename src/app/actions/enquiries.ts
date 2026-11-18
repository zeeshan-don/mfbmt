"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorize, authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { updateEnquiryItemValues, parseQuantityInput } from "@/lib/workflow/itemEdit";
import { applyInventoryCheck } from "@/lib/inventory/check";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { extractEnquiryById } from "@/lib/workflow/enquiry";
import { createQuotationDraft } from "@/lib/workflow/quotations";

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function optionalNumber(value: FormDataEntryValue | null): number | null {
  const text = str(value);
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function updateItemAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");

  const itemId = String(formData.get("itemId") ?? "");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  if (!itemId || !enquiryId) redirect(`/enquiries/${enquiryId}?error=Missing+product+line`);

  const rawQuantity = String(formData.get("quantity") ?? "");
  const parsed = parseQuantityInput(rawQuantity);

  try {
    await updateEnquiryItemValues({
      itemId,
      values: {
        description: str(formData.get("description")) ?? undefined,
        quantity: parsed.quantity,
        unit: str(formData.get("unit")) ?? undefined,
        category: str(formData.get("category")),
        brand: str(formData.get("brand")),
        size: str(formData.get("size")),
        material: str(formData.get("material")),
        grade: str(formData.get("grade")),
        pressureRating: str(formData.get("pressureRating")),
        schedule: str(formData.get("schedule")),
        standard: str(formData.get("standard")),
        fastenerSpec: str(formData.get("fastenerType")) || optionalNumber(formData.get("pitchMm")) || optionalNumber(formData.get("lengthMm"))
          ? {
              type: (str(formData.get("fastenerType")) as never) ?? undefined,
              diameter: str(formData.get("fastenerDiameter")) ?? undefined,
              threadSeries: (str(formData.get("threadSeries")) as never) ?? undefined,
              pitchMm: optionalNumber(formData.get("pitchMm")) ?? undefined,
              lengthMm: optionalNumber(formData.get("lengthMm")) ?? undefined,
              propertyClass: str(formData.get("propertyClass")) ?? undefined,
              finish: (str(formData.get("finish")) as never) ?? undefined,
            }
          : undefined,
      },
      confirm: str(formData.get("confirm")) === "1",
    });
    await applyInventoryCheck(itemId);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "enquiry_item.updated",
      entityType: "EnquiryItem",
      entityId: itemId,
      meta: { enquiryId },
    });
  } catch (error) {
    redirect(`/enquiries/${enquiryId}?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not save")}`);
  }
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?saved=1`);
}

export async function recheckStockAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  const items = await db.enquiryItem.findMany({ where: { enquiryId } });
  for (const item of items) await applyInventoryCheck(item.id);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "inventory.recheck",
    entityType: "Enquiry",
    entityId: enquiryId,
  });
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?stock=checked`);
}

export async function runSourcingAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");
  const itemId = String(formData.get("itemId") ?? "");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  const item = await db.enquiryItem.findUnique({ where: { id: itemId } });
  if (!item) redirect(`/enquiries/${enquiryId}?error=Product+line+not+found`);
  if (item.quantityToSource <= 0) {
    redirect(`/enquiries/${enquiryId}?error=This+product+is+covered+by+stock`);
  }
  await enqueueJob({
    type: JOB_TYPES.RUN_SOURCING,
    payload: { enquiryItemId: itemId },
    idempotencyKey: `sourcing:${itemId}:manual:${Date.now()}`,
  });
  await db.enquiryItem.update({ where: { id: itemId }, data: { sourcingStatus: "QUEUED" } });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.requested",
    entityType: "EnquiryItem",
    entityId: itemId,
  });
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?queued=1`);
}

export async function retryExtractionAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  await db.enquiry.update({
    where: { id: enquiryId },
    data: { status: "EXTRACTING", requiresReview: false, reviewReason: null },
  });
  await extractEnquiryById(enquiryId);
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?saved=1`);
}

export async function markAsRfqAction(formData: FormData) {
  const user = await authorize("enquiries.review");
  if (!user) redirect("/login");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  await db.enquiry.update({
    where: { id: enquiryId },
    data: {
      classification: "RFQ",
      classificationConfidence: 1,
      status: "EXTRACTING",
      requiresReview: false,
      reviewReason: null,
    },
  });
  const message = await db.message.findUnique({ where: { enquiryId } });
  if (message) {
    await db.message.update({
      where: { id: message.id },
      data: { processingStatus: "PROCESSING", classification: "RFQ", classificationConfidence: 1 },
    });
  }
  await extractEnquiryById(enquiryId);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "enquiry.marked_rfq",
    entityType: "Enquiry",
    entityId: enquiryId,
  });
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?saved=1`);
}

export async function closeEnquiryAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  const status = String(formData.get("status") ?? "CLOSED");
  await db.enquiry.update({
    where: { id: enquiryId },
    data: { status, requiresReview: false },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "enquiry.status_changed",
    entityType: "Enquiry",
    entityId: enquiryId,
    meta: { status },
  });
  revalidatePath(`/enquiries/${enquiryId}`);
  redirect(`/enquiries/${enquiryId}?saved=1`);
}

export async function buildQuotationAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const enquiryId = String(formData.get("enquiryId") ?? "");
  const result = await createQuotationDraft({ enquiryId, userId: user.id, actorLabel: user.name });
  revalidatePath(`/enquiries/${enquiryId}`);
  if (!result.ok) redirect(`/enquiries/${enquiryId}?error=${encodeURIComponent(result.error)}`);
  redirect(`/quotations/${result.quotationId}`);
}
