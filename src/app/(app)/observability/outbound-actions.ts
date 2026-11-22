"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { reconcileOutbound } from "@/lib/outbound/messages";
import { runWithTenant } from "@/lib/tenant";

/**
 * Records a human reconciliation decision for an UNKNOWN outbound message.
 *
 * A note is mandatory: "SENT" and "NOT_SENT" are consequential decisions and
 * must leave an auditable explanation. The ledger itself rejects a live
 * SENDING claim, so this action cannot race an in-flight provider call.
 */
export async function reconcileOutboundAction(formData: FormData) {
  const user = await requireOwner();
  const id = String(formData.get("id") ?? "").trim();
  const resolution = String(formData.get("resolution") ?? "").trim();
  const providerMessageId = String(formData.get("providerMessageId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!id || !["SENT", "NOT_SENT"].includes(resolution) || note.length < 3) {
    redirect("/observability?outbound=invalid");
  }

  const result = await runWithTenant(
    { organizationId: user.organizationId, userId: user.id, source: "session" },
    () =>
      reconcileOutbound({
        id,
        resolution: resolution as "SENT" | "NOT_SENT",
        providerMessageId: providerMessageId || null,
        note,
        actorLabel: user.email,
      }),
  );

  revalidatePath("/observability");
  redirect(result.ok ? "/observability?outbound=reconciled" : "/observability?outbound=stale");
}
