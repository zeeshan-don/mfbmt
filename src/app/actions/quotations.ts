"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import {
  updateQuotationLinePrice,
  updateQuotationLineTechnical,
  setQuotationOutcome,
  generateAndStoreQuotationPdf,
  sendApprovedQuotation,
  type SendChannel,
} from "@/lib/workflow/quotations";

export async function updateQuotationPriceAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const raw = String(formData.get("unitPrice") ?? "").trim();
  const unitPrice = Number(raw.replace(/,/g, ""));
  if (!raw || Number.isNaN(unitPrice) || unitPrice < 0) {
    redirect(`/quotations/${quotationId}?error=${encodeURIComponent("Enter a valid selling price.")}`);
  }

  const result = await updateQuotationLinePrice({
    quotationId,
    itemId,
    unitPrice,
    reason: String(formData.get("reason") ?? "").trim() || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not update the price")}`);
  redirect(`/quotations/${quotationId}?saved=1`);
}

export async function updateQuotationTechnicalAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const leadTimeRaw = String(formData.get("leadTimeDays") ?? "").trim();
  const leadTimeDays = leadTimeRaw ? Number(leadTimeRaw) : null;
  const validityRaw = String(formData.get("validityDate") ?? "").trim();
  const result = await updateQuotationLineTechnical({
    quotationId,
    itemId,
    countryOfOrigin: String(formData.get("countryOfOrigin") ?? ""),
    certification: String(formData.get("certification") ?? ""),
    leadTimeDays: leadTimeDays != null && Number.isFinite(leadTimeDays) ? leadTimeDays : null,
    deliveryTerms: String(formData.get("deliveryTerms") ?? ""),
    validityDate: validityRaw ? new Date(validityRaw) : null,
    technicalNotes: String(formData.get("technicalNotes") ?? ""),
    userId: user.id,
    actorLabel: user.name,
  });
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not update technical terms")}`);
  redirect(`/quotations/${quotationId}?saved=1`);
}

export async function setQuotationOutcomeAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const result = await setQuotationOutcome({
    quotationId,
    outcome: String(formData.get("outcome") ?? ""),
    reason: String(formData.get("reason") ?? "") || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not record outcome")}`);
  redirect(`/quotations/${quotationId}?saved=1`);
}

export async function generateQuotationPdfAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const result = await generateAndStoreQuotationPdf(quotationId);
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not create the PDF")}`);
  redirect(`/quotations/${quotationId}?pdf=1`);
}

/**
 * Releases an approved quotation.
 *
 * EMAIL and WHATSAPP perform a real provider request; the quotation is only
 * marked SENT when the provider accepts it. MANUAL is an explicit confirmation
 * that the owner sent the downloaded PDF themselves, and is recorded as such.
 */
export async function sendQuotationAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const channel = String(formData.get("channel") ?? "EMAIL") as SendChannel;
  if (!["EMAIL", "WHATSAPP", "MANUAL"].includes(channel)) {
    redirect(`/quotations/${quotationId}?error=${encodeURIComponent("Choose how the quotation is being sent.")}`);
  }

  const result = await sendApprovedQuotation({
    quotationId,
    channel,
    to: String(formData.get("to") ?? "").trim() || null,
    manualNote: String(formData.get("manualNote") ?? "").trim() || null,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) {
    redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not release the quotation")}`);
  }
  redirect(`/quotations/${quotationId}?sent=${encodeURIComponent(result.detail)}`);
}
