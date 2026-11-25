import type { CustomerContext, ExtractedItem } from "../validation/extraction";

/**
 * Semantic pre-processing for enquiry text.
 *
 * The extraction model is an interpreter, not the authority on what is a
 * product. This module supplies a deterministic reading of the message so a
 * greeting, an instruction ("please process urgently"), a requested delivery
 * window ("within 3 days") or a signature can never become an RFQ line by
 * accident. The AI may classify the content more richly, but every result it
 * returns is checked against these rules before a product is created.
 */

export const SEGMENT_KINDS = [
  "GREETING",
  "CUSTOMER_INSTRUCTION",
  "URGENCY",
  "DELIVERY_TIMEFRAME",
  "DELIVERY_LOCATION",
  "PRODUCT",
  "TECHNICAL_SPECIFICATION",
  "COMMERCIAL_REQUIREMENT",
  "NOTE",
  "SIGNATURE",
  "IRRELEVANT",
] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export type TextSegment = {
  kind: SegmentKind;
  text: string;
  sourceRef: string;
};

/**
 * Product families the business actually trades. A line must contain one of
 * these nouns (or an explicit part number attached to one) before it can be
 * treated as a requested item. A bare material or size is a specification,
 * not a product.
 */
const PRODUCT_NOUN =
  /\b(?:elbows?|tees?|reducers?|couplings?|unions?|nipples?|caps?|bends?|crosses?|bushings?|valves?|flanges?|gaskets?|pipes?|tubes?|fittings?|bolts?|nuts?|washers?|fasteners?|screws?|studs?|rods?|anchors?|bearings?|seals?|pumps?|motors?|impellers?|filters?|hoses?|clamps?|brackets?|plates?|sheets?|angles?|channels?|beams?|bars?|wires?|cables?|switches?|sockets?|lamps?|lighting|tools?|hammers?|wrenches?|drills?|saws?|chemicals?|acids?|solvents?|caustic|soda|chloride|hypochlorite|paints?|cements?|adhesives?|tapes?|insulations?|kits?|spares?|parts?|strainers?|traps?|regulators?|gauges?|meters?|sensors?|actuators?|compressors?|generators?|heaters?|coolers?|tanks?|vessels?|ladders?|scaffolds?|scaffolding|grating|mesh|studs?|flange|fastener)\b/i;

const FASTENER_PART = /\b(?:m\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?|astm\s*a\d+|a\d{3}\s*(?:gr\.?|grade)?|iso\s*\d+|din\s*\d+)\b/i;

const GREETING =
  /^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings|salutations|salam|assalamu\s*alaikum|السلام\s*عليكم|مرحبا|صباح\s*الخير|مساء\s*الخير)\b/i;

const SIGNATURE =
  /^(?:best\s+regards|kind\s+regards|warm\s+regards|regards|thanks|thank\s+you|many\s+thanks|sincerely|yours\s+(?:sincerely|faithfully)|sent\s+from|مع\s+تحياتي|شكرا)\b/i;

const URGENCY =
  /\b(?:urgent(?:ly)?|asap|as\s+soon\s+as\s+possible|immediately|at\s+the\s+earliest|emergency|critical|عاجل|بأسرع\s+وقت|فورا)\b/i;

const DELIVERY_TIMEFRAME =
  /(?:\b(?:delivery|deliver|required|needed?|need|due|within|in|by)\b[^.\n]{0,60}?\b\d{1,3}\s*(?:working\s*)?(?:calendar\s*)?(?:days?|weeks?|months?)\b|\b\d{1,3}\s*(?:working\s*)?(?:days?|weeks?)\b[^.\n]{0,30}\b(?:delivery|lead\s*time)\b)/i;

/** The duration itself, never the whole instruction that contains it. */
const DELIVERY_DURATION =
  /\b(\d{1,3}\s*(?:working\s*)?(?:calendar\s*)?(?:days?|weeks?|months?))\b/i;

const DELIVERY_LOCATION =
  /(?:\b(?:delivery|deliver|ship(?:ping)?|consign(?:ed)?)\s+(?:to|at)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 .,'#/()\-]{2,80})|\b(?:site|project|location)\s*[:=\-]\s*([A-Za-z0-9][A-Za-z0-9 .,'#/()\-]{2,80}))/i;

const INSTRUCTION_START =
  /^(?:please|pls|kindly|can\s+you|could\s+you|would\s+you|we\s+(?:need|require|request)|i\s+(?:need|require|request)|need|required|require|quote|send|provide|confirm|advise|process|arrange|note|do\s+not|don't|must|make\s+sure|deliver|ship|prepare|submit|return|reply|let\s+us\s+know|يرجى|من\s+فضلك|نرجو)\b/i;

const COMMERCIAL =
  /\b(?:payment\s+terms?|credit\s+terms?|validity|valid\s+for|moq|minimum\s+order|warranty|freight|incoterms?|delivery\s+terms?|fob|cif|ex[-\s]?works?|lead\s+time|discount|tax|vat|currency)\b/i;

const TECHNICAL_LABEL =
  /\b(?:size|dimension|material|grade|class|schedule|sch|standard|spec(?:ification)?|pressure|rating|thickness|diameter|od|id|wall|length|finish|coating|thread|pitch)\b\s*[:=\-]/i;

const CERTIFICATION =
  /\b(?:en\s*10204\s*3\.1|mill\s+test\s+certificate|material\s+certificate|certificate\s+of\s+origin|coo|iso\s*\d{4,5}|api\s*\d+[a-z]?|ce\s+marked|third[-\s]?party\s+inspection|nace\s*mr\d+)\b/i;

const INTERNAL_NOTE =
  /\b(?:catalogue[-\s]*derived|catalog[-\s]*derived|catalogue\s+details?|catalog\s+details?|confirm\s+exact\s+item|internal\s+(?:note|match|confidence|review|sourcing)|match\s+confidence|catalogue\s+(?:id|ref|reference|url|link)|ogs\s+catalogue|sku\s*[:=]|database\s+id|source\s*[:=]\s*(?:sheet|page|row))\b/i;

const INTERNAL_PHRASES = [
  /catalogue[-\s]*derived(?:\s+product)?(?:\s+line)?/gi,
  /catalog[-\s]*derived(?:\s+product)?(?:\s+line)?/gi,
  /confirm\s+exact\s+item/gi,
  /catalogue\s+details?(?:\s+row\s*\d+)?/gi,
  /catalog\s+details?(?:\s+row\s*\d+)?/gi,
  /internal\s+(?:match\s+)?confidence(?:\s*[:=]?\s*\d+(?:\.\d+)?%?)?/gi,
  /internal\s+(?:sourcing\s+)?(?:rationale|notes?|review\s+warnings?|extraction\s+commentary)/gi,
  /ogs\s+catalogue(?:\s+(?:url|link|reference|ref|id))?/gi,
  /source\s*[:=]\s*(?:sheet|page|row)\s*[^\s,.;]+/gi,
];

/** Placeholder markers the document readers add while preserving provenance. */
const PROVENANCE_MARKER =
  /\[\s*(?:page\s+\d+|[^\]]{1,40}\s+row\s+\d+)\s*\]\s*$/i;

const DATABASE_IDENTIFIER =
  /\b(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export function hasProductEvidence(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length < 3) return false;
  if (PRODUCT_NOUN.test(value)) return true;
  // A part number on its own is still a product request when it follows a
  // product head such as "spare part ABC-123" or an explicit part-number label.
  if (/\b(?:part\s*(?:no|number)|p\/n|model)\b/i.test(value) && FASTENER_PART.test(value)) return true;
  return false;
}

export function isClearlyNonProductText(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (GREETING.test(value)) return true;
  if (SIGNATURE.test(value)) return true;
  if (hasProductEvidence(value)) return false;
  if (URGENCY.test(value)) return true;
  if (DELIVERY_TIMEFRAME.test(value)) return true;
  if (INSTRUCTION_START.test(value)) return true;
  if (COMMERCIAL.test(value)) return true;
  if (CERTIFICATION.test(value)) return true;
  if (INTERNAL_NOTE.test(value)) return true;
  if (TECHNICAL_LABEL.test(value) && value.split(/\s+/).length <= 12) return true;
  // A short fragment of specifications with no product name is context, not a
  // product line ("0.5in - MS", "ASTM A105 Class 150").
  if (value.split(/\s+/).length <= 10 && /\b(?:\d+(?:\.\d+)?\s*(?:in|inch|mm)|\d+\/\d+|sch\s*\d+|class\s*\d+|astm\s*[a-z]\d+|ss\s*\d{3}|ms|ss316l?)\b/i.test(value)) {
    return true;
  }
  if (!hasProductEvidence(value) && value.split(/\s+/).length <= 6) return true;
  return false;
}

export function classifySegment(text: string): SegmentKind {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return "IRRELEVANT";
  if (GREETING.test(value)) return "GREETING";
  if (SIGNATURE.test(value)) return "SIGNATURE";
  if (hasProductEvidence(value)) return "PRODUCT";
  if (URGENCY.test(value) && !DELIVERY_TIMEFRAME.test(value)) return "URGENCY";
  if (DELIVERY_TIMEFRAME.test(value)) return "DELIVERY_TIMEFRAME";
  if (DELIVERY_LOCATION.test(value)) return "DELIVERY_LOCATION";
  if (COMMERCIAL.test(value)) return "COMMERCIAL_REQUIREMENT";
  if (INSTRUCTION_START.test(value) || /\b(?:please|kindly|confirm|advise|process|arrange|ensure)\b/i.test(value)) {
    return "CUSTOMER_INSTRUCTION";
  }
  if (CERTIFICATION.test(value)) return "CUSTOMER_INSTRUCTION";
  if (TECHNICAL_LABEL.test(value) || /\b(?:astm|ansi|asme|din|iso|bs|en)\s*[a-z]?\d+/i.test(value)) {
    return "TECHNICAL_SPECIFICATION";
  }
  return "NOTE";
}

/** Splits a message into lines/sentences, keeping provenance on each segment. */
export function segmentText(text: string, sourceRef: string): TextSegment[] {
  const blocks = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/\n/))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const kind =
      PROVENANCE_MARKER.test(block) && hasProductEvidence(block) ? "PRODUCT" : classifySegment(block);
    return { kind, text: block, sourceRef };
  });
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match ? match[0].replace(/\s+/g, " ").trim().slice(0, 160) : null;
}

export function extractCustomerContext(input: {
  subject?: string | null;
  body: string;
  documents?: Array<{ filename: string; text: string }>;
}): CustomerContext {
  const fullBody = input.body ?? "";
  const allText = [input.subject ?? "", fullBody, ...(input.documents ?? []).map((doc) => doc.text)]
    .join("\n")
    .replace(/\u0000/g, "");

  const lines = fullBody
    .replace(/\r/g, "")
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const greetingLine = lines.find((line) => GREETING.test(line)) ?? null;
  const urgency = firstMatch(allText, URGENCY);
  const timeframe = DELIVERY_TIMEFRAME.test(allText) ? firstMatch(allText, DELIVERY_DURATION) : null;
  const locationMatch = allText.match(DELIVERY_LOCATION);
  const deliveryLocation = (locationMatch?.[1] ?? locationMatch?.[2] ?? null)?.trim() ?? null;

  const instructions: string[] = [];
  const commercialRequirements: string[] = [];
  const certifications: string[] = [];
  const notes: string[] = [];

  for (const line of lines) {
    if (GREETING.test(line) || SIGNATURE.test(line)) continue;
    if (hasProductEvidence(line)) continue;
    if (DELIVERY_TIMEFRAME.test(line) && line.split(/\s+/).length <= 12) continue;
    if (CERTIFICATION.test(line)) {
      certifications.push(line.slice(0, 160));
      continue;
    }
    if (COMMERCIAL.test(line)) {
      commercialRequirements.push(line.slice(0, 200));
      continue;
    }
    if (INSTRUCTION_START.test(line) || /\b(?:please|kindly|confirm|advise|process|arrange|ensure)\b/i.test(line)) {
      instructions.push(line.slice(0, 240));
      continue;
    }
    if (line.length > 2) notes.push(line.slice(0, 240));
  }

  const certFromText = firstMatch(allText, CERTIFICATION);
  if (certFromText && !certifications.some((entry) => entry.toLowerCase().includes(certFromText.toLowerCase()))) {
    certifications.push(certFromText);
  }

  return {
    greeting: greetingLine?.slice(0, 120) ?? null,
    urgency,
    requestedDeliveryTimeframe: timeframe,
    deliveryLocation,
    instructions: dedupeStrings(instructions).slice(0, 8),
    commercialRequirements: dedupeStrings(commercialRequirements).slice(0, 8),
    certifications: dedupeStrings(certifications).slice(0, 8),
    notes: dedupeStrings(notes).slice(0, 6),
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Removes internal-only wording from any supplier-facing description. */
export function stripInternalWording(text: string): string {
  let value = text.replace(/\u0000/g, " ");
  for (const pattern of INTERNAL_PHRASES) value = value.replace(pattern, " ");
  value = value.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  value = value.replace(PROVENANCE_MARKER, " ");
  value = value.replace(/\b(?:row|line)\s+\d+\b/gi, " ");
  value = value.replace(DATABASE_IDENTIFIER, " ");
  return value
    .replace(/\s*[-–—|:]\s*(?:$|[,;])/g, " ")
    .replace(/\(\s*[,;]?\s*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.|\-–—]+|[\s,;:.|\-–—]+$/g, "")
    .trim();
}

export function containsInternalWording(text: string): boolean {
  return INTERNAL_NOTE.test(text) || INTERNAL_PHRASES.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function containsMalformedUnit(text: string): boolean {
  // Valid: "90 pcs", "2.5 m", "120 kg". Malformed: a dangling unit with no
  // quantity ("pcs" on its own) or two units glued together ("pcs - kg").
  const value = text.trim();
  if (/\b(?:pcs|kg|set|box)\s*[-–—/:]\s*(?:pcs|kg|set|box)\b/i.test(value)) return true;
  if (/(?:^|\s)(?:pcs|kgs?|sets?|boxes?)(?:\s*[,;]|\s*$)/i.test(value) && !/\d/.test(value)) return true;
  return false;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "these", "items", "item", "please", "pls",
  "kindly", "need", "needs", "needed", "require", "required", "requirement", "urgent", "urgently",
  "quote", "quotation", "supply", "provide", "send", "confirm", "pcs", "pc", "pieces", "nos", "each",
  "of", "to", "in", "on", "a", "an", "is", "are", "be", "as", "at", "by", "or", "our", "your", "we",
  "i", "you", "it", "all", "new", "type", "size",
]);

const DESCRIPTION_SYNONYMS: Record<string, string> = {
  elbows: "elbow",
  elbow: "elbow",
  flanges: "flange",
  flange: "flange",
  valves: "valve",
  valve: "valve",
  pipes: "pipe",
  pipe: "pipe",
  fittings: "fitting",
  fitting: "fitting",
  gaskets: "gasket",
  gasket: "gasket",
  tees: "tee",
  tee: "tee",
  reducers: "reducer",
  reducer: "reducer",
  couplings: "coupling",
  coupling: "coupling",
  nipples: "nipple",
  nipple: "nipple",
  bolts: "bolt",
  bolt: "bolt",
  nuts: "nut",
  nut: "nut",
  washers: "washer",
  washer: "washer",
  bearings: "bearing",
  bearing: "bearing",
  spares: "spare",
  spare: "spare",
  parts: "part",
  part: "part",
  stainless: "ss",
};

export function normalizeDescriptionForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/[^a-z0-9./\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => DESCRIPTION_SYNONYMS[token] ?? token)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity of the source document, ignoring page/row detail. */
export function sourceDocumentIdentity(sourceRef: string | null | undefined): string {
  const value = (sourceRef ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (/^(?:message|email|body|customer message)/i.test(value)) return "email_body";
  return value
    .replace(/\s*(?:[·|]\s*)?(?:page|sheet|row|line)\s*[\w-]+.*$/i, "")
    .replace(/\s*\[[^\]]*\]\s*$/i, "")
    .trim() || value;
}

/**
 * Stable identity of a requested line, used both for cross-source dedupe and
 * for merging a later attachment into an existing enquiry. Quantity is part of
 * the identity so two genuinely separate requests are never merged.
 */
export function itemDedupeKey(item: {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
}): string {
  const quantity = item.quantity != null && item.quantity > 0 ? String(item.quantity) : "";
  return [
    normalizeDescriptionForComparison(item.description),
    quantity,
    (item.unit ?? "").toLowerCase().trim(),
    normalizeDescriptionForComparison(item.size ?? ""),
    normalizeDescriptionForComparison(item.material ?? ""),
    normalizeDescriptionForComparison(item.grade ?? ""),
    normalizeDescriptionForComparison(item.pressureRating ?? ""),
    normalizeDescriptionForComparison(item.schedule ?? ""),
    normalizeDescriptionForComparison(item.standard ?? ""),
  ].join("|");
}

/**
 * Removes a product repeated across the email body and its attachments while
 * keeping genuinely separate lines in the same document. Two identical rows in
 * one worksheet remain two requested lines; the same row repeated in the body
 * and in the attachment is one request.
 */
export function dedupeExtractedItems<T extends ExtractedItem>(items: T[]): T[] {
  const kept: Array<{ item: T; signature: string; document: string }> = [];
  for (const item of items) {
    const signature = itemDedupeKey(item);
    const document = sourceDocumentIdentity(item.sourceRef);
    const duplicate = kept.find((entry) => {
      if (entry.signature !== signature) return false;
      if (entry.document !== document) return true;
      return (entry.item.sourceRef ?? "") === (item.sourceRef ?? "");
    });
    if (!duplicate) {
      kept.push({ item, signature, document });
      continue;
    }
    // Keep every piece of evidence, but do not create a second RFQ line.
    const mergedEvidence = dedupeEvidence([...(duplicate.item.evidence ?? []), ...(item.evidence ?? [])]);
    if (mergedEvidence.length > 0) duplicate.item.evidence = mergedEvidence;
    if (!duplicate.item.sourceRef && item.sourceRef) duplicate.item.sourceRef = item.sourceRef;
  }
  return kept.map((entry) => entry.item);
}

function dedupeEvidence(evidence: NonNullable<ExtractedItem["evidence"]>): NonNullable<ExtractedItem["evidence"]> {
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = `${entry.field}|${entry.value}|${entry.sourceRef}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
