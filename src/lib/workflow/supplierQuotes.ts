import { db } from "../db";
import { matchProduct } from "../inventory/matching";
import { env, isDemoMode } from "../env";
import { writeAudit } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { outboundOperationKey, sendOutboundOnce } from "../outbound/messages";
import { sendWhatsAppText } from "../intake/whatsapp";
import { activeEmailProvider, sendEmail } from "../email/send";
import { getWhatsAppCredentials } from "../integrations/whatsapp";
import { parseFastenerSpec, parseFastenerSpecJson } from "../fasteners/spec";
import { industrialSpecFromFields, parseIndustrialSpecJson } from "../catalog/industrialSpec";
import { getCurrentOrganization } from "../organization";
import { supplierSendGuard } from "../suppliers/sendGuard";
import {
  composeSupplierRfq,
  mergeRfqFindings,
  reviewSupplierRfqWithAi,
  supplierRfqProblems,
  validateSupplierRfqDraft,
  type SupplierRfqFinding,
  type SupplierRfqItem,
} from "../outbound/supplierRfq";

function quoteLink(token: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/supplier-response/${token}`;
}

/**
 * Backwards-compatible helper. New code composes through composeSupplierRfq so
 * internal fields and specification strings are never concatenated into a
 * supplier-facing message.
 */
export function draftSupplierMessage(input: {
  supplierName: string;
  companyName: string;
  enquiryRef: string;
  items: Array<{ description: string; quantity: number; unit: string; specs?: string | null }>;
  link: string;
  correlationToken?: string | null;
}): { subject: string; body: string } {
  const draft = composeSupplierRfq({
    supplierName: input.supplierName,
    companyName: input.companyName,
    enquiryRef: input.enquiryRef,
    items: input.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
    })),
    link: input.link,
    correlationToken: input.correlationToken ?? null,
  });
  return { subject: draft.subject, body: draft.body };
}

function rfqItemFor(item: {
  description: string;
  size: string | null;
  material: string | null;
  grade: string | null;
  pressureRating: string | null;
  schedule: string | null;
  standard: string | null;
  brand: string | null;
  quantity: number;
  unit: string;
  missingFields: string;
}): SupplierRfqItem {
  return {
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    size: item.size,
    material: item.material,
    grade: item.grade,
    pressureRating: item.pressureRating,
    schedule: item.schedule,
    standard: item.standard,
    brand: item.brand,
    missingFields: parseJson<string[]>(item.missingFields, []),
    sourceRef: null,
  };
}

function qualityProblems(findings: SupplierRfqFinding[]): string[] {
  return supplierRfqProblems(findings);
}

/**
 * Creates a supplier quotation request with a secure expiring response link.
 * Nothing is sent until the owner approves.
 */
export async function createSupplierQuoteRequest(input: {
  supplierId: string;
  enquiryItemId: string;
  userId: string;
  actorLabel: string;
  draft?: boolean;
}): Promise<{ ok: true; quoteId: string; link: string } | { ok: false; error: string }> {
  const [supplier, item] = await Promise.all([
    db.supplier.findUnique({ where: { id: input.supplierId } }),
    db.enquiryItem.findUnique({ where: { id: input.enquiryItemId }, include: { enquiry: true } }),
  ]);
  if (!supplier) return { ok: false, error: "Supplier not found." };
  if (!item) return { ok: false, error: "Product line not found." };
  if (!supplier.email && !supplier.whatsapp) {
    return { ok: false, error: "This supplier has no email or WhatsApp number recorded." };
  }
  const existing = await db.supplierQuote.findFirst({
    where: { supplierId: input.supplierId, enquiryItemId: item.id, status: { not: "EXPIRED" } },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      ok: false,
      error:
        existing.status === "DRAFT"
          ? "A draft request for this supplier and product is already waiting."
          : "A request already exists for this supplier and product. Use the existing RFQ instead of sending a duplicate.",
    };
  }

  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(24).toString("base64url");
  // Opaque reference embedded in the RFQ so a reply can be correlated even when
  // the provider does not preserve thread headers. It is not a secret and grants
  // no access by itself.
  const correlationToken = crypto.randomBytes(8).toString("hex").toUpperCase();
  const organization = await getCurrentOrganization();
  const rfqItem = rfqItemFor({
    description: item.description,
    size: item.size,
    material: item.material,
    grade: item.grade,
    pressureRating: item.pressureRating,
    schedule: item.schedule,
    standard: item.standard,
    brand: item.brand,
    quantity: item.quantityToSource || item.quantity,
    unit: item.unit,
    missingFields: item.missingFields,
  });

  const composed = composeSupplierRfq({
    supplierName: supplier.name,
    companyName: organization?.name ?? "Procurement",
    enquiryRef: item.enquiry.publicRef,
    items: [rfqItem],
    link: quoteLink(token),
    correlationToken,
    requiredDelivery: item.enquiry.requestedDeliveryTimeframe ?? null,
  });
  // Deterministic validation always runs. The semantic review runs for an
  // owner-requested RFQ, where a paid model call is justified; drafts for
  // discovered prospects are still validated deterministically and cannot be
  // sent until the owner approves them.
  const semanticFindings = input.draft
    ? []
    : await reviewSupplierRfqWithAi({
        subject: composed.subject,
        body: composed.body,
        items: [rfqItem],
      }).catch(() => []);
  const findings = mergeRfqFindings(composed.findings, semanticFindings);
  const blocking = qualityProblems(findings);
  if (!input.draft && blocking.length > 0) {
    return {
      ok: false,
      error: `The supplier message was not prepared because it failed quality checks: ${blocking.join(" ")}`,
    };
  }

  const quote = await db.supplierQuote.create({
    data: {
      supplierId: supplier.id,
      enquiryItemId: item.id,
      token,
      correlationToken,
      status: input.draft ? "DRAFT" : "AWAITING_APPROVAL",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      subject: composed.subject,
      messageBody: composed.body,
      draftQualityJson: stringifyJson({
        ok: blocking.length === 0,
        checkedAt: new Date().toISOString(),
        findings,
      }),
      items: {
        create: [
          {
            description: composed.items[0]?.description ?? item.description,
            quantity: item.quantityToSource || item.quantity,
            unit: item.unit,
            notes: composed.items[0]?.specification ?? null,
          },
        ],
      },
    },
  });

  const message = { subject: composed.subject, body: composed.body };

  if (input.draft) {
    await writeAudit({
      actorId: input.userId === "system" ? null : input.userId,
      actorLabel: input.actorLabel,
      action: findings.some((finding) => finding.severity === "error")
        ? "supplier_quote.drafted_with_quality_issues"
        : "supplier_quote.drafted",
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: {
        supplier: supplier.name,
        enquiryItemId: item.id,
        qualityFindings: findings.filter((finding) => finding.severity === "error").length,
      },
    });
    return { ok: true, quoteId: quote.id, link: quoteLink(token) };
  }

  const approval = await db.approval.create({
    data: {
      type: "SUPPLIER_QUOTE_SEND",
      entityType: "SupplierQuote",
      entityId: quote.id,
      enquiryId: item.enquiryId,
      status: "PENDING",
      requestedBy: input.actorLabel,
      payloadJson: stringifyJson({
        supplier: supplier.name,
        subject: message.subject,
        body: message.body,
        to: supplier.email ?? supplier.whatsapp ?? supplier.phone,
        channel: supplier.email ? "email" : "whatsapp",
      }),
    },
  });

  await writeAudit({
    actorId: input.userId === "system" ? null : input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_quote.requested",
    entityType: "SupplierQuote",
    entityId: quote.id,
    meta: { approvalId: approval.id, supplier: supplier.name },
  });

  return { ok: true, quoteId: quote.id, link: quoteLink(token) };
}

/** A queued RFQ. It has no approval and cannot be sent until the owner approves it. */
export async function createDraftSupplierQuoteRequest(input: {
  supplierId: string;
  enquiryItemId: string;
  userId: string;
  actorLabel: string;
}) {
  return createSupplierQuoteRequest({ ...input, draft: true });
}

/**
 * Sends an approved supplier quotation request. Never runs without approval.
 *
 * The provider call is protected by the durable outbound ledger: the message is
 * claimed atomically before the call, and a provider timeout/5xx leaves an
 * UNKNOWN record that is never retried automatically.
 */
export async function sendSupplierQuoteRequest(supplierQuoteId: string): Promise<{ ok: boolean; detail: string }> {
  const quote = await db.supplierQuote.findUnique({
    where: { id: supplierQuoteId },
    include: { supplier: true, items: true },
  });
  if (!quote) return { ok: false, detail: "Supplier request not found." };
  const approval = await db.approval.findFirst({
    where: { type: "SUPPLIER_QUOTE_SEND", entityId: quote.id, status: "APPROVED" },
  });
  if (!approval) return { ok: false, detail: "This request has not been approved for sending." };
  if (quote.status === "RESPONDED") return { ok: true, detail: "The supplier already responded." };

  // Final gate before any provider call. This also protects drafts created
  // before the composer was fixed: contaminated or internally-worded messages
  // are blocked instead of being sent just because an approval exists.
  const finalCheck = validateSupplierRfqDraft({
    subject: quote.subject ?? "",
    body: quote.messageBody ?? "",
    items: quote.items.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      missingFields: [],
      sourceRef: null,
    })),
  });
  const finalProblems = qualityProblems(finalCheck);
  if (finalProblems.length > 0) {
    await db.supplierQuote.update({
      where: { id: quote.id },
      data: { lastError: `Quality check blocked sending: ${finalProblems.join(" ")}`.slice(0, 600) },
    });
    await writeAudit({
      action: "supplier_quote.quality_blocked",
      entityType: "SupplierQuote",
      entityId: quote.id,
      actorLabel: "quality-validator",
      meta: { findings: finalCheck.filter((finding) => finding.severity === "error") },
    });
    return {
      ok: false,
      detail: `The supplier message failed its final quality check and was not sent: ${finalProblems.join(" ")}`,
    };
  }

  const guard = await supplierSendGuard(quote.supplierId);
  if (!guard.ok) return { ok: false, detail: guard.error ?? "Sending is blocked for this supplier." };

  const organization = await getCurrentOrganization();
  const subject = quote.subject ?? `Quotation request — ${organization?.name ?? "Procurement"}`;
  const body = quote.messageBody ?? "";
  const emailProvider = await activeEmailProvider();
  const whatsapp = quote.supplier.whatsapp ? await getWhatsAppCredentials() : null;
  const channel: "email" | "whatsapp" | null =
    quote.supplier.email && emailProvider !== "none"
      ? "email"
      : quote.supplier.whatsapp && whatsapp
        ? "whatsapp"
        : null;
  if (!channel) {
    return {
      ok: false,
      detail:
        "No sending channel is configured. Connect a company email account or WhatsApp Business in Settings, or copy the message and send it yourself.",
    };
  }
  const recipient = (channel === "email" ? quote.supplier.email : quote.supplier.whatsapp) as string;
  const limitedApproval = approval;

  const result = await sendOutboundOnce(
    {
      operationKey: outboundOperationKey(["supplier-rfq", quote.id]),
      kind: "SUPPLIER_RFQ",
      channel: channel.toUpperCase(),
      recipient,
      subject,
      body,
      relatedType: "SupplierQuote",
      relatedId: quote.id,
      metadata: { approvalId: limitedApproval.id, supplierId: quote.supplierId },
    },
    async () => {
      // Demo mode never reaches a provider, but it still records a durable SENT
      // row so repeated clicks and retries cannot create duplicate simulations.
      if (isDemoMode) {
        return {
          outcome: "SENT",
          simulated: true,
          providerMessageId: "demo-simulated",
          detail: "Demo simulation: recorded as sent. No supplier message was transmitted.",
        };
      }
      if (channel === "email") {
        const sent = await sendEmail({ to: recipient, subject, text: body });
        if (sent.ok) {
          if (sent.simulated) {
            return {
              outcome: "SENT",
              simulated: true,
              providerMessageId: "demo-simulated",
              detail: "Demo simulation: recorded as sent. No supplier message was transmitted.",
            };
          }
          return {
            outcome: "SENT",
            providerMessageId: sent.providerIds?.messageId ?? null,
            providerThreadId: sent.providerIds?.threadId ?? null,
            detail: `Sent to ${recipient}.`,
          };
        }
        return sent.uncertain
          ? { outcome: "UNKNOWN", error: sent.error }
          : { outcome: "FAILED_SAFE", error: sent.error };
      }
      const sent = await sendWhatsAppText(recipient, body);
      if (sent.ok) {
        return {
          outcome: "SENT",
          simulated: sent.simulated,
          providerMessageId: sent.messageId ?? null,
          detail: sent.detail,
        };
      }
      return sent.uncertain
        ? { outcome: "UNKNOWN", error: sent.detail }
        : { outcome: "FAILED_SAFE", error: sent.detail };
    },
  );

  if (result.status === "SENT" || result.status === "ALREADY_SENT") {
    await db.supplierQuote.update({
      where: { id: quote.id },
      data: {
        status: "SENT",
        sentAt: quote.sentAt ?? new Date(),
        sentTo: recipient,
        providerMessageId: result.providerMessageId ?? quote.providerMessageId,
        providerThreadId: result.providerThreadId ?? quote.providerThreadId,
        channel,
        lastError: null,
      },
    });
    await db.supplier.update({ where: { id: quote.supplierId }, data: { lastQuotedAt: new Date() } });
    if (result.status === "ALREADY_SENT") {
      return { ok: true, detail: "Already sent earlier; no duplicate message was transmitted." };
    }
    await writeAudit({
      actorLabel: result.simulated ? "demo-simulation" : "system",
      action: result.simulated ? "supplier_quote.simulated_sent" : "supplier_quote.sent",
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: { channel, to: recipient, outboundId: result.messageId ?? null },
    });
    return {
      ok: true,
      detail: result.simulated
        ? "Demo simulation: recorded as sent. No supplier message was transmitted."
        : (result.detail || `Sent to ${recipient}.`),
    };
  }

  await db.supplierQuote.update({
    where: { id: quote.id },
    data: { lastError: result.detail.slice(0, 600) },
  });
  await writeAudit({
    action:
      result.status === "UNCERTAIN" || result.status === "IN_PROGRESS"
        ? "supplier_quote.send_uncertain"
        : "supplier_quote.send_failed",
    entityType: "SupplierQuote",
    entityId: quote.id,
    actorLabel: "system",
    meta: { channel, to: recipient, status: result.status, detail: result.detail },
  });
  return { ok: false, detail: result.detail };
}
/**
 * Sends one approved reminder for an unanswered RFQ.
 *
 * A reminder is an external business message, so it requires its own APPROVED
 * approval row for the exact next reminder round. The scheduled reminder job
 * only creates that pending approval; it never sends on its own.
 */
export async function sendSupplierReminder(supplierQuoteId: string): Promise<{ ok: boolean; detail: string }> {
  const quote = await db.supplierQuote.findUnique({
    where: { id: supplierQuoteId },
    include: { supplier: true },
  });
  if (!quote) return { ok: false, detail: "Supplier request not found." };
  if (quote.status !== "SENT" || !quote.sentAt) return { ok: false, detail: "Only a sent, unanswered request can be reminded." };
  if (quote.reminderCount >= env.SUPPLIER_REMINDER_MAX) return { ok: false, detail: "The reminder limit for this request has been reached." };

  const approval = await db.approval.findFirst({
    where: { type: "SUPPLIER_REMINDER", entityId: quote.id, status: "APPROVED" },
    orderBy: { decidedAt: "desc" },
  });
  if (!approval) {
    return {
      ok: false,
      detail: "A supplier reminder requires owner approval. No reminder was sent; request approval first.",
    };
  }
  const approvedRound = Number(parseJson<{ round?: number }>(approval.payloadJson, {}).round ?? 0);
  const nextRound = quote.reminderCount + 1;
  if (approvedRound !== nextRound) {
    return {
      ok: false,
      detail: `The approved reminder is for round ${approvedRound || "unknown"}, not round ${nextRound}. No reminder was sent.`,
    };
  }

  const guard = await supplierSendGuard(quote.supplierId);
  if (!guard.ok) return { ok: false, detail: guard.error ?? "Sending is blocked for this supplier." };

  const organization = await getCurrentOrganization();
  const subject = `Reminder: ${quote.subject ?? `Quotation request — ${organization?.name ?? "Procurement"}`}`;
  const body = [
    `Dear ${quote.supplier.name},`,
    "",
    "This is a polite reminder for the quotation request below. If you have already replied, please ignore this message.",
    "",
    quote.messageBody ?? "",
    "",
    "Thank you,",
    `Procurement — ${organization?.name ?? "Procurement"}`,
  ].join("\n");
  const emailProvider = await activeEmailProvider();
  const whatsapp = quote.supplier.whatsapp ? await getWhatsAppCredentials() : null;
  const channel: "email" | "whatsapp" | null =
    quote.supplier.email && emailProvider !== "none"
      ? "email"
      : quote.supplier.whatsapp && whatsapp
        ? "whatsapp"
        : null;
  if (!channel) return { ok: false, detail: "No sending channel is configured for this reminder." };
  const recipient = (channel === "email" ? quote.supplier.email : quote.supplier.whatsapp) as string;

  const result = await sendOutboundOnce(
    {
      operationKey: outboundOperationKey(["supplier-reminder", quote.id, nextRound]),
      kind: "SUPPLIER_REMINDER",
      channel: channel.toUpperCase(),
      recipient,
      subject,
      body,
      relatedType: "SupplierQuote",
      relatedId: quote.id,
      metadata: { approvalId: approval.id, round: nextRound, supplierId: quote.supplierId },
    },
    async () => {
      if (isDemoMode) {
        return {
          outcome: "SENT",
          simulated: true,
          providerMessageId: "demo-simulated",
          detail: "Demo simulation: reminder recorded, not transmitted.",
        };
      }
      if (channel === "email") {
        const sent = await sendEmail({ to: recipient, subject, text: body });
        if (sent.ok) {
          return {
            outcome: "SENT",
            simulated: sent.simulated,
            providerMessageId: sent.providerIds?.messageId ?? null,
            providerThreadId: sent.providerIds?.threadId ?? null,
            detail: sent.simulated ? "Demo simulation: reminder recorded, not transmitted." : "Reminder sent.",
          };
        }
        return sent.uncertain
          ? { outcome: "UNKNOWN", error: sent.error }
          : { outcome: "FAILED_SAFE", error: sent.error };
      }
      const sent = await sendWhatsAppText(recipient, body);
      if (sent.ok) {
        return {
          outcome: "SENT",
          simulated: sent.simulated,
          providerMessageId: sent.messageId ?? null,
          detail: sent.detail,
        };
      }
      return sent.uncertain
        ? { outcome: "UNKNOWN", error: sent.detail }
        : { outcome: "FAILED_SAFE", error: sent.detail };
    },
  );

  if (result.status === "SENT" || result.status === "ALREADY_SENT") {
    if (result.status === "SENT") {
      await db.supplierQuote.update({
        where: { id: quote.id },
        data: {
          reminderSentAt: new Date(),
          reminderCount: { increment: 1 },
          lastError: null,
        },
      });
    }
    await writeAudit({
      actorLabel: result.simulated ? "demo-simulation" : result.status === "ALREADY_SENT" ? "system" : "system",
      action: result.simulated ? "supplier_quote.reminder_simulated" : "supplier_quote.reminder_sent",
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: { supplier: quote.supplier.name, channel, to: recipient, round: nextRound, outboundId: result.messageId ?? null },
    });
    return {
      ok: true,
      detail:
        result.status === "ALREADY_SENT"
          ? "This reminder was already sent; no duplicate message was transmitted."
          : result.simulated
            ? "Demo simulation: reminder recorded, not transmitted."
            : "Reminder sent.",
    };
  }

  await db.supplierQuote.update({
    where: { id: quote.id },
    data: { lastError: result.detail.slice(0, 600) },
  });
  await writeAudit({
    action: "supplier_quote.reminder_failed",
    entityType: "SupplierQuote",
    entityId: quote.id,
    actorLabel: "system",
    meta: { channel, to: recipient, round: nextRound, status: result.status, detail: result.detail },
  });
  return { ok: false, detail: result.detail };
}

export type SupplierResponseInput = {
  token: string;
  unitPrice: number;
  currency: string;
  offeredDescription?: string | null;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  standard?: string | null;
  fastenerType?: string | null;
  threadSeries?: string | null;
  pitchMm?: number | null;
  lengthMm?: number | null;
  propertyClass?: string | null;
  finish?: string | null;
  moq?: number | null;
  quantityAvailable?: number | null;
  leadTimeDays?: number | null;
  shippingCost?: number | null;
  otherCharges?: number | null;
  taxes?: number | null;
  deliveryLocation?: string | null;
  paymentTerms?: string | null;
  validityDays?: number | null;
  availability?: string | null;
  notes?: string | null;
};

/** Server-side validation for the public supplier form. Never trust the browser. */
export function validateSupplierResponse(input: SupplierResponseInput): string | null {
  if (!input.token) return "This link is not valid.";
  if (!Number.isFinite(input.unitPrice) || input.unitPrice <= 0) return "Enter a valid unit price.";
  if (!/^[A-Z]{3}$/.test(input.currency.toUpperCase())) return "Use a three-letter currency such as AED.";
  for (const [label, value] of [
    ["Minimum order quantity", input.moq],
    ["Available quantity", input.quantityAvailable],
    ["Shipping charges", input.shippingCost],
    ["Other charges", input.otherCharges],
    ["Taxes", input.taxes],
    ["Lead time", input.leadTimeDays],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) return `${label} must be a number of zero or more.`;
  }
  if (input.validityDays != null && (input.validityDays < 1 || input.validityDays > 365)) {
    return "Quote validity must be between 1 and 365 days.";
  }
  return null;
}

/**
 * Supplier submits a quote via the public form; an offer is created for comparison.
 *
 * A submitted price does not prove technical equivalence: the match is recomputed
 * from the specs the supplier states, and the offer stays UNVERIFIED until the
 * owner reviews it. Missing costs stay missing so the landed cost is not faked.
 */
export async function recordSupplierResponse(
  input: SupplierResponseInput,
): Promise<{ ok: true; matchStatus: string } | { ok: false; error: string }> {
  const problem = validateSupplierResponse(input);
  if (problem) return { ok: false, error: problem };

  const quote = await db.supplierQuote.findUnique({
    where: { token: input.token },
    include: { supplier: true, items: { include: { quote: true } } },
  });
  if (!quote) return { ok: false, error: "This link is not valid." };
  if (quote.expiresAt.getTime() < Date.now()) return { ok: false, error: "This quotation link has expired." };
  if (quote.status === "RESPONDED") return { ok: false, error: "A response was already submitted for this request." };

  const item = quote.items[0];
  if (!item || !quote.enquiryItemId) return { ok: false, error: "The request is incomplete." };

  const requested = await db.enquiryItem.findUnique({ where: { id: quote.enquiryItemId } });
  if (!requested) return { ok: false, error: "The request is incomplete." };

  const offeredSpec = parseFastenerSpec({
    description: input.offeredDescription ?? requested.description,
    size: input.size ?? null,
    material: input.material ?? null,
    grade: input.grade ?? null,
    standard: input.standard ?? null,
  });
  // Supplier-entered structured fields take precedence over text extraction.
  if (input.fastenerType) offeredSpec.type = input.fastenerType as typeof offeredSpec.type;
  if (input.threadSeries) offeredSpec.threadSeries = input.threadSeries as typeof offeredSpec.threadSeries;
  if (input.pitchMm != null) offeredSpec.pitchMm = input.pitchMm;
  if (input.lengthMm != null) offeredSpec.lengthMm = input.lengthMm;
  if (input.propertyClass) offeredSpec.propertyClass = input.propertyClass;
  if (input.finish) offeredSpec.finish = input.finish as typeof offeredSpec.finish;

  const requestedIndustrial = parseIndustrialSpecJson(requested.industrialSpecJson);
  const offeredIndustrial = requestedIndustrial
    ? industrialSpecFromFields(
        requestedIndustrial.category,
        {
          description: input.offeredDescription ?? requested.description,
          size: input.size ?? null,
          material: input.material ?? null,
          grade: input.grade ?? null,
          pressureRating: input.pressureRating ?? null,
          standard: input.standard ?? null,
        },
        { source: "SUPPLIER_CONFIRMED" },
      )
    : null;

  const equivalences = await db.materialEquivalence.findMany({
    where: { isActive: true },
    select: { requestedMaterial: true, offeredMaterial: true, requestedGrade: true, offeredGrade: true, reason: true },
  });

  const match = matchProduct(
    {
      description: requested.description,
      category: requested.category,
      brand: requested.brand,
      size: requested.size,
      material: requested.material,
      grade: requested.grade,
      pressureRating: requested.pressureRating,
      schedule: requested.schedule,
      standard: requested.standard,
      fastenerSpec: parseFastenerSpecJson(requested.fastenerSpecJson),
      industrialSpec: requestedIndustrial,
    },
    {
      description: input.offeredDescription ?? requested.description,
      size: input.size ?? null,
      material: input.material ?? null,
      grade: input.grade ?? null,
      pressureRating: input.pressureRating ?? null,
      standard: input.standard ?? null,
      fastenerSpec: offeredSpec,
      industrialSpec: offeredIndustrial,
    },
    { strictStandard: Boolean(requested.standard), equivalences },
  );

  const validityDate =
    input.validityDays && input.validityDays > 0
      ? new Date(Date.now() + input.validityDays * 24 * 60 * 60 * 1000)
      : null;

  const offer = await db.supplierOffer.create({
    data: {
      enquiryItemId: quote.enquiryItemId,
      supplierId: quote.supplierId,
      supplierName: quote.supplier.name,
      productTitle: input.offeredDescription?.trim() || item.description,
      matchStatus: match.status,
      unitPrice: input.unitPrice,
      currency: input.currency.toUpperCase(),
      quantityAvailable: input.quantityAvailable ?? null,
      moq: input.moq ?? null,
      shippingCost: input.shippingCost ?? null,
      otherCharges: input.otherCharges ?? null,
      taxes: input.taxes ?? null,
      leadTimeDays: input.leadTimeDays != null ? Math.round(input.leadTimeDays) : null,
      deliveryLocation: input.deliveryLocation ?? null,
      paymentTerms: input.paymentTerms ?? null,
      validityDate,
      status: "QUOTE_RECEIVED",
      sourceType: "SUPPLIER_QUOTE",
      quotedAt: new Date(),
      quoteRef: quote.id,
      offeredSpecJson: stringifyJson(offeredSpec),
      // A supplier form submission is evidence of a price, not proof of equivalence.
      verificationStatus: "UNVERIFIED",
      evidenceJson: stringifyJson({
        submittedBySupplier: true,
        receivedAt: new Date().toISOString(),
        availability: input.availability ?? null,
        notes: input.notes ?? null,
        statedSpecs: {
          description: input.offeredDescription ?? null,
          size: input.size ?? null,
          material: input.material ?? null,
          grade: input.grade ?? null,
          pressureRating: input.pressureRating ?? null,
          standard: input.standard ?? null,
        },
        match: { status: match.status, reasons: match.reasons ?? [], mismatches: match.mismatches ?? [] },
      }),
      quoteItemId: item.id,
    },
  });

  await db.supplierQuote.update({
    where: { id: quote.id },
    data: {
      status: "RESPONDED",
      respondedAt: new Date(),
      responseNote: input.notes ?? null,
    },
  });
  await db.supplierQuoteItem.update({
    where: { id: item.id },
    data: {
      unitPrice: input.unitPrice,
      currency: input.currency.toUpperCase(),
      moq: input.moq ?? null,
      leadTimeDays: input.leadTimeDays != null ? Math.round(input.leadTimeDays) : null,
      shippingCost: input.shippingCost ?? null,
      otherCharges: input.otherCharges ?? null,
      taxes: input.taxes ?? null,
      validityDate,
      notes: input.notes ?? null,
    },
  });

  const { recomputeOffersForItem } = await import("../costing/evaluate");
  await recomputeOffersForItem(quote.enquiryItemId);
  await db.enquiryItem.update({ where: { id: quote.enquiryItemId }, data: { sourcingStatus: "RESULTS_READY" } });

  const { ensureSourcingApproval } = await import("./approvals");
  await ensureSourcingApproval(quote.enquiryItemId);
  await db.auditLog.create({
    data: {
      action: "supplier_quote.responded",
      entityType: "SupplierQuote",
      entityId: quote.id,
      actorLabel: "supplier",
      metaJson: stringifyJson({
        offerId: offer.id,
        unitPrice: input.unitPrice,
        currency: input.currency.toUpperCase(),
        matchStatus: match.status,
      }),
    },
  });

  return { ok: true, matchStatus: match.status };
}
