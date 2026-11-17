import { db } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { stringifyJson } from "../json";
import { sendWhatsAppText } from "../intake/whatsapp";
import { sendEmail } from "../email/send";
import { buildSpecSummary } from "../catalog/normalize";

function quoteLink(token: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/supplier-response/${token}`;
}

export function draftSupplierMessage(input: {
  supplierName: string;
  enquiryRef: string;
  items: Array<{ description: string; quantity: number; unit: string; specs?: string | null }>;
  link: string;
}): { subject: string; body: string } {
  const subject = `Quotation request ${input.enquiryRef} — MFBMT`;
  const lines = input.items.map(
    (item, index) =>
      `${index + 1}. ${item.description} — ${item.quantity} ${item.unit}${
        item.specs && item.specs !== item.description ? ` (${item.specs})` : ""
      }`,
  );
  const body = [
    `Dear ${input.supplierName},`,
    "",
    "Please quote your best price for the following items:",
    "",
    ...lines,
    "",
    "Kindly confirm unit price, minimum order quantity, availability, lead time and quote validity.",
    `You can submit your quotation securely here: ${input.link}`,
    "",
    "Thank you,",
    "Procurement — Multi Fasteners Building Materials Trading LLC",
  ].join("\n");
  return { subject, body };
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
}): Promise<{ ok: true; quoteId: string; link: string } | { ok: false; error: string }> {
  const [supplier, item] = await Promise.all([
    db.supplier.findUnique({ where: { id: input.supplierId } }),
    db.enquiryItem.findUnique({ where: { id: input.enquiryItemId }, include: { enquiry: true } }),
  ]);
  if (!supplier) return { ok: false, error: "Supplier not found." };
  if (!item) return { ok: false, error: "Product line not found." };
  if (!supplier.email && !supplier.whatsapp && !supplier.phone) {
    return { ok: false, error: "This supplier has no email or WhatsApp number recorded." };
  }

  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(24).toString("base64url");
  const quote = await db.supplierQuote.create({
    data: {
      supplierId: supplier.id,
      enquiryItemId: item.id,
      token,
      status: "AWAITING_APPROVAL",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      items: {
        create: [
          {
            description: item.description,
            quantity: item.quantityToSource || item.quantity,
            unit: item.unit,
            notes: buildSpecSummary({
              description: item.description,
              size: item.size,
              material: item.material,
              grade: item.grade,
              pressureRating: item.pressureRating,
              schedule: item.schedule,
              standard: item.standard,
            }),
          },
        ],
      },
    },
  });

  const message = draftSupplierMessage({
    supplierName: supplier.name,
    enquiryRef: item.enquiry.publicRef,
    items: [
      {
        description: item.description,
        quantity: item.quantityToSource || item.quantity,
        unit: item.unit,
        specs: buildSpecSummary({
          description: item.description,
          size: item.size,
          material: item.material,
          grade: item.grade,
          pressureRating: item.pressureRating,
          schedule: item.schedule,
          standard: item.standard,
        }),
      },
    ],
    link: quoteLink(token),
  });

  await db.supplierQuote.update({
    where: { id: quote.id },
    data: { subject: message.subject, messageBody: message.body },
  });

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
    actorId: input.userId,
    actorLabel: input.actorLabel,
    action: "supplier_quote.requested",
    entityType: "SupplierQuote",
    entityId: quote.id,
    meta: { approvalId: approval.id, supplier: supplier.name },
  });

  return { ok: true, quoteId: quote.id, link: quoteLink(token) };
}

/** Sends an approved supplier quotation request. Never runs without approval. */
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
  if (quote.status === "SENT" || quote.status === "RESPONDED") {
    return { ok: true, detail: "Already sent earlier." };
  }

  const subject = quote.subject ?? "Quotation request — MFBMT";
  const body = quote.messageBody ?? "";

  if (quote.supplier.email && env.EMAIL_INTAKE_PROVIDER !== "none") {
    const sent = await sendEmail({ to: quote.supplier.email, subject, text: body });
    if (!sent.ok) return { ok: false, detail: sent.error };
    await db.supplierQuote.update({ where: { id: quote.id }, data: { status: "SENT", sentAt: new Date() } });
    return { ok: true, detail: `Sent to ${quote.supplier.email}.` };
  }

  if (quote.supplier.whatsapp && env.WHATSAPP_ACCESS_TOKEN) {
    const sent = await sendWhatsAppText(quote.supplier.whatsapp, body);
    if (!sent.ok) return { ok: false, detail: sent.detail };
    await db.supplierQuote.update({ where: { id: quote.id }, data: { status: "SENT", sentAt: new Date() } });
    return { ok: true, detail: sent.detail };
  }

  return {
    ok: false,
    detail:
      "No sending channel is configured. Connect a company email account or WhatsApp Business in Settings, or copy the message and send it yourself.",
  };
}

/** Supplier submits price via the public form; creates an offer for comparison. */
export async function recordSupplierResponse(input: {
  token: string;
  unitPrice: number;
  currency: string;
  moq?: number | null;
  leadTimeDays?: number | null;
  shippingCost?: number | null;
  validityDays?: number | null;
  availability?: string | null;
  notes?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const quote = await db.supplierQuote.findUnique({
    where: { token: input.token },
    include: { supplier: true, items: true },
  });
  if (!quote) return { ok: false, error: "This link is not valid." };
  if (quote.expiresAt.getTime() < Date.now()) return { ok: false, error: "This quotation link has expired." };
  if (quote.status === "RESPONDED") return { ok: false, error: "A response was already submitted for this request." };

  const item = quote.items[0];
  if (!item || !quote.enquiryItemId) return { ok: false, error: "The request is incomplete." };
  const validityDate =
    input.validityDays && input.validityDays > 0
      ? new Date(Date.now() + input.validityDays * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const offer = await db.supplierOffer.create({
    data: {
      enquiryItemId: quote.enquiryItemId,
      supplierId: quote.supplierId,
      supplierName: quote.supplier.name,
      productTitle: item.description,
      matchStatus: "POSSIBLE",
      unitPrice: input.unitPrice,
      currency: input.currency.toUpperCase(),
      moq: input.moq ?? null,
      shippingCost: input.shippingCost ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      validityDate,
      status: "QUOTE_RECEIVED",
      sourceType: "SUPPLIER_QUOTE",
      quotedAt: new Date(),
      quoteRef: quote.id,
      verificationStatus: "VERIFIED",
      evidenceJson: stringifyJson({
        submittedBySupplier: true,
        availability: input.availability ?? null,
        notes: input.notes ?? null,
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
      leadTimeDays: input.leadTimeDays ?? null,
      shippingCost: input.shippingCost ?? null,
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
      metaJson: stringifyJson({ offerId: offer.id, unitPrice: input.unitPrice }),
    },
  });

  return { ok: true };
}
