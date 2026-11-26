import { db } from "../db";
import { notifyOwner, writeAudit } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { requireTenantId } from "../tenant";
import { processDocumentPackage } from "../intake/documentPackage";
import { assertAllowedUpload, saveAttachmentForOrganization, storageReadiness } from "../storage";
import { extractCustomerPurchaseOrder, type CustomerPurchaseOrder } from "../ai/customerPo";
import {
  previewCustomerAcceptance,
  type AcceptanceDiscrepancy,
  type AcceptanceLineInput,
  type CustomerAcceptanceInput,
} from "./salesOrder";
import { extractCorrelationToken, extractCorrelationTokens } from "./tokens";

/**
 * Customer acceptance intake.
 *
 * A reply or purchase order is attached to a quotation only when a strong
 * identifier matches exactly one outstanding quotation version: the provider
 * thread, a message-id header, the opaque QTN token embedded in the sent
 * quotation, or the quotation number in the subject. Sender identity alone
 * never creates a review, because a customer can reply to an unrelated thread.
 *
 * Extraction is evidence. It never creates a sales order and never accepts a
 * changed price, quantity, specification, tax or delivery term. The owner
 * reviews the recorded differences and records an explicit decision.
 */

export type AcceptanceCandidate = {
  quotationId: string;
  quoteNumber: string;
  version: number;
  customerEmail: string | null;
  sentTo: string | null;
  status: string;
  correlationToken: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  sentAt: number | null;
};

export type AcceptanceCorrelationInput = {
  fromAddress: string;
  subject?: string | null;
  bodyText?: string | null;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
};

export type AcceptanceCorrelation = {
  status: "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED";
  quotationId: string | null;
  confidence: number;
  method: string;
  possible: Array<{ quotationId: string; confidence: number; method: string }>;
  reasons: string[];
};

export function extractQuotationToken(text: string | null | undefined): string | null {
  return extractCorrelationToken("QTN", text);
}

function headerIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,<>]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 3);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Ranks each open quotation by the strongest available evidence. Auto-match
 * requires a strong identifier (>= 90) that is unique to one quotation.
 */
export function correlateCustomerReply(
  input: AcceptanceCorrelationInput,
  candidates: AcceptanceCandidate[],
): AcceptanceCorrelation {
  const combined = `${input.subject ?? ""}\n${input.bodyText ?? ""}`;
  const tokens = extractCorrelationTokens("QTN", combined);
  const references = [...headerIds(input.references), ...headerIds(input.inReplyTo)];

  const scored = candidates.map((candidate) => {
    let score = 0;
    let method = "none";

    if (candidate.providerThreadId && input.providerThreadId && candidate.providerThreadId === input.providerThreadId) {
      score = 100;
      method = "provider_thread";
    } else if (
      candidate.providerMessageId &&
      references.some((reference) => reference.includes(candidate.providerMessageId!) || candidate.providerMessageId!.includes(reference))
    ) {
      score = 100;
      method = "message_id_header";
    } else if (
      candidate.correlationToken &&
      tokens.includes(candidate.correlationToken.toUpperCase())
    ) {
      score = 95;
      method = "quotation_token";
    } else if (
      candidate.quoteNumber &&
      new RegExp(`\\b${candidate.quoteNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(combined)
    ) {
      score = 90;
      method = "quotation_number";
    } else if (sameAddress(input.fromAddress, candidate.customerEmail) || sameAddress(input.fromAddress, candidate.sentTo)) {
      score = 55;
      method = "sender";
    }

    return { quotationId: candidate.quotationId, score, method };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score === 0) {
    return {
      status: "UNMATCHED",
      quotationId: null,
      confidence: 0,
      method: "none",
      possible: [],
      reasons: ["No quotation identifier matched this email."],
    };
  }

  const tied = scored.filter((entry) => entry.score >= top.score - 5 && entry.score >= 70);
  if (top.score >= 90 && tied.length === 1) {
    return {
      status: "MATCHED",
      quotationId: top.quotationId,
      confidence: top.score / 100,
      method: top.method,
      possible: [],
      reasons: [`Matched by ${top.method.replaceAll("_", " ")}.`],
    };
  }
  return {
    status: "NEEDS_REVIEW",
    quotationId: null,
    confidence: top.score / 100,
    method: top.method,
    possible: scored.filter((entry) => entry.score > 0).map((entry) => ({
      quotationId: entry.quotationId,
      confidence: entry.score / 100,
      method: entry.method,
    })),
    reasons:
      top.score >= 90
        ? ["More than one quotation matched equally strongly; the owner must choose."]
        : ["Only weak evidence matched (sender or similar reference); the owner must confirm."],
  };
}

export type AcceptanceExtraction =
  | { status: "OK"; data: CustomerPurchaseOrder; usage?: { inputTokens: number; outputTokens: number; model: string } }
  | { status: "NOT_CONFIGURED" | "BUDGET_BLOCKED" | "FAILED"; error: string };

export type ExtractedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
};

/**
 * Converts a purchase-order reading into the acceptance input understood by the
 * quotation comparison. Only values the document actually stated are supplied;
 * a missing quantity or price stays absent and is compared against the quoted
 * value rather than being treated as zero.
 */
export function acceptanceInputFromPurchaseOrder(input: {
  quotationId: string;
  quotationItems: Array<{ id: string; description: string; unit: string; quantity: number; unitPrice: number | null }>;
  extraction: CustomerPurchaseOrder;
  evidence?: Record<string, unknown>;
}): CustomerAcceptanceInput {
  const refToId = new Map<string, string>();
  input.quotationItems.forEach((item, index) => refToId.set(`QT-ITEM-${index + 1}`, item.id));

  const lines: AcceptanceLineInput[] = input.extraction.lines.map((line) => {
    const matchedId = line.quoted_item_ref ? (refToId.get(line.quoted_item_ref.toUpperCase()) ?? null) : null;
    return {
      quotationItemId: matchedId,
      // A line matched by ref is identified by that ref. Its wording may be a
      // paraphrase, so only the stated technical specification is compared.
      description: matchedId ? null : line.description,
      specs: line.specifications,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unit_price,
      discountPct: line.discount_pct,
      taxRatePct: line.tax_rate_pct,
    };
  });

  return {
    quotationId: input.quotationId,
    customerPoNumber: input.extraction.po_number,
    customerPoReference: input.extraction.po_date,
    currency: input.extraction.currency,
    paymentTerms: input.extraction.payment_terms,
    deliveryTerms: input.extraction.delivery_terms,
    deliveryAddress: input.extraction.delivery_address,
    deliveryDate: input.extraction.requested_delivery_date,
    conditions: input.extraction.conditions,
    taxAmount: input.extraction.tax_amount,
    taxRatePct: input.extraction.tax_rate_pct,
    lines,
    source: "CUSTOMER_PO",
    evidence: {
      ...(input.evidence ?? {}),
      poNumber: input.extraction.po_number,
      confidence: input.extraction.confidence,
      notes: input.extraction.notes,
    },
  };
}

export type AcceptanceReviewRecord = {
  id: string;
  quotationId: string;
  quotationVersion: number;
  status: string;
  customerPoNumber: string | null;
  extractionJson: string;
  comparisonJson: string;
  attachmentsJson: string;
  subject: string | null;
  fromAddress: string | null;
  receivedAt: Date;
  salesOrderId: string | null;
};

export type RecordAcceptanceResult =
  | { ok: true; reviewId: string; duplicate: boolean; blocking: number; warnings: number; isPurchaseOrder: boolean }
  | { ok: false; error: string };

/**
 * Stores one acceptance review. Idempotent on the provider message id so a
 * mailbox replay cannot create a second review or a second order.
 */
export async function recordCustomerAcceptanceReview(input: {
  quotationId: string;
  extraction: AcceptanceExtraction;
  externalMessageId?: string | null;
  provider?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  bodySummary?: string | null;
  attachments?: ExtractedAttachment[];
  evidence?: Record<string, unknown>;
  receivedAt?: Date;
  reviewId?: string | null;
}): Promise<RecordAcceptanceResult> {
  const quotation = await db.customerQuotation.findUnique({
    where: { id: input.quotationId },
    include: { items: { orderBy: { id: "asc" } } },
  });
  if (!quotation) return { ok: false, error: "Quotation not found." };
  if (!["APPROVED", "SENT"].includes(quotation.status)) {
    return { ok: false, error: "Only an approved or sent quotation can be accepted." };
  }

  if (input.externalMessageId) {
    const existing = await db.customerAcceptanceReview.findFirst({
      where: { externalMessageId: input.externalMessageId },
      select: { id: true, status: true },
    });
    if (existing && existing.id !== input.reviewId) {
      return { ok: true, reviewId: existing.id, duplicate: true, blocking: 0, warnings: 0, isPurchaseOrder: false };
    }
  }

  const purchaseOrderData = input.extraction.status === "OK" ? input.extraction.data : null;
  const isPurchaseOrder = purchaseOrderData?.is_purchase_order === true;
  let comparison: { discrepancies: AcceptanceDiscrepancy[]; blocking: AcceptanceDiscrepancy[]; warnings: AcceptanceDiscrepancy[] } = {
    discrepancies: [],
    blocking: [],
    warnings: [],
  };

  if (isPurchaseOrder && purchaseOrderData) {
    const acceptance = acceptanceInputFromPurchaseOrder({
      quotationId: quotation.id,
      quotationItems: quotation.items.map((item) => ({
        id: item.id,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      extraction: purchaseOrderData,
      evidence: { ...(input.evidence ?? {}), provider: input.provider ?? null, externalMessageId: input.externalMessageId ?? null },
    });
    const preview = await previewCustomerAcceptance(acceptance);
    if (preview.ok) {
      comparison = {
        discrepancies: preview.discrepancies,
        blocking: preview.blocking,
        warnings: preview.warnings,
      };
    }
  }

  const extractionJson = stringifyJson({
    status: input.extraction.status,
    error: input.extraction.status === "OK" ? null : input.extraction.error,
    isPurchaseOrder,
    purchaseOrder: input.extraction.status === "OK" ? input.extraction.data : null,
  });
  const comparisonJson = stringifyJson({
    quotationId: quotation.id,
    quoteNumber: quotation.quoteNumber,
    quotationVersion: quotation.version,
    quotationCurrency: quotation.currency,
    isPurchaseOrder,
    blocking: comparison.blocking,
    warnings: comparison.warnings,
    discrepancies: comparison.discrepancies,
  });
  const attachmentsJson = stringifyJson(
    (input.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    })),
  );

  let reviewId = input.reviewId ?? null;
  if (reviewId) {
    await db.customerAcceptanceReview.updateMany({
      where: { id: reviewId, status: "PENDING" },
      data: {
        extractionJson,
        comparisonJson,
        attachmentsJson,
        customerPoNumber: purchaseOrderData?.po_number ?? null,
      },
    });
  } else {
    const created = await db.customerAcceptanceReview
      .create({
        data: {
          quotationId: quotation.id,
          quotationVersion: quotation.version,
          customerId: quotation.customerId,
          source: "EMAIL",
          provider: input.provider ?? null,
          externalMessageId: input.externalMessageId ?? null,
          fromAddress: input.fromAddress ?? null,
          subject: input.subject?.slice(0, 300) ?? null,
          bodySummary: input.bodySummary?.slice(0, 6000) ?? null,
          attachmentsJson,
          extractionJson,
          comparisonJson,
          customerPoNumber: purchaseOrderData?.po_number ?? null,
          receivedAt: input.receivedAt ?? new Date(),
        },
        select: { id: true },
      })
      .catch(async (error: unknown) => {
        if ((error as { code?: string } | null)?.code === "P2002" && input.externalMessageId) {
          const raced = await db.customerAcceptanceReview.findFirst({
            where: { externalMessageId: input.externalMessageId },
            select: { id: true },
          });
          if (raced) return raced;
        }
        throw error;
      });
    reviewId = created.id;
  }

  if ((input.attachments?.length ?? 0) > 0) {
    await db.attachment.updateMany({
      where: { id: { in: (input.attachments ?? []).map((attachment) => attachment.id) } },
      data: { acceptanceReviewId: reviewId },
    });
  }

  await writeAudit({
    action: "customer_acceptance.recorded",
    entityType: "CustomerAcceptanceReview",
    entityId: reviewId,
    actorLabel: "system",
    meta: {
      quotationId: quotation.id,
      quotationVersion: quotation.version,
      provider: input.provider ?? null,
      externalMessageId: input.externalMessageId ?? null,
      extractionStatus: input.extraction.status,
      isPurchaseOrder,
      blocking: comparison.blocking.length,
      warnings: comparison.warnings.length,
    },
  });

  if (isPurchaseOrder) {
    await notifyOwner({
      type: "CUSTOMER_ACCEPTANCE",
      title: comparison.blocking.length > 0 ? "Customer PO differs from the quotation" : "Customer accepted the quotation",
      body:
        comparison.blocking.length > 0
          ? `${quotation.quoteNumber}: ${comparison.blocking.length} changed term(s) need your decision. No order has been created.`
          : `${quotation.quoteNumber}: the customer's document matches the sent quotation. Review and confirm the sales order.`,
      link: `/orders/acceptance/${reviewId}`,
    });
  }

  return {
    ok: true,
    reviewId: reviewId as string,
    duplicate: false,
    blocking: comparison.blocking.length,
    warnings: comparison.warnings.length,
    isPurchaseOrder,
  };
}

export type IngestAcceptanceResult =
  | { handled: false; reason: string }
  | { handled: true; reviewId: string; duplicate: boolean; quotationId: string | null; blocking: number; warnings: number };

/**
 * Reads a customer email (and its attachments) and records an acceptance review
 * when a strong quotation identifier matches. Returns handled:false so ordinary
 * customer intake continues unchanged when no strong correlation exists.
 */
export async function ingestCustomerAcceptanceReply(input: {
  provider: "GMAIL" | "MICROSOFT365";
  externalMessageId: string;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  from: string;
  fromName?: string | null;
  subject?: string | null;
  body: string;
  receivedAt?: Date;
  attachments?: Array<{ filename: string; buffer: Buffer }>;
}): Promise<IngestAcceptanceResult> {
  const from = input.from.trim().toLowerCase();
  if (!from) return { handled: false, reason: "No sender address." };

  const tokens = extractCorrelationTokens("QTN", `${input.subject ?? ""}\n${input.body}`);
  const candidates = await db.customerQuotation.findMany({
    where: {
      status: { in: ["APPROVED", "SENT"] },
      sentAt: { not: null },
      ...(tokens.length > 0
        ? {
            OR: [
              { correlationToken: { in: tokens } },
              { customerEmail: { equals: from, mode: "insensitive" } },
            ],
          }
        : { customerEmail: { equals: from, mode: "insensitive" } }),
    },
    orderBy: { sentAt: "desc" },
    take: 40,
    select: {
      id: true,
      quoteNumber: true,
      version: true,
      customerEmail: true,
      sentTo: true,
      status: true,
      correlationToken: true,
      providerThreadId: true,
      providerMessageId: true,
      sentAt: true,
    },
  });
  if (candidates.length === 0) {
    return { handled: false, reason: "No open customer quotation matched this sender." };
  }

  const correlation = correlateCustomerReply(
    {
      fromAddress: from,
      subject: input.subject,
      bodyText: input.body,
      providerThreadId: input.providerThreadId,
      internetMessageId: input.internetMessageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
    },
    candidates.map((candidate) => ({
      quotationId: candidate.id,
      quoteNumber: candidate.quoteNumber,
      version: candidate.version,
      customerEmail: candidate.customerEmail,
      sentTo: candidate.sentTo,
      status: candidate.status,
      correlationToken: candidate.correlationToken,
      providerThreadId: candidate.providerThreadId,
      providerMessageId: candidate.providerMessageId,
      sentAt: candidate.sentAt?.getTime() ?? null,
    })),
  );

  if (correlation.status !== "MATCHED" || !correlation.quotationId) {
    return { handled: false, reason: correlation.reasons[0] ?? "No strong quotation identifier." };
  }

  const quotation = await db.customerQuotation.findUnique({
    where: { id: correlation.quotationId },
    include: { items: { orderBy: { id: "asc" } } },
  });
  if (!quotation) return { handled: false, reason: "Quotation disappeared before review." };

  const existing = await db.customerAcceptanceReview.findFirst({
    where: { externalMessageId: input.externalMessageId },
    select: { id: true },
  });
  if (existing) {
    return { handled: true, reviewId: existing.id, duplicate: true, quotationId: quotation.id, blocking: 0, warnings: 0 };
  }

  // Create the review first so the original email and its files have a durable
  // parent even if document processing later fails.
  const organizationId = await requireTenantId();
  const review = await db.customerAcceptanceReview.create({
    data: {
      quotationId: quotation.id,
      quotationVersion: quotation.version,
      customerId: quotation.customerId,
      source: "EMAIL",
      provider: input.provider,
      externalMessageId: input.externalMessageId,
      fromAddress: from,
      subject: input.subject?.slice(0, 300) ?? null,
      bodySummary: input.body.slice(0, 6000),
      extractionJson: stringifyJson({ status: "PENDING" }),
      comparisonJson: stringifyJson({ status: "PENDING" }),
      receivedAt: input.receivedAt ?? new Date(),
    },
    select: { id: true },
  });

  const stored: ExtractedAttachment[] = [];
  const failures: string[] = [];
  const readiness = storageReadiness();
  if ((input.attachments?.length ?? 0) > 0) {
    if (!readiness.ok) {
      failures.push(readiness.detail);
    } else {
      for (const file of input.attachments ?? []) {
        const check = assertAllowedUpload(file.buffer, file.filename, { allowUnsupported: true });
        if (!check.ok) {
          failures.push(`${file.filename}: ${check.error}`);
          continue;
        }
        try {
          const saved = await saveAttachmentForOrganization(file.buffer, check.filename, organizationId);
          const attachment = await db.attachment.create({
            data: {
              acceptanceReviewId: review.id,
              filename: check.filename,
              storedName: saved.storedName,
              mimeType: check.mime,
              detectedMime: check.mime,
              sizeBytes: saved.sizeBytes,
              sha256: saved.sha256,
              storagePath: saved.storagePath,
            },
          });
          stored.push({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
            storagePath: saved.storagePath,
          });
        } catch (error) {
          failures.push(`${file.filename}: ${error instanceof Error ? error.message.slice(0, 160) : "could not be stored"}`);
        }
      }
    }
  }

  let documents: Array<{ filename: string; text: string; pageCount?: number | null; status?: string | null; images?: string[] }> = [];
  if (stored.length > 0) {
    try {
      const packageResult = await processDocumentPackage({
        key: `customer-acceptance:${review.id}`,
        attachments: stored.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          storagePath: attachment.storagePath,
          sha256: attachment.sha256,
        })),
      });
      documents = packageResult.documents.map((entry) => ({
        filename: entry.filename,
        text: entry.analysis.text,
        status: entry.analysis.status,
        pageCount: entry.analysis.pageCount,
        images: entry.analysis.images,
      }));
      failures.push(
        ...packageResult.summary.failures.map((failure) => `${failure.filename}: ${failure.reason}`),
        ...packageResult.summary.unsupported.map((failure) => `${failure.filename}: ${failure.reason}`),
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message.slice(0, 200) : "Document processing failed.");
    }
  }

  const extraction = await extractCustomerPurchaseOrder({
    subject: input.subject,
    body: input.body,
    fromName: input.fromName,
    fromAddress: from,
    documents,
    quotationNumber: quotation.quoteNumber,
    quotationCurrency: quotation.currency,
    quotationItems: quotation.items.map((item, index) => ({
      ref: `QT-ITEM-${index + 1}`,
      description: item.description,
      specs: item.specs,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
    })),
  });

  const recorded = await recordCustomerAcceptanceReview({
    quotationId: quotation.id,
    extraction,
    externalMessageId: input.externalMessageId,
    provider: input.provider,
    fromAddress: from,
    subject: input.subject,
    bodySummary: input.body,
    attachments: stored,
    evidence: {
      providerThreadId: input.providerThreadId ?? null,
      internetMessageId: input.internetMessageId ?? null,
      correlation: { method: correlation.method, confidence: correlation.confidence },
      attachmentFailures: failures,
    },
    receivedAt: input.receivedAt,
    reviewId: review.id,
  });

  if (!recorded.ok) {
    return { handled: false, reason: recorded.error };
  }
  return {
    handled: true,
    reviewId: recorded.reviewId,
    duplicate: recorded.duplicate,
    quotationId: quotation.id,
    blocking: recorded.blocking,
    warnings: recorded.warnings,
  };
}

/** Pending reviews with the comparison summary needed by the owner screen. */
export async function pendingAcceptanceReviews() {
  return db.customerAcceptanceReview.findMany({
    where: { status: "PENDING" },
    orderBy: { receivedAt: "desc" },
    take: 50,
    include: {
      quotation: {
        select: {
          id: true,
          quoteNumber: true,
          version: true,
          currency: true,
          total: true,
          customerName: true,
        },
      },
    },
  });
}

export async function acceptanceReviewById(reviewId: string) {
  return db.customerAcceptanceReview.findUnique({
    where: { id: reviewId },
    include: {
      quotation: { include: { items: { orderBy: { id: "asc" } }, customer: true } },
      attachments: { orderBy: { createdAt: "asc" } },
      salesOrder: { select: { id: true, orderNumber: true, status: true } },
    },
  });
}

/** Parsed comparison attached to a review, for rendering. */
export function reviewComparison(review: { comparisonJson: string }): {
  blocking: AcceptanceDiscrepancy[];
  warnings: AcceptanceDiscrepancy[];
  discrepancies: AcceptanceDiscrepancy[];
  isPurchaseOrder: boolean;
} {
  const parsed = parseJson<{
    blocking?: AcceptanceDiscrepancy[];
    warnings?: AcceptanceDiscrepancy[];
    discrepancies?: AcceptanceDiscrepancy[];
    isPurchaseOrder?: boolean;
  }>(review.comparisonJson, {});
  return {
    blocking: parsed.blocking ?? [],
    warnings: parsed.warnings ?? [],
    discrepancies: parsed.discrepancies ?? [],
    isPurchaseOrder: parsed.isPurchaseOrder ?? false,
  };
}

export function reviewPurchaseOrder(review: { extractionJson: string }): CustomerPurchaseOrder | null {
  const parsed = parseJson<{ purchaseOrder?: CustomerPurchaseOrder | null }>(review.extractionJson, {});
  return parsed.purchaseOrder ?? null;
}

/**
 * Converts a reviewed acceptance into a sales order using the stored extraction.
 * The owner's decision is recorded with the order; the quotation is never
 * modified. Repeated conversion is idempotent through the quotation-version key.
 */
export async function convertAcceptanceReview(input: {
  reviewId: string;
  decision: "ACCEPT_ORIGINAL" | "APPROVE_REVISED" | "REJECT";
  reason?: string | null;
  userId: string;
  actorLabel: string;
}): Promise<
  | { ok: true; salesOrderId: string; orderNumber: string; duplicate: boolean }
  | { ok: false; error: string; blocking?: AcceptanceDiscrepancy[] }
> {
  const review = await acceptanceReviewById(input.reviewId);
  if (!review) return { ok: false, error: "Customer acceptance review not found." };
  if (review.status === "CONVERTED" && review.salesOrderId) {
    return { ok: true, salesOrderId: review.salesOrderId, orderNumber: review.salesOrder?.orderNumber ?? "", duplicate: true };
  }
  if (review.status !== "PENDING") return { ok: false, error: "This acceptance was already reviewed." };

  const comparison = reviewComparison(review);
  if (input.decision === "REJECT") {
    const applied = await db.customerAcceptanceReview.updateMany({
      where: { id: review.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        reviewedById: input.userId,
        reviewedAt: new Date(),
        reviewNote: input.reason?.trim() || "Customer document rejected by the owner.",
      },
    });
    if (applied.count === 0) return { ok: false, error: "This acceptance was already reviewed." };
    await writeAudit({
      actorId: input.userId,
      actorLabel: input.actorLabel,
      action: "customer_acceptance.rejected",
      entityType: "CustomerAcceptanceReview",
      entityId: review.id,
      meta: { quotationId: review.quotationId, reason: input.reason ?? null },
    });
    return { ok: false, error: "The customer document was rejected; no sales order was created." };
  }

  const extraction = reviewPurchaseOrder(review);
  if (!extraction || !comparison.isPurchaseOrder) {
    return {
      ok: false,
      error: "The customer document could not be read as a purchase order. Use the manual acceptance form after checking it.",
    };
  }

  const acceptance = acceptanceInputFromPurchaseOrder({
    quotationId: review.quotationId,
    quotationItems: review.quotation.items.map((item) => ({
      id: item.id,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    extraction,
    evidence: {
      acceptanceReviewId: review.id,
      provider: review.provider,
      externalMessageId: review.externalMessageId,
      fromAddress: review.fromAddress,
      subject: review.subject,
      attachments: parseJson<Array<Record<string, unknown>>>(review.attachmentsJson, []),
    },
  });

  const { createSalesOrderFromAcceptance } = await import("./salesOrder");
  const result = await createSalesOrderFromAcceptance({
    ...acceptance,
    resolution: { decision: input.decision, reason: input.reason?.trim() || null },
    idempotencyKey: `acceptance-review:${review.id}`,
    userId: input.userId,
    actorLabel: input.actorLabel,
  });
  if (!result.ok) {
    return { ok: false, error: result.error, blocking: result.discrepancies };
  }

  await db.customerAcceptanceReview.updateMany({
    where: { id: review.id, status: "PENDING" },
    data: {
      status: "CONVERTED",
      reviewedById: input.userId,
      reviewedAt: new Date(),
      reviewNote: input.reason?.trim() || null,
      salesOrderId: result.salesOrderId,
    },
  });
  return { ok: true, salesOrderId: result.salesOrderId, orderNumber: result.orderNumber, duplicate: result.duplicate };
}

export async function rejectAcceptanceReview(input: {
  reviewId: string;
  reason: string;
  userId: string;
  actorLabel: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.reason.trim()) return { ok: false, error: "Record why the customer's document was rejected." };
  const applied = await db.customerAcceptanceReview.updateMany({
    where: { id: input.reviewId, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedById: input.userId,
      reviewedAt: new Date(),
      reviewNote: input.reason.trim(),
    },
  });
  if (applied.count === 0) return { ok: false, error: "This acceptance was already reviewed." };
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "customer_acceptance.rejected",
    entityType: "CustomerAcceptanceReview",
    entityId: input.reviewId,
    meta: { reason: input.reason.trim() },
  });
  return { ok: true };
}

export async function dismissAcceptanceReview(input: {
  reviewId: string;
  userId: string;
  actorLabel: string;
  reason?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const applied = await db.customerAcceptanceReview.updateMany({
    where: { id: input.reviewId, status: "PENDING" },
    data: {
      status: "DISMISSED",
      reviewedById: input.userId,
      reviewedAt: new Date(),
      reviewNote: input.reason?.trim() || "Dismissed by the owner.",
    },
  });
  if (applied.count === 0) return { ok: false, error: "This acceptance was already reviewed." };
  await writeAudit({
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "customer_acceptance.dismissed",
    entityType: "CustomerAcceptanceReview",
    entityId: input.reviewId,
    meta: { reason: input.reason ?? null },
  });
  return { ok: true };
}
