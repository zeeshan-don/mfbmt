"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorize, authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { stringifyJson } from "@/lib/json";
import { recomputeOffersForItem } from "@/lib/costing/evaluate";
import { ensureSourcingApproval, decideApproval, requestAnotherSearch } from "@/lib/workflow/approvals";
import { createSupplierQuoteRequest } from "@/lib/workflow/supplierQuotes";
import { matchProduct } from "@/lib/inventory/matching";

function num(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function recordManualOfferAction(formData: FormData) {
  const user = await authorize("sourcing.view");
  if (!user) redirect("/login");
  const itemId = String(formData.get("itemId") ?? "");
  const item = await db.enquiryItem.findUnique({ where: { id: itemId }, include: { enquiry: true } });
  if (!item) redirect(`/sourcing?error=Product+line+not+found`);

  const supplierName = str(formData.get("supplierName"));
  if (!supplierName) redirect(`/sourcing/${itemId}?error=Enter+the+supplier+name`);

  const supplierId = str(formData.get("supplierId"));
  const unitPrice = num(formData.get("unitPrice"));
  const currency = (str(formData.get("currency")) ?? item.enquiry.currency ?? "AED").toUpperCase();
  const reference = str(formData.get("reference"));

  const supplier = supplierId
    ? await db.supplier.findUnique({ where: { id: supplierId } })
    : await db.supplier.findFirst({ where: { name: { contains: supplierName } } });

  const match = matchProduct(
    {
      description: item.description,
      category: item.category,
      brand: item.brand,
      size: item.size,
      material: item.material,
      grade: item.grade,
      pressureRating: item.pressureRating,
      schedule: item.schedule,
      standard: item.standard,
    },
    {
      description: `${str(formData.get("productTitle")) ?? item.description}`,
      size: str(formData.get("offeredSize")),
      material: str(formData.get("offeredMaterial")),
      grade: str(formData.get("offeredGrade")),
      pressureRating: str(formData.get("offeredPressure")),
      standard: str(formData.get("offeredStandard")),
      brand: str(formData.get("offeredBrand")),
    },
    { strictStandard: Boolean(item.standard) },
  );

  const validityRaw = str(formData.get("validityDate"));

  await db.supplierOffer.create({
    data: {
      enquiryItemId: item.id,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? supplierName,
      productTitle: str(formData.get("productTitle")) ?? item.description,
      matchStatus: match.status === "NO_MATCH" ? "POSSIBLE" : match.status,
      unitPrice,
      currency,
      moq: num(formData.get("moq")),
      shippingCost: num(formData.get("shippingCost")),
      otherCharges: num(formData.get("otherCharges")),
      taxes: num(formData.get("taxes")),
      leadTimeDays: num(formData.get("leadTimeDays")),
      quantityAvailable: num(formData.get("quantityAvailable")),
      validityDate: validityRaw ? new Date(validityRaw) : null,
      paymentTerms: str(formData.get("paymentTerms")),
      status: "PRICE_CONFIRMED",
      sourceType: "MANUAL",
      quotedAt: new Date(),
      quoteRef: reference,
      verificationStatus: "VERIFIED",
      evidenceJson: stringifyJson({
        enteredBy: user.name,
        enteredAt: new Date().toISOString(),
        reference,
        match,
        note: "Price entered by MFBMT from a supplier communication.",
      }),
    },
  });

  await recomputeOffersForItem(item.id);
  await ensureSourcingApproval(item.id);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "supplier_offer.recorded",
    entityType: "EnquiryItem",
    entityId: item.id,
    meta: { supplierName, unitPrice, currency, matchStatus: match.status },
  });

  revalidatePath(`/sourcing/${itemId}`);
  redirect(`/sourcing/${itemId}?saved=1`);
}

export async function approveOfferAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const itemId = String(formData.get("itemId") ?? "");
  const offerId = String(formData.get("offerId") ?? "");
  const reason = str(formData.get("reason"));

  const approvalId = await ensureSourcingApproval(itemId);
  if (!approvalId) redirect(`/sourcing/${itemId}?error=Could+not+create+approval`);

  const result = await decideApproval({
    approvalId,
    decision: "APPROVED",
    userId: user.id,
    actorLabel: user.name,
    reason,
    selectedOfferId: offerId || null,
  });

  if (!result.ok) redirect(`/sourcing/${itemId}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(`/sourcing/${itemId}`);
  redirect(`/sourcing/${itemId}?approved=1`);
}

export async function requestMoreQuotesAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const itemId = String(formData.get("itemId") ?? "");
  await requestAnotherSearch(itemId);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.requested_again",
    entityType: "EnquiryItem",
    entityId: itemId,
  });
  revalidatePath(`/sourcing/${itemId}`);
  redirect(`/sourcing/${itemId}?queued=1`);
}

export async function createSupplierQuoteAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const itemId = String(formData.get("itemId") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "");
  if (!supplierId) redirect(`/sourcing/${itemId}?error=Choose+a+supplier`);

  const result = await createSupplierQuoteRequest({
    supplierId,
    enquiryItemId: itemId,
    userId: user.id,
    actorLabel: user.name,
  });
  revalidatePath(`/sourcing/${itemId}`);
  if (!result.ok) redirect(`/sourcing/${itemId}?error=${encodeURIComponent(result.error)}`);
  redirect(`/sourcing/${itemId}?requested=1`);
}
