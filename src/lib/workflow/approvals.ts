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
      verificationStatus: offer.verificationStatus,
      snapshot: parseJson<Record<string, unknown>>(offer.landedCostJson, {}),
    }))
    .sort((a, b) => {
      const rankA = Number((a.snapshot.evaluation as { rank?: number } | undefined)?.rank ?? 999);
      const rankB = Number((b.snapshot.evaluation as { rank?: number } | undefined)?.rank ?? 999);
      return rankA - rankB;
    });

  let approval: { id: string };
  try {
    approval = await db.approval.create({
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
  } catch (error) {
    // Two concurrent sourcing runs can finish together; the unique
    // (type, entityId, status) constraint means only one pending approval exists.
    const existingPending = await db.approval.findFirst({
      where: { type: "SOURCING", entityId: item.id, status: "PENDING" },
    });
    if (existingPending) return existingPending.id;
    throw error;
  }

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

type DecisionResult = { ok: true; redirectTo: string } | { ok: false; error: string };

/**
 * Records an owner decision exactly once.
 *
 * The approval row is claimed with a conditional update inside a transaction, so
 * two owner tabs (or a double submit) cannot both apply a decision. Each approval
 * type keeps its own meaning:
 *   SOURCING            — permission to use a supplier option in a quote (not a purchase)
 *   SUPPLIER_QUOTE_SEND — permission to transmit a supplier RFQ
 *   CUSTOMER_QUOTATION  — permission to release a customer quotation
 */
export async function decideApproval(input: {
  approvalId: string;
  decision: ApprovalDecision;
  userId: string;
  actorLabel: string;
  reason?: string | null;
  selectedOfferId?: string | null;
}): Promise<DecisionResult> {
  const approval = await db.approval.findUnique({ where: { id: input.approvalId } });
  if (!approval) return { ok: false, error: "Approval not found." };
  if (approval.status !== "PENDING") {
    return { ok: false, error: "This item has already been decided." };
  }

  // ---- CUSTOMER_QUOTATION -------------------------------------------------
  if (approval.type === "CUSTOMER_QUOTATION") {
    const quotation = await db.customerQuotation.findUnique({
      where: { id: approval.entityId },
      include: { items: true },
    });
    if (!quotation) return { ok: false, error: "The quotation no longer exists." };
    if (quotation.status === "APPROVED") return { ok: false, error: "This quotation was already approved." };

    if (input.decision === "APPROVED") {
      const unpriced = quotation.items.filter((item) => item.unitPrice == null);
      if (unpriced.length > 0 && !input.reason?.trim()) {
        return {
          ok: false,
          error: `${unpriced.length} line(s) have no price. Price them, or record an explicit reason to approve an unpriced quotation.`,
        };
      }
      if (unpriced.length > 0) {
        await db.customerQuotation.update({
          where: { id: quotation.id },
          data: {
            pricingExceptionById: input.userId,
            pricingExceptionAt: new Date(),
            pricingExceptionReason: input.reason?.trim(),
          },
        });
        await writeAudit({
          actorId: input.userId,
          actorLabel: input.actorLabel,
          action: "quotation.pricing_exception_approved",
          entityType: "CustomerQuotation",
          entityId: quotation.id,
          meta: { reason: input.reason ?? null, unpricedLines: unpriced.map((item) => item.description) },
        });
      }
    }

    const result = await db.$transaction(async (tx) => {
      const claimed = await tx.approval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: {
          status: input.decision,
          decidedById: input.userId,
          decidedAt: new Date(),
          reason: input.reason?.trim() || null,
        },
      });
      if (claimed.count === 0) return false;
      await tx.customerQuotation.updateMany({
        where: { id: quotation.id, status: { in: ["DRAFT", "AWAITING_APPROVAL"] } },
        data:
          input.decision === "APPROVED"
            ? { status: "APPROVED", approvedById: input.userId, approvedAt: new Date() }
            : { status: "DRAFT" },
      });
      return true;
    });
    if (!result) return { ok: false, error: "This item has already been decided." };

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: `quotation.${input.decision.toLowerCase()}`,
      entityType: "CustomerQuotation",
      entityId: quotation.id,
      meta: { approvalId: approval.id, reason: input.reason ?? null },
    });
    return { ok: true, redirectTo: `/quotations/${quotation.id}` };
  }

  // ---- SUPPLIER_QUOTE_SEND ------------------------------------------------
  if (approval.type === "SUPPLIER_QUOTE_SEND") {
    const quote = await db.supplierQuote.findUnique({
      where: { id: approval.entityId },
      include: { supplier: true, items: true },
    });
    if (!quote) return { ok: false, error: "The supplier request no longer exists." };
    if (quote.expiresAt.getTime() < Date.now()) {
      return { ok: false, error: "This supplier request link has already expired. Create a new one." };
    }

    const claimed = await db.approval.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: {
        status: input.decision,
        decidedById: input.userId,
        decidedAt: new Date(),
        reason: input.reason?.trim() || null,
      },
    });
    if (claimed.count === 0) return { ok: false, error: "This item has already been decided." };

    if (input.decision === "APPROVED") {
      await enqueueJob({
        type: JOB_TYPES.SEND_SUPPLIER_RFQ,
        payload: { supplierQuoteId: approval.entityId },
        idempotencyKey: `supplier-rfq:${approval.entityId}`,
      });
    } else {
      await db.supplierQuote.update({ where: { id: quote.id }, data: { status: "REQUESTED" } });
    }

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: `supplier_quote.send_${input.decision.toLowerCase()}`,
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: { approvalId: approval.id, reason: input.reason ?? null },
    });
    return { ok: true, redirectTo: quote.enquiryItemId ? `/sourcing/${quote.enquiryItemId}` : "/approvals" };
  }

  // ---- SOURCING -----------------------------------------------------------
  if (approval.type === "SOURCING") {
    const item = await db.enquiryItem.findUnique({
      where: { id: approval.entityId },
      include: { offers: true, enquiry: true },
    });
    if (!item) return { ok: false, error: "The related product line no longer exists." };

    let chosenOfferId: string | null = null;
    if (input.decision === "APPROVED") {
      const offer =
        item.offers.find((candidate) => candidate.id === input.selectedOfferId) ??
        item.offers
          .filter((candidate) => candidate.isEligible)
          .sort((a, b) => {
            const rankOf = (candidate: typeof a) => {
              const snapshot = parseJson<{ evaluation?: { rank?: number } }>(candidate.landedCostJson, {});
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
      if (offer.verificationStatus === "EXPIRED" || (offer.validityDate && offer.validityDate.getTime() < Date.now())) {
        return { ok: false, error: "This supplier quotation has expired. Request a fresh quotation first." };
      }
      chosenOfferId = offer.id;
    }

    const applied = await db.$transaction(async (tx) => {
      const claimed = await tx.approval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: {
          status: input.decision,
          decidedById: input.userId,
          decidedAt: new Date(),
          reason: input.reason?.trim() || null,
        },
      });
      if (claimed.count === 0) return false;
      await tx.enquiryItem.update({
        where: { id: item.id },
        data:
          input.decision === "APPROVED"
            ? { approvedOfferId: chosenOfferId, sourcingStatus: "APPROVED" }
            : { sourcingStatus: "RESULTS_READY" },
      });
      return true;
    });
    if (!applied) return { ok: false, error: "This item has already been decided." };

    const remaining = await db.enquiryItem.count({
      where: {
        enquiryId: item.enquiryId,
        sourcingStatus: { in: ["AWAITING_APPROVAL", "RESULTS_READY", "SEARCHING", "QUEUED"] },
      },
    });
    await db.enquiry.update({
      where: { id: item.enquiryId },
      data: { status: remaining === 0 ? "APPROVED" : "AWAITING_APPROVAL" },
    });

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: `approval.${input.decision.toLowerCase()}`,
      entityType: approval.type,
      entityId: approval.entityId,
      meta: {
        approvalId: approval.id,
        reason: input.reason ?? null,
        selectedOfferId: chosenOfferId,
        overrideOfIneligible: Boolean(
          input.decision === "APPROVED" &&
            !item.offers.find((offer) => offer.id === chosenOfferId)?.isEligible,
        ),
      },
    });

    return { ok: true, redirectTo: `/enquiries/${item.enquiryId}` };
  }

  // ---- PRICING_OVERRIDE ---------------------------------------------------
  const claimed = await db.approval.updateMany({
    where: { id: approval.id, status: "PENDING" },
    data: {
      status: input.decision,
      decidedById: input.userId,
      decidedAt: new Date(),
      reason: input.reason?.trim() || null,
    },
  });
  if (claimed.count === 0) return { ok: false, error: "This item has already been decided." };

  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: `approval.${input.decision.toLowerCase()}`,
    entityType: approval.type,
    entityId: approval.entityId,
    meta: { approvalId: approval.id, reason: input.reason ?? null },
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
