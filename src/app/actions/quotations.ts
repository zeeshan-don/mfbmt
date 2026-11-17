"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { updateQuotationLinePrice, generateAndStoreQuotationPdf, markQuotationSent } from "@/lib/workflow/quotations";

export async function updateQuotationPriceAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const unitPrice = Number(String(formData.get("unitPrice") ?? "").replace(/,/g, ""));

  const result = await updateQuotationLinePrice({
    quotationId,
    itemId,
    unitPrice,
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

export async function markQuotationSentAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const quotationId = String(formData.get("quotationId") ?? "");
  const result = await markQuotationSent({ quotationId, userId: user.id, actorLabel: user.name });
  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) redirect(`/quotations/${quotationId}?error=${encodeURIComponent(result.error ?? "Could not update")}`);
  redirect(`/quotations/${quotationId}?sent=1`);
}
