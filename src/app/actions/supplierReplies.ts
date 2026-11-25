"use server";

import { revalidateOrgPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { writeAudit } from "@/lib/audit";
import { markAttachmentPageUnreadable } from "@/lib/intake/documentReview";
import {
  assignSupplierReplyToQuote,
  confirmSupplierReplyExtraction,
  enrichSupplierReplyAi,
  linkSupplierReplyToSupplier,
  markSupplierReplyQuotedItemIrrelevant,
  setSupplierReplyReviewStatus,
  updateSupplierReplyExtractionFields,
} from "@/lib/workflow/supplierReply";

export async function markSupplierDocumentPageUnreadableAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const attachmentId = String(formData.get("attachmentId") ?? "");
  const page = Number(formData.get("page") ?? 0);
  try {
    await markAttachmentPageUnreadable({ attachmentId, page, actorId: user.id, actorLabel: user.name });
  } catch (error) {
    redirect(`/suppliers/replies?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not mark the page")}`);
  }
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  redirect("/suppliers/replies?saved=1");
}

export async function assignSupplierReplyAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  const supplierQuoteId = String(formData.get("supplierQuoteId") ?? "");
  if (!replyId || !supplierQuoteId) redirect("/suppliers/replies?error=Choose+the+correct+RFQ");

  const result = await assignSupplierReplyToQuote({
    replyId,
    supplierQuoteId,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}

function optionalNumber(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function correctSupplierReplyFieldsAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");

  const result = await updateSupplierReplyExtractionFields({
    replyId,
    userId: user.id,
    actorLabel: user.name,
    fields: {
      unitPrice: optionalNumber(formData.get("unitPrice")),
      currency: formData.has("currency") ? String(formData.get("currency") ?? "") : undefined,
      moq: optionalNumber(formData.get("moq")),
      leadTimeDays: optionalNumber(formData.get("leadTimeDays")),
      shippingCost: optionalNumber(formData.get("shippingCost")),
      taxes: optionalNumber(formData.get("taxes")),
      paymentTerms: formData.has("paymentTerms") ? String(formData.get("paymentTerms") ?? "") : undefined,
      validityDays: optionalNumber(formData.get("validityDays")),
      description: formData.has("description") ? String(formData.get("description") ?? "") : undefined,
    },
  });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}

export async function confirmSupplierReplyAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");

  const result = await confirmSupplierReplyExtraction({ replyId, userId: user.id, actorLabel: user.name });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}

export async function markSupplierReplyItemIrrelevantAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  const itemIndex = Number(formData.get("itemIndex") ?? -1);
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");

  const result = await markSupplierReplyQuotedItemIrrelevant({
    replyId,
    itemIndex,
    note: String(formData.get("note") ?? "") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}

export async function linkSupplierReplySupplierAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "");
  if (!replyId || !supplierId) redirect("/suppliers/replies?error=Choose+the+supplier");

  const result = await linkSupplierReplyToSupplier({ replyId, supplierId, userId: user.id, actorLabel: user.name });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}

export async function reprocessSupplierReplyAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");

  try {
    await enrichSupplierReplyAi(replyId);
  } catch (error) {
    revalidateOrgPath(user.organizationId, "/suppliers/replies");
    redirect(
      `/suppliers/replies?error=${encodeURIComponent(
        error instanceof Error ? error.message.slice(0, 200) : "The AI reading pass failed.",
      )}`,
    );
  }
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  redirect("/suppliers/replies?saved=1");
}

export async function reprocessSupplierReplyDocumentsAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");
  const mode = String(formData.get("mode") ?? "retry") === "vision" ? "vision" : "retry";
  await enqueueJob({
    type: JOB_TYPES.REPROCESS_DOCUMENTS,
    payload: { supplierReplyId: replyId, mode },
    idempotencyKey: `reprocess-supplier-documents:${replyId}:${Date.now()}`,
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "supplier_reply.documents_reprocess_requested",
    entityType: "SupplierEmailReply",
    entityId: replyId,
    meta: { mode },
  });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  redirect("/suppliers/replies?saved=1");
}

export async function dismissSupplierReplyAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const replyId = String(formData.get("replyId") ?? "");
  const reviewStatus = String(formData.get("reviewStatus") ?? "DISMISSED") === "REVIEWED" ? "REVIEWED" : "DISMISSED";
  if (!replyId) redirect("/suppliers/replies?error=Missing+supplier+reply");

  const result = await setSupplierReplyReviewStatus({
    replyId,
    reviewStatus,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidateOrgPath(user.organizationId, "/suppliers/replies");
  if (!result.ok) redirect(`/suppliers/replies?error=${encodeURIComponent(result.error)}`);
  redirect("/suppliers/replies?saved=1");
}
