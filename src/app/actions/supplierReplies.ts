"use server";

import { revalidateOrgPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { assignSupplierReplyToQuote, setSupplierReplyReviewStatus } from "@/lib/workflow/supplierReply";

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
