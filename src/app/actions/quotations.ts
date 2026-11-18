"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import {
  updateQuotationLinePrice,
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
