import { db } from "../db";
import { parseJson } from "../json";
import { dec, money, qty } from "./money";
import { recordSupplierAcknowledgement } from "./purchaseOrders";
import { extractCorrelationToken, extractCorrelationTokens } from "./tokens";
import type { SupplierQuotedItem } from "../ai/supplierExtraction";

/**
 * Supplier purchase-order reply correlation.
 *
 * A reply is attached to a purchase order only when a strong identifier matches
 * exactly one outstanding PO: the provider thread, a message-id header, the
 * opaque PO token embedded in the sent document, or the PO number in the
 * subject. A known supplier's address alone is weak evidence and requires the
 * owner to choose.
 *
 * Reading a reply never changes the approved PO. It records what the supplier
 * said as a PENDING acknowledgement with its evidence; revised prices are
 * applied only through the existing owner review.
 */

export type PurchaseOrderCandidate = {
  purchaseOrderId: string;
  poNumber: string;
  supplierId: string;
  supplierEmail: string | null;
  sentTo: string | null;
  status: string;
  correlationToken: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  sentAt: number | null;
};

export type PurchaseOrderCorrelationInput = {
  fromAddress: string;
  subject?: string | null;
  bodyText?: string | null;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
};

export type PurchaseOrderCorrelation = {
  status: "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED";
  purchaseOrderId: string | null;
  confidence: number;
  method: string;
  possible: Array<{ purchaseOrderId: string; confidence: number; method: string }>;
  reasons: string[];
};

export function extractPurchaseOrderToken(text: string | null | undefined): string | null {
  return extractCorrelationToken("PO", text);
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

export function correlatePurchaseOrderReply(
  input: PurchaseOrderCorrelationInput,
  candidates: PurchaseOrderCandidate[],
): PurchaseOrderCorrelation {
  const combined = `${input.subject ?? ""}\n${input.bodyText ?? ""}`;
  const tokens = extractCorrelationTokens("PO", combined);
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
      method = "po_token";
    } else if (
      candidate.poNumber &&
      new RegExp(`\\b${candidate.poNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(combined)
    ) {
      score = 90;
      method = "po_number";
    } else if (sameAddress(input.fromAddress, candidate.supplierEmail) || sameAddress(input.fromAddress, candidate.sentTo)) {
      score = 55;
      method = "sender";
    }

    return { purchaseOrderId: candidate.purchaseOrderId, score, method };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score === 0) {
    return {
      status: "UNMATCHED",
      purchaseOrderId: null,
      confidence: 0,
      method: "none",
      possible: [],
      reasons: ["No purchase-order identifier matched this email."],
    };
  }

  const tied = scored.filter((entry) => entry.score >= top.score - 5 && entry.score >= 70);
  if (top.score >= 90 && tied.length === 1) {
    return {
      status: "MATCHED",
      purchaseOrderId: top.purchaseOrderId,
      confidence: top.score / 100,
      method: top.method,
      possible: [],
      reasons: [`Matched by ${top.method.replaceAll("_", " ")}.`],
    };
  }
  return {
    status: "NEEDS_REVIEW",
    purchaseOrderId: null,
    confidence: top.score / 100,
    method: top.method,
    possible: scored.filter((entry) => entry.score > 0).map((entry) => ({
      purchaseOrderId: entry.purchaseOrderId,
      confidence: entry.score / 100,
      method: entry.method,
    })),
    reasons:
      top.score >= 90
        ? ["More than one purchase order matched equally strongly; the owner must choose."]
        : ["Only the supplier address matched; the owner must confirm the purchase order."],
  };
}

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

function words(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

/** Matches an extracted line to a PO line without ever crossing products. */
function matchPurchaseOrderLine<T extends { id: string; description: string }>(
  description: string,
  lines: T[],
): T | null {
  const target = normalize(description);
  if (!target) return null;
  const exact = lines.find((line) => normalize(line.description) === target);
  if (exact) return exact;
  const contained = lines.filter((line) => {
    const candidate = normalize(line.description);
    return candidate.includes(target) || target.includes(candidate);
  });
  if (contained.length === 1) return contained[0];
  const targetWords = new Set(words(description));
  let best: { line: T; score: number } | null = null;
  for (const line of lines) {
    const overlap = words(line.description).filter((word) => targetWords.has(word)).length;
    if (overlap < 2) continue;
    if (!best || overlap > best.score) best = { line, score: overlap };
  }
  return best?.line ?? null;
}

export type AcknowledgementLineDraft = {
  purchaseOrderLineId: string;
  description: string;
  orderedQuantity: number;
  acknowledgedQuantity: number;
  revisedUnitPrice: number | null;
  promisedDate: string | null;
};

export type AcknowledgementDerivation = {
  outcome: "ACKNOWLEDGED" | "PARTIALLY_ACKNOWLEDGED" | "REJECTED" | "REVISED";
  lines: AcknowledgementLineDraft[];
  deviations: Array<{ code: string; detail: string }>;
  promisedDate: Date | null;
  method: "AI_LINES" | "DETERMINISTIC_DEFAULT";
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

const REJECTION_PATTERN =
  /\b(?:cannot|can't|unable to)\s+(?:supply|fulfil|fulfill|accept|process|provide|deliver)\b|\b(?:reject|decline|cancel)(?:ed|ing)?\s+(?:the\s+|this\s+)?(?:order|po|purchase\s+order)\b|\b(?:order|po)\s+(?:is\s+)?(?:rejected|declined|cancelled)\b/i;

/**
 * Derives the supplier's commitment from the AI-read lines. Missing quantities
 * default to the ordered quantity because the email is an acknowledgement; a
 * changed price or a reduced quantity is recorded as a deviation for review.
 */
export function deriveAcknowledgement(input: {
  lines: Array<{ id: string; description: string; quantity: number; unitPrice: number; unit: string }>;
  quotedItems?: SupplierQuotedItem[];
  body: string;
  receivedAt: Date;
  expectedDeliveryDate?: Date | null;
}): AcknowledgementDerivation {
  const deviations: Array<{ code: string; detail: string }> = [];
  const drafts: AcknowledgementLineDraft[] = [];
  const promisedDates: Date[] = [];
  let anyPartial = false;
  let anyRevised = false;
  let matchedItems = 0;

  if (REJECTION_PATTERN.test(input.body)) {
    return {
      outcome: "REJECTED",
      lines: input.lines.map((line) => ({
        purchaseOrderLineId: line.id,
        description: line.description,
        orderedQuantity: Number(qty(line.quantity)),
        acknowledgedQuantity: 0,
        revisedUnitPrice: null,
        promisedDate: null,
      })),
      deviations: [{ code: "SUPPLIER_REJECTED", detail: "The supplier rejected the purchase order." }],
      promisedDate: null,
      method: "AI_LINES",
      confidence: "MEDIUM",
    };
  }

  const claimed = new Set<string>();
  for (const item of input.quotedItems ?? []) {
    if (!item.description) continue;
    const poLine = matchPurchaseOrderLine(item.description, input.lines.filter((line) => !claimed.has(line.id)));
    if (!poLine) continue;
    claimed.add(poLine.id);
    matchedItems += 1;

    const ordered = qty(poLine.quantity);
    const stated = item.quantity == null ? ordered : qty(item.quantity);
    const acknowledged = stated.gt(ordered) ? ordered : stated;
    if (stated.gt(ordered)) {
      deviations.push({
        code: "EXCESS_QUANTITY",
        detail: `${poLine.description}: supplier offered ${stated.toFixed(4)} ${poLine.unit} against an ordered ${ordered.toFixed(4)}.`,
      });
    }
    if (acknowledged.lt(ordered)) {
      anyPartial = true;
      deviations.push({
        code: "PARTIAL_QUANTITY",
        detail: `${poLine.description}: supplier acknowledged ${acknowledged.toFixed(4)} of ${ordered.toFixed(4)} ${poLine.unit}.`,
      });
    }

    const revised =
      item.unit_price == null ? null : money(item.unit_price);
    if (revised && !revised.equals(dec(poLine.unitPrice))) {
      anyRevised = true;
      deviations.push({
        code: "REVISED_PRICE",
        detail: `${poLine.description}: supplier proposes ${revised.toFixed(2)} instead of ${money(poLine.unitPrice).toFixed(2)}.`,
      });
    }

    let promisedDate: Date | null = null;
    if (item.lead_time_days != null && Number.isFinite(item.lead_time_days) && item.lead_time_days >= 0) {
      promisedDate = new Date(input.receivedAt.getTime() + Number(item.lead_time_days) * 24 * 60 * 60 * 1000);
      promisedDates.push(promisedDate);
    }

    drafts.push({
      purchaseOrderLineId: poLine.id,
      description: poLine.description,
      orderedQuantity: Number(ordered),
      acknowledgedQuantity: Number(acknowledged),
      revisedUnitPrice: revised && !revised.equals(dec(poLine.unitPrice)) ? Number(revised) : null,
      promisedDate: promisedDate?.toISOString() ?? null,
    });
  }

  // Lines the supplier did not itemise are still part of the acknowledgement.
  // They keep the ordered quantity so nothing is silently reduced; the review
  // screen shows exactly which lines had explicit evidence.
  for (const line of input.lines) {
    if (claimed.has(line.id)) continue;
    drafts.push({
      purchaseOrderLineId: line.id,
      description: line.description,
      orderedQuantity: Number(qty(line.quantity)),
      acknowledgedQuantity: Number(qty(line.quantity)),
      revisedUnitPrice: null,
      promisedDate: null,
    });
  }

  const promisedDate = promisedDates.length
    ? new Date(Math.max(...promisedDates.map((date) => date.getTime())))
    : null;
  if (promisedDate && input.expectedDeliveryDate && promisedDate.getTime() > input.expectedDeliveryDate.getTime()) {
    deviations.push({
      code: "LATE_DELIVERY",
      detail: `Supplier promises ${promisedDate.toISOString().slice(0, 10)}, after the required ${input.expectedDeliveryDate
        .toISOString()
        .slice(0, 10)}.`,
    });
  }

  const outcome: AcknowledgementDerivation["outcome"] = anyRevised
    ? "REVISED"
    : anyPartial
      ? "PARTIALLY_ACKNOWLEDGED"
      : "ACKNOWLEDGED";

  return {
    outcome,
    lines: drafts.sort(
      (a, b) =>
        input.lines.findIndex((line) => line.id === a.purchaseOrderLineId) -
        input.lines.findIndex((line) => line.id === b.purchaseOrderLineId),
    ),
    deviations,
    promisedDate,
    method: matchedItems > 0 ? "AI_LINES" : "DETERMINISTIC_DEFAULT",
    confidence: matchedItems > 0 ? "HIGH" : "LOW",
  };
}

export type PurchaseOrderReplyResult =
  | {
      ok: true;
      acknowledgementId: string;
      outcome: string;
      deviations: Array<{ code: string; detail: string }>;
      duplicate: boolean;
    }
  | { ok: false; error: string };

/**
 * Records a supplier reply against one purchase order. Idempotent on the
 * inbound reply id, so a repeated mailbox sync cannot create a second
 * acknowledgement or a second review notification.
 */
export async function ingestPurchaseOrderAcknowledgement(input: {
  supplierReplyId: string;
  purchaseOrderId: string;
  body: string;
  receivedAt: Date;
  quotedItems?: SupplierQuotedItem[];
}): Promise<PurchaseOrderReplyResult> {
  const existing = await db.supplierAcknowledgement.findFirst({
    where: { supplierReplyId: input.supplierReplyId },
    select: { id: true, outcome: true, deviationsJson: true },
  });
  if (existing) {
    return {
      ok: true,
      acknowledgementId: existing.id,
      outcome: existing.outcome,
      deviations: parseJson<Array<{ code: string; detail: string }>>(existing.deviationsJson, []),
      duplicate: true,
    };
  }

  const po = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!po) return { ok: false, error: "Purchase order not found." };
  if (!["SENT", "ACKNOWLEDGED", "PARTIALLY_ACKNOWLEDGED", "REVISED", "ACKNOWLEDGEMENT_RECEIVED"].includes(po.status)) {
    return { ok: false, error: "A supplier reply can only be recorded after the purchase order was sent." };
  }

  const derived = deriveAcknowledgement({
    lines: po.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      unit: line.unit,
    })),
    quotedItems: input.quotedItems,
    body: input.body,
    receivedAt: input.receivedAt,
    expectedDeliveryDate: po.expectedDeliveryDate,
  });

  const recorded = await recordSupplierAcknowledgement({
    purchaseOrderId: po.id,
    outcome: derived.outcome,
    lines: derived.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      acknowledgedQuantity: line.acknowledgedQuantity,
      revisedUnitPrice: line.revisedUnitPrice,
      promisedDate: line.promisedDate,
    })),
    promisedDate: derived.promisedDate?.toISOString() ?? null,
    notes: `Read automatically from the supplier's email (${derived.method.toLowerCase().replaceAll("_", " ")}).`,
    evidence: {
      source: "EMAIL",
      supplierReplyId: input.supplierReplyId,
      method: derived.method,
      confidence: derived.confidence,
      bodyExcerpt: input.body.slice(0, 2000),
      deviations: derived.deviations,
    },
    source: "EMAIL",
    supplierReplyId: input.supplierReplyId,
    userId: null,
    actorLabel: "system",
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };

  await db.supplierEmailReply.updateMany({
    where: { id: input.supplierReplyId },
    data: { purchaseOrderId: po.id },
  });

  return {
    ok: true,
    acknowledgementId: recorded.acknowledgementId,
    outcome: derived.outcome,
    deviations: recorded.deviations,
    duplicate: false,
  };
}
