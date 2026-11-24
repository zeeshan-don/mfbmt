import { AIClassificationResponseSchema, type ClassificationResult } from "../validation/extraction";
import { completeJson, aiStatus, DATA_ONLY_RULE } from "./provider";

export type ClassifyInput = {
  text: string;
  subject?: string | null;
  channel: string;
  hasAttachments: boolean;
  senderKind?: string | null;
  excludedCategory?: string | null;
  /**
   * Whether an external AI provider may read this message. Unknown senders are
   * classified locally until the owner confirms they are a business contact.
   */
  allowAi?: boolean;
};

const PERSONAL_WORDS = [
  "happy birthday", "birthday", "wedding", "how are you", "how r u", "see you", "lunch",
  "dinner", "family", "congratulations", "eid mubarak", "good morning bro", "love you",
  "did you eat", "call me later", "school", "kids",
];
const SUPPLIER_WORDS = [
  "we can supply", "we supply", "our offer", "our quotation", "our best price", "price list",
  "kindly find our", "please find our offer", "we are a manufacturer", "we are distributor",
  "ex-stock", "our lead time", "we can offer",
];
const RFQ_WORDS = [
  "quote", "quotation", "quotation request", "rfq", "enquiry", "inquiry", "requirement",
  "require", "required", "need", "please price", "price for", "provide price", "best price for",
  "send us your offer", "rate for", "budgetary",
];
const AVAILABILITY_WORDS = ["do you have", "do you stock", "in stock", "availability", "is this available", "have you got"];
const NON_RFQ_BUSINESS = ["invoice", "payment", "delivery note", "statement", "ledger", "cheque", "vat", "trn"];
const PRODUCT_HINTS = [
  "elbow", "valve", "flange", "gasket", "hose", "fitting", "bolt", "nut", "washer", "pipe",
  "ss", "stainless", "pvc", "ppr", "hdpe", "steel", "hammer", "coupling", "tee", "reducer",
  "nipple", "union", "clamp", "fastener", "flanges", "valves", "bearings", "tools",
  "acid", "chemical", "caustic", "soda", "chloride", "hypochlorite", "solvent", "seal kit",
];

function countMatches(text: string, words: string[]): number {
  return words.reduce((acc, word) => (text.includes(word) ? acc + 1 : acc), 0);
}

/**
 * Rule-based first pass. Runs even when no AI is configured, so behaviour is
 * predictable and testable. AI may refine but can never turn an excluded
 * personal contact into a business enquiry.
 */
export function ruleClassify(input: ClassifyInput): ClassificationResult {
  const raw = `${input.subject ?? ""}\n${input.text ?? ""}`.trim();
  const text = raw.toLowerCase();
  const excluded = input.excludedCategory;

  if (excluded === "FAMILY" || excluded === "PERSONAL" || excluded === "OTHER") {
    return {
      classification: "PERSONAL",
      confidence: 0.99,
      reason: "This contact is marked as a family or personal contact.",
      mentionsProducts: false,
      isQuotationRequest: false,
    };
  }

  if (text.length === 0 && input.hasAttachments) {
    return {
      classification: "RFQ",
      confidence: 0.6,
      reason: "Attachment received without text. It may be a request for quotation.",
      mentionsProducts: true,
      isQuotationRequest: true,
    };
  }

  const personalScore = countMatches(text, PERSONAL_WORDS);
  const productScore = countMatches(text, PRODUCT_HINTS);
  const rfqScore = countMatches(text, RFQ_WORDS);
  const availabilityScore = countMatches(text, AVAILABILITY_WORDS);
  const supplierScore = countMatches(text, SUPPLIER_WORDS);
  const businessScore = countMatches(text, NON_RFQ_BUSINESS);
  const hasQuantity = /\b\d+\s*(pcs|pc|pieces?|nos?|units?|kg|m|sets?|box(es)?)\b/i.test(text);

  if (personalScore > 0 && productScore === 0 && rfqScore === 0) {
    return {
      classification: "PERSONAL",
      confidence: 0.9,
      reason: "The message reads as a personal message, not a business request.",
      mentionsProducts: false,
      isQuotationRequest: false,
    };
  }

  if (supplierScore >= 2 && rfqScore === 0) {
    return {
      classification: "SUPPLIER",
      confidence: 0.8,
      reason: "The sender is offering goods or pricing rather than requesting a quotation.",
      mentionsProducts: productScore > 0,
      isQuotationRequest: false,
    };
  }

  if (availabilityScore > 0 && rfqScore === 0 && !input.hasAttachments) {
    return {
      classification: "AVAILABILITY",
      confidence: 0.7,
      reason: "This asks whether a product is available rather than requesting a formal quotation.",
      mentionsProducts: productScore > 0,
      isQuotationRequest: false,
    };
  }

  // An attachment is usually the actual RFQ (price list, BOQ, enquiry sheet).
  // Treat it as a quotation request unless the text is clearly personal,
  // a supplier offer, an invoice/ledger or an availability question with no
  // product context at all.
  if (
    input.hasAttachments &&
    personalScore === 0 &&
    supplierScore < 2 &&
    businessScore === 0
  ) {
    return {
      classification: "RFQ",
      confidence: input.text.trim().length === 0 ? 0.6 : 0.65,
      reason: "An attachment was received and looks like a quotation request.",
      mentionsProducts: true,
      isQuotationRequest: true,
    };
  }

  if (rfqScore > 0 && (productScore > 0 || hasQuantity || input.hasAttachments)) {
    return {
      classification: "RFQ",
      confidence: hasQuantity && productScore > 0 ? 0.85 : 0.7,
      reason: "The message asks for pricing or a quotation for products.",
      mentionsProducts: true,
      isQuotationRequest: true,
    };
  }

  if (businessScore > 0) {
    return {
      classification: "FOLLOW_UP",
      confidence: 0.6,
      reason: "This is a business request that is not a quotation request.",
      mentionsProducts: false,
      isQuotationRequest: false,
    };
  }

  if (text.includes("thank") && (text.includes("delivery") || text.includes("order") || text.includes("yesterday"))) {
    return {
      classification: "FOLLOW_UP",
      confidence: 0.75,
      reason: "The customer is following up on an existing order, not requesting a quote.",
      mentionsProducts: false,
      isQuotationRequest: false,
    };
  }

  if (productScore > 0 && hasQuantity) {
    return {
      classification: "RFQ",
      confidence: 0.55,
      reason: "Products and quantities were mentioned but the request is not explicit.",
      mentionsProducts: true,
      isQuotationRequest: true,
    };
  }

  return {
    classification: "UNCLEAR",
    confidence: 0.3,
    reason: "The system could not tell whether this is a quotation request.",
    mentionsProducts: productScore > 0,
    isQuotationRequest: false,
  };
}

export type ClassificationOutput = {
  result: ClassificationResult;
  source: "rule" | "ai";
  aiError?: string;
  needsReview: boolean;
};

export async function classifyMessage(input: ClassifyInput): Promise<ClassificationOutput> {
  const rule = ruleClassify(input);
  const excluded = input.excludedCategory;

  // Hard stop for excluded personal contacts: never call the model with their text.
  if (excluded === "FAMILY" || excluded === "PERSONAL" || excluded === "OTHER") {
    return { result: rule, source: "rule", needsReview: false };
  }

  if (!aiStatus().configured || input.allowAi === false) {
    return {
      result: rule,
      source: "rule",
      aiError:
        input.allowAi === false
          ? "First message from an unknown sender: classified locally so personal content is not sent to an AI provider."
          : undefined,
      needsReview: input.allowAi === false || rule.confidence < 0.65 || rule.classification === "UNCLEAR",
    };
  }

  const ai = await completeJson(
    {
      system:
        "You classify inbound messages for an industrial building-materials trading company in the UAE. " +
        "Decide whether a message is a genuine customer request for quotation (RFQ). " +
        "A product mention alone is not an RFQ. Availability questions, invoices, order follow-ups, supplier offers, family/personal messages and unclear messages are NOT RFQs. " +
        "If the message includes an attachment, a short greeting or a line like 'I urgently need these items' is a quotation request; read the attachment instead of treating the greeting as personal. " +
        "Reply with JSON only: {\"classification\": one of RFQ|AVAILABILITY|FOLLOW_UP|SUPPLIER|BUSINESS_OTHER|PERSONAL|UNCLEAR, \"reason\": short business explanation, \"confidence\": 0..1, \"mentionsProducts\": boolean, \"isQuotationRequest\": boolean, \"customerName\": string|null, \"customerPhone\": string|null, \"customerEmail\": string|null}. " +
        DATA_ONLY_RULE,
      user: `<customer_message channel="${input.channel}" attachments="${input.hasAttachments}">\n${input.text.slice(0, 6000)}\n</customer_message>`,
      maxTokens: 500,
    },
    AIClassificationResponseSchema,
  );

  if (!ai.ok) {
    return {
      result: rule,
      source: "rule",
      aiError: ai.error,
      needsReview: rule.confidence < 0.65 || rule.classification === "UNCLEAR",
    };
  }

  const result: ClassificationResult = {
    classification: ai.data.classification,
    confidence: Math.min(1, Math.max(0, ai.data.confidence)),
    reason: ai.data.reason || rule.reason,
    mentionsProducts: ai.data.mentionsProducts,
    isQuotationRequest: ai.data.isQuotationRequest,
  };

  // An attached document is the request. A greeting must never let the model
  // discard a spreadsheet or PDF before its contents are read.
  if (
    input.hasAttachments &&
    rule.classification === "RFQ" &&
    ["PERSONAL", "AVAILABILITY", "FOLLOW_UP", "UNCLEAR"].includes(result.classification)
  ) {
    result.classification = "RFQ";
    result.confidence = Math.max(0.7, Math.min(result.confidence, 0.8));
    result.reason = "An attachment was received, so this is treated as a quotation request.";
    result.mentionsProducts = true;
    result.isQuotationRequest = true;
  }

  // Safety: an RFQ must be consistent with the message actually asking for pricing.
  if (result.classification === "RFQ" && !result.isQuotationRequest) {
    if (input.hasAttachments && rule.classification === "RFQ") {
      result.isQuotationRequest = true;
      result.confidence = Math.max(0.7, result.confidence);
    } else {
      result.classification = "UNCLEAR";
      result.confidence = Math.min(result.confidence, 0.4);
      result.reason = "The request is not clearly asking for a quotation.";
    }
  }

  return {
    result,
    source: "ai",
    needsReview: result.classification === "UNCLEAR" || result.confidence < 0.65,
  };
}
