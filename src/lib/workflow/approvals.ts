import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { enqueueJob } from "./jobs";
import { sendSupplierQuoteRequest } from "./supplierQuotes";
import { JOB_TYPES } from "../constants";
import { marginPct } from "../pricing/rules";
import {
  InsufficientStockError,
  releaseQuotationReservationsInTransaction,
  reserveQuotationStockInTransaction,
  type InsufficientStockLine,
} from "../inventory/reservations";

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
      const org = await db.organization.findUnique({ where: { id: quotation.organizationId } });
      const floor = org?.minMarginPct ?? 0;
      if (floor > 0 && quotation.internalCostComplete && quotation.internalCostTotal != null) {
        const actual = marginPct(quotation.internalCostTotal, quotation.subtotal);
        if (actual != null && actual < floor && !input.reason?.trim()) {
          return {
            ok: false,
            error: `This quotation's margin (${actual.toFixed(1)}%) is below the ${floor}% floor. Record an explicit owner exception reason, or change the price.`,
          };
        }
        if (actual != null && actual < floor) {
          await db.customerQuotation.update({
            where: { id: quotation.id },
            data: { marginExceptionReason: input.reason?.trim() },
          });
          await writeAudit({
            actorId: input.userId,
            actorLabel: input.actorLabel,
            action: "quotation.margin_exception_approved",
            entityType: "CustomerQuotation",
            entityId: quotation.id,
            meta: { actual, floor, reason: input.reason ?? null },
          });
        }
      }
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

    // ---- Approval + reservation in one transaction -------------------------
    // The approval claim, stock reservation and quotation status change commit
    // together. Insufficient stock rolls the claim back, so a failed reservation
    // can never leave an approved quotation. An owner may explicitly override
    // with a recorded reason; the override is audited and no reservation is
    // invented for the uncovered quantity.
    let stockOverride: InsufficientStockLine[] | null = null;
    let reservationsCreated = 0;
    let reservationsDuplicate = 0;
    let reservationsReleased = 0;
    let alreadyDecided = false;

    try {
      await db.$transaction(async (tx) => {
        const claimed = await tx.approval.updateMany({
          where: { id: approval.id, status: "PENDING" },
          data: {
            status: input.decision,
            decidedById: input.userId,
            decidedAt: new Date(),
            reason: input.reason?.trim() || null,
          },
        });
        if (claimed.count === 0) {
          alreadyDecided = true;
          return;
        }

        if (input.decision === "APPROVED") {
          try {
            const reserved = await reserveQuotationStockInTransaction(tx, {
              organizationId: quotation.organizationId,
              quotationId: quotation.id,
              userId: input.userId,
            });
            reservationsCreated = reserved.created.length;
            reservationsDuplicate = reserved.duplicates.length;
          } catch (error) {
            if (!(error instanceof InsufficientStockError)) throw error;
            if (!input.reason?.trim()) throw error;
            stockOverride = error.lines;
          }
        } else {
          reservationsReleased = await releaseQuotationReservationsInTransaction(tx, {
            organizationId: quotation.organizationId,
            quotationId: quotation.id,
            reason: `Quotation ${input.decision.toLowerCase()}`,
          });
        }

        await tx.customerQuotation.updateMany({
          where: { id: quotation.id, status: { in: ["DRAFT", "AWAITING_APPROVAL"] } },
          data:
            input.decision === "APPROVED"
              ? { status: "APPROVED", approvedById: input.userId, approvedAt: new Date() }
              : { status: "DRAFT" },
        });
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        return {
          ok: false,
          error: `Insufficient stock for ${error.lines.length} line(s): ${error.lines
            .map((line) => `${line.description} need ${line.required}, available ${line.available}`)
            .join("; ")}. Record an explicit override reason, or adjust stock.`,
        };
      }
      throw error;
    }
    if (alreadyDecided) return { ok: false, error: "This item has already been decided." };

    if (stockOverride) {
      await writeAudit({
        actorId: input.userId,
        actorLabel: input.actorLabel,
        action: "quotation.stock_override",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        meta: { lines: stockOverride, reason: input.reason ?? null, reservationsCreated },
      });
    }
    if (reservationsCreated > 0 || reservationsDuplicate > 0) {
      await writeAudit({
        actorId: input.userId,
        actorLabel: input.actorLabel,
        action: "quotation.stock_reserved",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        meta: { reservationsCreated, reservationsDuplicate, reservationsReleased },
      });
    }
    if (reservationsReleased > 0) {
      await writeAudit({
        actorId: input.userId,
        actorLabel: input.actorLabel,
        action: "quotation.stock_released",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        meta: { reservationsReleased, reason: input.reason ?? null },
      });
    }

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
      // Send immediately once approved, rather than waiting for a worker tick,
      // so an approved RFQ is transmitted right away. The outbound ledger keeps
      // this idempotent if the same approval is ever applied twice.
      const sendResult = await sendSupplierQuoteRequest(quote.id);
      if (!sendResult.ok) {
        // The owner's approval is valid even when transmission cannot happen
        // yet (for example no email/WhatsApp channel is connected). Keep the
        // decision and record why nothing was sent, so it can be retried after
        // the channel is fixed instead of silently cancelling the approval.
        await db.supplierQuote.update({
          where: { id: quote.id },
          data: { lastError: sendResult.detail.slice(0, 500) },
        });
      }
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

  // ---- SUPPLIER_REMINDER --------------------------------------------------
  // A reminder is an external supplier message. It is queued for sending only
  // after a human approves this exact reminder round; the scheduler itself only
  // creates the pending approval.
  if (approval.type === "SUPPLIER_REMINDER") {
    const quote = await db.supplierQuote.findUnique({
      where: { id: approval.entityId },
      include: { supplier: true },
    });
    if (!quote) return { ok: false, error: "The supplier request no longer exists." };
    const round = Number(parseJson<{ round?: number }>(approval.payloadJson, {}).round ?? 0);

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
        type: JOB_TYPES.SUPPLIER_REMINDER,
        payload: { supplierQuoteId: quote.id, round },
        idempotencyKey: `supplier-reminder:${quote.id}:${round}`,
        maxAttempts: 3,
      });
    }

    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: `supplier_reminder.${input.decision.toLowerCase()}`,
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: { approvalId: approval.id, round, reason: input.reason ?? null },
    });
    return {
      ok: true,
      redirectTo: quote.enquiryItemId ? `/sourcing/${quote.enquiryItemId}` : "/approvals",
    };
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
