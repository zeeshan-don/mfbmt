import { z } from "zod";
import { env } from "../env";
import { DATA_ONLY_RULE, aiStatus, completeJson, type AIUsageSnapshot } from "./provider";

/**
 * Customer purchase-order reading.
 *
 * This pass is deliberately separate from enquiry extraction: a purchase order
 * is a commercial acceptance document, so prices, discounts, taxes, payment
 * terms and delivery conditions matter as much as the product descriptions.
 *
 * Nothing extracted here is applied automatically. The result is compared with
 * the exact quotation version that was sent, stored as evidence, and shown to
 * the owner for an explicit decision.
 */

const EvidenceSchema = z.object({
  source: z.string().trim().max(300),
  locator: z.string().trim().max(200).nullable().default(null),
  quote: z.string().trim().max(600).nullable().default(null),
});

export const CustomerPurchaseOrderLineSchema = z.object({
  description: z.string().trim().min(1).max(800),
  specifications: z.string().trim().max(1500).nullable().default(null),
  quantity: z.number().nonnegative().nullable().default(null),
  unit: z.string().trim().max(30).nullable().default(null),
  unit_price: z.number().nonnegative().nullable().default(null),
  discount_pct: z.number().min(0).max(100).nullable().default(null),
  tax_rate_pct: z.number().min(0).max(100).nullable().default(null),
  line_total: z.number().nonnegative().nullable().default(null),
  /** One of the opaque QT-ITEM-n refs supplied for the correlated quotation. */
  quoted_item_ref: z.string().trim().max(80).nullable().default(null),
  evidence: z.array(EvidenceSchema).max(12).default([]),
});

export type CustomerPurchaseOrderLine = z.infer<typeof CustomerPurchaseOrderLineSchema>;

export const CustomerPurchaseOrderSchema = z.object({
  is_purchase_order: z.boolean().default(false),
  customer_name: z.string().trim().max(300).nullable().default(null),
  po_number: z.string().trim().max(120).nullable().default(null),
  po_date: z.string().trim().max(40).nullable().default(null),
  currency: z.string().trim().max(8).nullable().default(null),
  payment_terms: z.string().trim().max(600).nullable().default(null),
  delivery_terms: z.string().trim().max(600).nullable().default(null),
  delivery_address: z.string().trim().max(900).nullable().default(null),
  requested_delivery_date: z.string().trim().max(40).nullable().default(null),
  tax_amount: z.number().nonnegative().nullable().default(null),
  tax_rate_pct: z.number().min(0).max(100).nullable().default(null),
  conditions: z.string().trim().max(2000).nullable().default(null),
  lines: z.array(CustomerPurchaseOrderLineSchema).max(200).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  notes: z.string().trim().max(1200).nullable().default(null),
});

export type CustomerPurchaseOrder = z.infer<typeof CustomerPurchaseOrderSchema>;

export type CustomerPoDocument = {
  filename: string;
  text: string;
  pageCount?: number | null;
  status?: string | null;
  images?: string[];
};

export type CustomerPoExtractionInput = {
  subject?: string | null;
  body: string;
  fromName?: string | null;
  fromAddress?: string | null;
  documents: CustomerPoDocument[];
  /** Opaque refs for the correlated quotation lines. */
  quotationItems: Array<{ ref: string; description: string; specs: string | null; quantity: number; unit: string; unitPrice: number | null }>;
  quotationNumber: string;
  quotationCurrency: string;
};

export type CustomerPoExtractionOutcome =
  | { status: "OK"; data: CustomerPurchaseOrder; usage?: AIUsageSnapshot }
  | { status: "NOT_CONFIGURED" | "BUDGET_BLOCKED" | "FAILED"; error: string };

const MAX_DOCUMENT_CHARS = 8_000;
const MAX_TOTAL_DOCUMENT_CHARS = 40_000;
const MAX_VISION_IMAGES = 6;

function asNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function normalizeCustomerPurchaseOrder(data: CustomerPurchaseOrder): CustomerPurchaseOrder {
  return {
    ...data,
    customer_name: asNull(data.customer_name),
    po_number: asNull(data.po_number),
    po_date: normalizeDate(data.po_date),
    currency: asNull(data.currency)?.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || null,
    payment_terms: asNull(data.payment_terms),
    delivery_terms: asNull(data.delivery_terms),
    delivery_address: asNull(data.delivery_address),
    requested_delivery_date: normalizeDate(data.requested_delivery_date),
    conditions: asNull(data.conditions),
    notes: asNull(data.notes),
    lines: data.lines.map((line) => ({
      ...line,
      description: line.description.trim(),
      specifications: asNull(line.specifications),
      unit: asNull(line.unit),
      quoted_item_ref: asNull(line.quoted_item_ref),
      evidence: line.evidence.filter((entry) => entry.source.trim().length > 0),
    })),
  };
}

function documentsBlock(documents: CustomerPoDocument[]): string {
  let budget = MAX_TOTAL_DOCUMENT_CHARS;
  const parts: string[] = [];
  for (const document of documents) {
    if (budget <= 0) break;
    const limit = Math.min(MAX_DOCUMENT_CHARS, budget);
    const text = document.text.slice(0, limit);
    budget -= text.length;
    const visualNote = document.images?.length
      ? `\n[${document.images.length} visual page/image(s) from this attachment are supplied separately to the vision model.]`
      : "";
    parts.push(
      `<document filename="${document.filename.replace(/"/g, "'")}" pages="${
        document.pageCount ?? "unknown"
      }" status="${document.status ?? "unknown"}">\n${text}${visualNote}\n</document>`,
    );
  }
  return parts.join("\n\n");
}

function collectVisionImages(documents: CustomerPoDocument[]): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  for (const document of documents) {
    for (const image of document.images ?? []) {
      if (!image.startsWith("data:image/") || seen.has(image)) continue;
      seen.add(image);
      images.push(image);
      if (images.length >= MAX_VISION_IMAGES) return images;
    }
  }
  return images;
}

export async function extractCustomerPurchaseOrder(input: CustomerPoExtractionInput): Promise<CustomerPoExtractionOutcome> {
  const status = aiStatus();
  if (!status.configured) {
    return { status: "NOT_CONFIGURED", error: status.reason ?? "AI is not configured." };
  }

  const quotationBlock = input.quotationItems
    .map(
      (item) =>
        `<quotation_item ref="${item.ref}">${item.description.slice(0, 300)}${
          item.specs ? ` | ${item.specs.slice(0, 300)}` : ""
        } | ${item.quantity} ${item.unit} | ${item.unitPrice == null ? "unpriced" : `${input.quotationCurrency} ${item.unitPrice}`}</quotation_item>`,
    )
    .join("\n");

  const visionImages = collectVisionImages(input.documents);
  const request = (includeVision: boolean) =>
    completeJson(
      {
        system:
          "You read a customer purchase order or written acceptance for an industrial building-materials trader in the UAE. " +
          "Extract only what the document actually states. Missing values must be null, never 0 and never guessed. " +
          "Never convert currencies, units or tax rates. Never invent a price, discount, tax, delivery date or payment term. " +
          "Preserve the customer's wording and technical specifications instead of normalizing differences away. " +
          "Set is_purchase_order true only when the document is an order, purchase order, signed acceptance or an unambiguous written instruction to proceed. " +
          "A request for a revised price, a question, a delivery chase or a new enquiry is not a purchase order. " +
          "Read Arabic, English and mixed documents, tables, stamps and scanned pages. " +
          "When visual pages are supplied, inspect the image itself for table columns, handwritten changes, stamps and signatures; do not rely only on OCR text. " +
          "quoted_item_ref may only use one of the refs supplied in <quotation_item_list>; otherwise null. Never match by price alone. " +
          "For every line include evidence: source filename (or 'email body'), page/row locator when known, and a short verbatim quote. " +
          "Never approve the order, change a commitment or decide that a difference is acceptable; the application compares the document with the sent quotation and the owner decides. " +
          DATA_ONLY_RULE,
        user:
          `<customer_message from="${(input.fromAddress ?? "unknown").replace(/"/g, "")}" name="${(
            input.fromName ?? "unknown"
          ).replace(/"/g, "")}" subject="${(input.subject ?? "").replace(/"/g, "'")}">\n${input.body.slice(
            0,
            6_000,
          )}\n</customer_message>\n\n` +
          `<quotation reference="${input.quotationNumber}" currency="${input.quotationCurrency}">\n${quotationBlock}\n</quotation>\n\n` +
          `${documentsBlock(input.documents)}\n\n` +
          "Return this JSON shape exactly (snake_case keys):\n" +
          '{"is_purchase_order":false,"customer_name":null,"po_number":null,"po_date":null,"currency":null,' +
          '"payment_terms":null,"delivery_terms":null,"delivery_address":null,"requested_delivery_date":null,' +
          '"tax_amount":null,"tax_rate_pct":null,"conditions":null,"lines":[{"description":"required","specifications":null,' +
          '"quantity":null,"unit":null,"unit_price":null,"discount_pct":null,"tax_rate_pct":null,"line_total":null,' +
          '"quoted_item_ref":null,"evidence":[{"source":"required","locator":null,"quote":null}]}],' +
          '"confidence":null,"notes":null}',
        maxTokens: 4_000,
        temperature: 0,
        model: includeVision && visionImages.length > 0 ? env.AI_VISION_MODEL.trim() || env.AI_MODEL : undefined,
        images: includeVision && visionImages.length > 0 ? visionImages : undefined,
        jobType: "customer.purchase_order.extraction",
      },
      CustomerPurchaseOrderSchema,
    );

  let result = await request(visionImages.length > 0);
  if (
    !result.ok &&
    visionImages.length > 0 &&
    !result.budgetBlocked &&
    /returned 400|image|vision|multimodal|unsupported|not support/i.test(result.error)
  ) {
    result = await request(false);
  }

  if (!result.ok) {
    if (result.notConfigured) return { status: "NOT_CONFIGURED", error: result.error };
    if (result.budgetBlocked) return { status: "BUDGET_BLOCKED", error: result.error };
    return { status: "FAILED", error: result.error };
  }
  return { status: "OK", data: normalizeCustomerPurchaseOrder(result.data), usage: result.usage };
}
