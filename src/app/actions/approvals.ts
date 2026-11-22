"use server";

import { revalidateOrgPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { decideApproval, type ApprovalDecision } from "@/lib/workflow/approvals";
import { db } from "@/lib/db";

export async function decideApprovalAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");

  const approvalId = String(formData.get("approvalId") ?? "");
  const decisionRaw = String(formData.get("decision") ?? "");
  const decision = decisionRaw as ApprovalDecision;
  if (!["APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(decision)) {
    redirect(`/approvals/${approvalId}?error=Choose+approve+or+reject`);
  }
  const selectedOfferId = String(formData.get("selectedOfferId") ?? "") || null;
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const returnTo = String(formData.get("returnTo") ?? "");

  const result = await decideApproval({
    approvalId,
    decision,
    userId: user.id,
    actorLabel: user.name,
    reason,
    selectedOfferId,
  });

  if (!result.ok) redirect(`/approvals/${approvalId}?error=${encodeURIComponent(result.error)}`);

  revalidateOrgPath(user.organizationId, "/approvals");
  revalidateOrgPath(user.organizationId, result.redirectTo);
  if (returnTo === "list") redirect(`/approvals?decided=1`);
  redirect(result.redirectTo);
}

export async function markNotificationsReadAction() {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  await db.notification.updateMany({
    where: { OR: [{ userId: user.id }, { userId: null }] },
    data: { isRead: true },
  });
  revalidateOrgPath(user.organizationId, "/activity");
  redirect("/activity#notifications");
}
