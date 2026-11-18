"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { isDemoMode } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { FASTENER_DEMO_REFS, resetFastenerWalkthrough, seedFastenerWalkthrough } from "@/scripts/demo-fasteners";

function assertDemo() {
  if (!isDemoMode) throw new Error("Demo actions are only available with DEMO_MODE=true.");
}

/** Rebuilds only the two walkthrough records; the original demo data is untouched. */
export async function resetDemoWalkthroughAction() {
  assertDemo();
  const user = await requireOwner();
  await resetFastenerWalkthrough(db);
  await seedFastenerWalkthrough(db);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "demo.walkthrough_reset",
    entityType: "System",
    entityId: "demo-walkthrough",
    meta: { refs: Object.values(FASTENER_DEMO_REFS), sample: true },
  });
  revalidatePath("/demo");
  redirect("/demo?reset=1");
}

/**
 * Demo-only simulation of releasing a customer quotation. It writes the local
 * activity record and never calls an email/WhatsApp provider or creates an order.
 */
export async function simulateDemoSendAction() {
  assertDemo();
  const user = await requireOwner();
  const quotation = await db.customerQuotation.findFirst({
    where: { isDemo: true, enquiry: { publicRef: FASTENER_DEMO_REFS.quoted } },
    orderBy: { createdAt: "desc" },
  });
  if (!quotation) redirect("/demo?error=No+sample+quotation+found");
  if (quotation.status === "DRAFT" || quotation.status === "AWAITING_APPROVAL") {
    redirect("/demo?error=The+sample+quotation+must+be+approved+before+simulation");
  }
  await db.customerQuotation.update({
    where: { id: quotation.id },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sentChannel: "DEMO",
      sentTo: quotation.customerEmail ?? quotation.customerPhone,
      sendError: "Demo simulation — no message was transmitted.",
    },
  });
  await db.enquiry.update({ where: { id: quotation.enquiryId }, data: { status: "QUOTED" } });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "quotation.simulated_sent",
    entityType: "CustomerQuotation",
    entityId: quotation.id,
    meta: { channel: "DEMO", simulated: true, to: quotation.customerEmail ?? quotation.customerPhone },
  });
  revalidatePath("/demo");
  redirect("/demo?simulated=1");
}
