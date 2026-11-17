import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { enqueueJob } from "./jobs";
import { JOB_TYPES } from "../constants";

export type ApprovalDecision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

export async function ensureSourcingApproval(enquiryItemId: string): Promise<string | null> {
  const item = await db.enquiryItem.findUnique({
    where: { id: enquiryItemId },
    include: { enquiry: true, offers: true },
  });
  if (!item) return null;
  const existing = await db.approval.findFirst({
    where: { type: "SOURCING", entityId: item.id, status: "PENDING" },
  });
  if (existing) return existing.id;

  const offers = item.offers
    .map((offer) => ({
      offerId: offer.id,
      supplierName: offer.supplierName,
      matchStatus: offer.matchStatus,
      unitPrice: offer.unitPrice,
      currency: offer.currency,
      isEligible: offer.isEligible,
      status: offer.status,
      snapshot: parseJson<Record<string, unknown>>(offer.landedCostJson, {}),
    }))
    .sort((a, b) => {
      const rankA = Number((a.snapshot.evaluation as { rank?: number } | undefined)?.rank ?? 999);
      const rankB = Number((b.snapshot.evaluation as { rank?: number } | undefined)?.rank ?? 999);
      return rankA - rankB;
    });

  const approval = await db.approval.create({
    data: {
      type: "SOURCING",
      entityType: "EnquiryItem",
      entityId: item.id,
      enquiryId: item.enquiryId,
      status: "PENDING",
      requestedBy: "SYSTEM",
      payloadJson: stringifyJson({
        description: item.description,
        quantityToSource: item.quantityToSource,
        quantityFromStock: item.quantityFromStock,
        offers,
      }),
    },
  });

  await db.enquiryItem.update({
    where: { id: item.id },
    data: { sourcingStatus: offers.length > 0 ? "AWAITING_APPROVAL" : item.sourcingStatus },
  });
  await db.enquiry.update({ where: { id: item.enquiryId }, data: { status: "AWAITING_APPROVAL" } });

  await notifyOwner({
    type: "SOURCING_APPROVAL",
    title: "Supplier options need your approval",
    body: `${item.description.slice(0, 80)} — ${offers.length} option${offers.length === 1 ? "" : "s"} found.`,
    link: `/approvals/${approval.id}`,
  });

  return approval.id;
}

/**
 * Records an owner decision. Approving a supplier is only permission to use
 * that sourcing option in a customer quotation — never a purchase order.
 */
export async function decideApproval(input: {
  approvalId: string;
  decision: ApprovalDecision;
  userId: string;
  actorLabel: string;
  reason?: string | null;
  selectedOfferId?: string | null;
}): Promise<{ ok: true; redirectTo: string } | { ok: false; error: string }> {
  const approval = await db.approval.findUnique({ where: { id: input.approvalId } });
  if (!approval) return { ok: false, error: "Approval not found." };
  if (approval.status !== "PENDING") return { ok: false, error: "This item has already been decided." };

  if (approval.type === "SOURCING") {
    const item = await db.enquiryItem.findUnique({
      where: { id: approval.entityId },
      include: { offers: true, enquiry: true },
    });
    if (!item) return { ok: false, error: "The related product line no longer exists." };

    if (input.decision === "APPROVED") {
      const offer =
        item.offers.find((o) => o.id === input.selectedOfferId) ??
        item.offers
          .filter((o) => o.isEligible)
          .sort((a, b) => {
            const rankOf = (offer: typeof a) => {
              const snapshot = parseJson<{ evaluation?: { rank?: number } }>(offer.landedCostJson, {});
              return snapshot.evaluation?.rank ?? 999;
            };
            return rankOf(a) - rankOf(b);
          })[0];

      if (!offer) return { ok: false, error: "Select a supplier offer to approve." };
      if (!offer.isEligible && !input.reason?.trim()) {
        return {
          ok: false,
          error: "This supplier option is not eligible. Record a reason to override the recommendation.",
        };
      }

      await db.enquiryItem.update({
        where: { id: item.id },
        data: { approvedOfferId: offer.id, sourcingStatus: "APPROVED" },
      });
    } else {
      await db.enquiryItem.update({
        where: { id: item.id },
        data: { sourcingStatus: "RESULTS_READY" },
      });
    }

    const remaining = await db.enquiryItem.count({
      where: { enquiryId: item.enquiryId, sourcingStatus: { in: ["AWAITING_APPROVAL", "RESULTS_READY", "SEARCHING", "QUEUED"] } },
    });
    await db.enquiry.update({
      where: { id: item.enquiryId },
      data: { status: remaining === 0 ? "APPROVED" : "AWAITING_APPROVAL" },
    });
  }

  if (approval.type === "CUSTOMER_QUOTATION") {
    if (input.decision === "APPROVED") {
      await db.customerQuotation.update({
        where: { id: approval.entityId },
        data: {
          status: "APPROVED",
          approvedById: input.userId,
          approvedAt: new Date(),
        },
      });
    } else {
      await db.customerQuotation.update({
        where: { id: approval.entityId },
        data: { status: "DRAFT" },
      });
    }
  }

  if (approval.type === "SUPPLIER_QUOTE_SEND" && input.decision === "APPROVED") {
    await enqueueJob({
      type: JOB_TYPES.SEND_SUPPLIER_RFQ,
      payload: { supplierQuoteId: approval.entityId },
      idempotencyKey: `supplier-rfq:${approval.entityId}`,
    });
  }

  await db.approval.update({
    where: { id: approval.id },
    data: {
      status: input.decision,
      decidedById: input.userId,
      decidedAt: new Date(),
      reason: input.reason?.trim() || null,
    },
  });

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: `approval.${input.decision.toLowerCase()}`,
    entityType: approval.type,
    entityId: approval.entityId,
    meta: { approvalId: approval.id, reason: input.reason ?? null, selectedOfferId: input.selectedOfferId ?? null },
  });

  return { ok: true, redirectTo: approval.enquiryId ? `/enquiries/${approval.enquiryId}` : "/approvals" };
}

/** Requests another supplier search for the same item (owner action). */
export async function requestAnotherSearch(enquiryItemId: string) {
  const item = await db.enquiryItem.findUnique({ where: { id: enquiryItemId } });
  if (!item) throw new Error("Item not found");
  await enqueueJob({
    type: JOB_TYPES.RUN_SOURCING,
    payload: { enquiryItemId },
    idempotencyKey: `sourcing:${enquiryItemId}:manual:${Date.now()}`,
  });
  await db.enquiryItem.update({ where: { id: enquiryItemId }, data: { sourcingStatus: "QUEUED" } });
}
