import { db } from "../db";
import { matchProduct } from "../inventory/matching";
import { env, isDemoMode } from "../env";
import { writeAudit } from "../audit";
import { stringifyJson } from "../json";
import { sendWhatsAppText } from "../intake/whatsapp";
import { activeEmailProvider, sendEmail } from "../email/send";
import { getWhatsAppCredentials } from "../integrations/whatsapp";
import { buildSpecSummary } from "../catalog/normalize";
import { parseFastenerSpec, parseFastenerSpecJson } from "../fasteners/spec";
import { getCurrentOrganization } from "../organization";

function quoteLink(token: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/supplier-response/${token}`;
}

export function draftSupplierMessage(input: {
  supplierName: string;
  companyName: string;
  enquiryRef: string;
  items: Array<{ description: string; quantity: number; unit: string; specs?: string | null }>;
  link: string;
}): { subject: string; body: string } {
  const subject = `Quotation request ${input.enquiryRef} — ${input.companyName}`;
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
    `Procurement — ${input.companyName}`,
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

  const organization = await getCurrentOrganization();
  const message = draftSupplierMessage({
    supplierName: supplier.name,
    companyName: organization?.name ?? "Procurement",
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

  const organization = await getCurrentOrganization();
  const subject = quote.subject ?? `Quotation request — ${organization?.name ?? "Procurement"}`;
  const body = quote.messageBody ?? "";

  // Demo mode never reaches a provider. The activity log records the simulation.
  if (isDemoMode) {
    await db.supplierQuote.update({ where: { id: quote.id }, data: { status: "SENT", sentAt: new Date() } });
    await writeAudit({
      actorLabel: "demo-simulation",
      action: "supplier_quote.simulated_sent",
      entityType: "SupplierQuote",
      entityId: quote.id,
      meta: { channel: quote.supplier.email ? "email" : "whatsapp", to: quote.supplier.email ?? quote.supplier.whatsapp },
    });
    return { ok: true, detail: "Demo simulation: recorded as sent. No supplier message was transmitted." };
  }

  // Channel availability comes from the stored connection, not from a stale env
  // flag: with Embedded Signup there is no static WHATSAPP_ACCESS_TOKEN.
  const emailProvider = await activeEmailProvider();
  if (quote.supplier.email && emailProvider !== "none") {
    const sent = await sendEmail({ to: quote.supplier.email, subject, text: body });
    if (!sent.ok) return { ok: false, detail: sent.error };
    await db.supplierQuote.update({ where: { id: quote.id }, data: { status: "SENT", sentAt: new Date() } });
    return { ok: true, detail: `Sent to ${quote.supplier.email}.` };
  }

  const whatsapp = await getWhatsAppCredentials();
  if (quote.supplier.whatsapp && whatsapp) {
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
    },
    {
      description: input.offeredDescription ?? requested.description,
      size: input.size ?? null,
      material: input.material ?? null,
      grade: input.grade ?? null,
      pressureRating: input.pressureRating ?? null,
      standard: input.standard ?? null,
      fastenerSpec: offeredSpec,
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
