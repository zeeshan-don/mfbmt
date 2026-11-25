import {
  AIExtractionResponseSchema,
  type CustomerContext,
  type ExtractedItem,
  type ExtractionResult,
} from "../validation/extraction";
import { createHash } from "node:crypto";
import {
  dedupeExtractedItems,
  extractCustomerContext,
  hasProductEvidence,
  isClearlyNonProductText,
} from "./segmentation";
import { env } from "../env";
import { completeJson, aiStatus, DATA_ONLY_RULE } from "./provider";
import { inferCategoryFromDescription, ATTRIBUTE_LABELS, type AttributeKey } from "../catalog/categories";
import { isFastenerCategory, missingFastenerFields, parseFastenerSpec } from "../fasteners/spec";
import {
  buildIndustrialSpec,
  extractIndustrialAttributes,
  industrialClarificationQuestion,
  resolveIndustrialCategory,
  type IndustrialSpec,
} from "../catalog/industrialSpec";
import {
  normalizeGrade,
  normalizeMaterial,
  normalizePressure,
  normalizeSchedule,
  normalizeSize,
  normalizeUnit,
} from "../catalog/normalize";

export type SourceDocument = {
  filename: string;
  kind: "pdf" | "excel" | "image" | "text" | "other";
  text: string;
  pageCount?: number | null;
  unreadable?: boolean;
  /** Per-page text, so an extracted line can cite "<file> page 3". */
  pages?: Array<{ page: number; text: string; ocr?: boolean }>;
  /** Page renders or the photo itself, for the vision model. */
  images?: string[];
};

export type ExtractionInput = {
  text: string;
  subject?: string | null;
  documents: SourceDocument[];
};

export type ItemDraft = Omit<ExtractedItem, "industrialSpec"> & {
  clarificationQuestion: string | null;
  missingFields: string[];
  /** Set only when industrial schemas are enabled for the organization. */
  industrialSpec?: IndustrialSpec | null;
};

const NARRATIVE_LINE =
  /^(please|pls|kindly|quote|quotation|rfq|request(ing)?|regards|thanks|thank you|dear|hi|hello|subject|urgent|asap|attached|delivery|we need|we require|need|required)\b/i;

function extractAttributes(description: string) {
  const size =
    description.match(/\b(?:dn\s*\d+|\d+(?:\.\d+)?\s*(?:inch|in|"|mm)|\d+\/\d+\s*(?:inch|in|")?)\b/i)?.[0] ?? null;
  const material =
    description.match(/\b(?:ss\s*-?\s*(?:316l?|304l?)|stainless\s*steel\s*(?:316l?|304l?)|ss\s*(?:304|316)|mild\s*steel|carbon\s*steel|galvanized|pvc|upvc|ppr|hdpe|brass|cast\s*iron|ductile\s*iron|copper)\b/i)?.[0] ??
    null;
  const grade = description.match(/\b(?:gr\.?\s*[0-9.]+\s*[a-z]?|8\.8|10\.9|12\.9|a2-70|a4-70|a4-80)\b/i)?.[0] ?? null;
  const pressureRating = description.match(/\b(?:class\s*\d+|pn\s*\d+|\d+\s*(?:bar|psi))\b/i)?.[0] ?? null;
  const schedule = description.match(/\b(?:sch\s*-?\s*\d+|schedule\s*\d+)\b/i)?.[0] ?? null;
  const standard = description.match(/\b(?:asme\s*b16\.\d+|ansi\s*b16\.\d+|astm\s*a\d+|din\s*\d+|bs\s*\d+|en\s*\d+)\b/i)?.[0] ?? null;
  return { size, material, grade, pressureRating, schedule, standard };
}

/** Rule-based line item parsing. Runs without an AI provider; lower confidence. */
export function parseLineItems(text: string, sourceRef: string): ItemDraft[] {
  const segments = splitProductSegments(text);
  const items: ItemDraft[] = [];
  for (const segment of segments) {
    const parsed = parseQuantityAndDescription(segment);
    const quantity = parsed.quantity;
    const unit = parsed.unit;
    let description = cleanProductDescription(parsed.description)
      .replace(/\s{2,}/g, " ")
      .replace(/\[[^\]]*row\s+\d+\]\s*$/i, "")
      .replace(/^[-–—:.,\s]+/, "")
      .replace(/[.;,]+$/, "")
      .trim();
    if (description.length < 3) continue;
    if (!/[a-z]/i.test(description)) continue;
    if (/^sheet\s*:/i.test(description)) continue;
    if (description.split(" ").length > 40) description = description.split(" ").slice(0, 40).join(" ");
    // A product needs evidence of an actual item. Greetings, "I need these
    // urgently in 3 days", signatures and loose specification fragments are
    // retained as enquiry context, never as RFQ lines.
    if (!hasProductEvidence(description) || isClearlyNonProductText(description)) continue;

    const attrs = extractAttributes(description);
    items.push({
      description,
      quantity: quantity && quantity > 0 ? quantity : null,
      unit: normalizeUnit(unit),
      ...attrs,
      sourceRef,
      evidence: [
        { field: "description", value: description, sourceRef, quote: segment.slice(0, 300) },
        ...(quantity && quantity > 0
          ? [{ field: "quantity", value: String(quantity), sourceRef, quote: segment.slice(0, 300) }]
          : []),
        ...(["size", "material", "grade", "pressureRating", "schedule", "standard"] as const)
          .filter((field) => Boolean(attrs[field]))
          .map((field) => ({
            field,
            value: String(attrs[field]),
            sourceRef,
            quote: segment.slice(0, 300),
          })),
      ],
      missingFields: quantity && quantity > 0 ? [] : ["quantity"],
      confidence: {},
      clarificationQuestion: null,
    });
  }
  return items;
}

function stripLeadingConnectors(value: string): string {
  return value
    .replace(/^(?:\d{1,3}[.)]\s+)/, "")
    .replace(/^(we need|required|please quote|kindly quote|quote|also quote|and quote|pls quote)\b[\s,:-]*/i, "")
    .trim();
}

function isNarrativeSentence(value: string): boolean {
  const trimmed = value.trim();
  return /^(dear|hi|hello|regards|thanks|thank you|please find|kindly|attached|subject|to|from|date|please quote|pls quote|quote)\b/i.test(trimmed) || NARRATIVE_LINE.test(trimmed);
}

function isSpecContinuation(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/compatible with the (bolts?|nuts?|above)/i.test(trimmed)) return false;
  if (isNarrativeSentence(trimmed)) return false;
  if (/\b(din|iso|astm|ss\d|stainless|metric|thread|pitch|finish|plain|zinc|class|grade|a[24]|material|hex|bolt|nut|washer)\b/i.test(trimmed)) return true;
  return trimmed.split(/\s+/).length <= 6;
}

function splitProductSegments(text: string): string[] {
  const sentences = text
    .replace(/\r?\n/g, ". ")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

  const segments: string[][] = [];
  let current: string[] | null = null;
  for (const sentence of sentences) {
    const candidate = stripLeadingConnectors(sentence);
    const quantity = parseLeadingQuantity(candidate);
    if (quantity) {
      if (current) segments.push(current);
      current = [sentence];
    } else if (current && isSpecContinuation(sentence)) {
      current.push(sentence);
    } else if (!current && !isNarrativeSentence(sentence)) {
      current = [sentence];
    }
  }
  if (current) segments.push(current);

  const chunks = segments
    .map((parts) => parts.join(" ").replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length > 2);
  return chunks.length > 0 ? chunks : [text.replace(/\s+/g, " ").trim()];
}

function parseLeadingQuantity(value: string): { quantity: number; unit: string | null } | null {
  const leading = value.match(/^(\d[\d,\.]*)\s*(pieces?|pcs?|nos?|units?|sets?|kgs?|m|meters?|metres?|boxes?|box|rolls?|drums?|bags?|litres?|liters?|tonnes?|tons?)?\b[\s.:,\-��]*(.*)$/i);
  if (!leading) return null;
  const rest = leading[3].trim();
  const firstWord = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
  const looksLikeSize = /^(inch|inches|in|mm|dn|")$/.test(firstWord) || /^\d+\/\d+$/.test(firstWord);
  if (looksLikeSize) return null;
  const quantity = Number(leading[1].replace(/,/g, ""));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity, unit: leading[2] ?? null };
}

function parseQuantityAndDescription(chunk: string): { quantity: number | null; unit: string | null; description: string } {
  const text = stripLeadingConnectors(chunk.replace(/\s+/g, " ").trim());
  const leading = parseLeadingQuantity(text);
  if (leading) {
    const match = text.match(/^(\d[\d,\.]*)\s*(pieces?|pcs?|nos?|units?|sets?|kgs?|m|meters?|metres?|boxes?|box|rolls?|drums?|bags?|litres?|liters?|tonnes?|tons?)?\b[\s.:,\-–—]*(.*)$/i);
    const description = match ? match[3].trim() : text;
    return { quantity: leading.quantity, unit: leading.unit, description: description.replace(/^of\s+/i, "") };
  }

  // A quantity can appear anywhere in a row ("Elbow ... 90 pcs"). Keep the
  // product wording on whichever side of the quantity has product evidence;
  // never take a trailing header/footer as the product description.
  const unitQuantity = text.match(
    /\b(\d[\d,\.]*)\s*(pieces?|pcs?|nos?|units?|sets?|kgs?|meters?|metres?|m|boxes?|box|rolls?|drums?|bags?|litres?|liters?)\b/i,
  );
  if (unitQuantity && unitQuantity.index != null) {
    const quantity = Number(unitQuantity[1].replace(/,/g, ""));
    const before = text.slice(0, unitQuantity.index).replace(/[\s,;|/–—-]+$/g, "").trim();
    const after = text
      .slice(unitQuantity.index + unitQuantity[0].length)
      .replace(/^[.,;:|/–—-]+\s*/g, "")
      .trim();
    const description = hasProductEvidence(before)
      ? before
      : hasProductEvidence(after)
        ? after
        : `${before} ${after}`.trim();
    return { quantity, unit: unitQuantity[2], description };
  }

  return { quantity: null, unit: null, description: text };
}

/** Removes OCR/email furniture that occasionally surrounds a genuine row. */
function cleanProductDescription(value: string): string {
  return value
    .replace(/\*{2,}[^*]{0,120}\*{2,}/g, " ")
    .replace(/\bpage\s+\d+\s+of\s+\d+\b/gi, " ")
    .replace(/\b(?:scanned|ocr|fax(?:ed)?)\s+(?:by|from)\b[^.;]{0,80}/gi, " ")
    .replace(/\bconfidential(?:\s+footer)?\b/gi, " ")
    .replace(/\b(?:header|footer)\s*[:=-]?[^.;]{0,60}/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.|\-–—]+|[\s,;:.|\-–—]+$/g, "")
    .trim();
}


function extractFastenerDimension(description: string): string | null {
  const match = description.match(/\bM\s*\d+(?:\.\d+)?(?:\s*[x×X]\s*\d+(?:\.\d+)?\s*mm)?\b/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

function categoryFor(item: ExtractedItem) {
  const byDescription = inferCategoryFromDescription(item.description);
  const byName = item.category ? inferCategoryFromDescription(item.category) : null;
  return byDescription ?? byName;
}

/**
 * Applies deterministic normalization and computes what is missing.
 *
 * `industrial` is opt-in per organization. It enables the OGS industrial
 * schemas without changing MFBMT's existing generic category requirements or
 * its versioned fastener matcher.
 */
export function finalizeItems(items: ExtractedItem[], options: { industrial?: boolean } = {}): ItemDraft[] {
  return items.map((item) => {
    const category = categoryFor(item);
    const fastenerCategory = isFastenerCategory(category?.name) || isFastenerCategory(item.category);
    // Only enabled for an INDUSTRIAL organization. The industrial schema, not
    // the generic category list, then decides which attributes are required.
    const industrialCategory =
      options.industrial && !fastenerCategory
        ? resolveIndustrialCategory(item.category) ??
          // A generic rule such as "Stainless Steel Fittings" can be a false
          // positive from the SS316 token. The customer's description is the
          // stronger industrial signal.
          resolveIndustrialCategory(item.description) ??
          resolveIndustrialCategory(category?.name)
        : null;
    const normalized: ExtractedItem = {
      ...item,
      description: item.description.trim().replace(/\s{2,}/g, " "),
      unit: normalizeUnit(item.unit),
      size: fastenerCategory
        ? (extractFastenerDimension(item.description) ?? item.size)
        : normalizeSize(item.size) ?? item.size ?? extractAttributes(item.description).size,
      material: normalizeMaterial(item.material) ?? normalizeMaterial(extractAttributes(item.description).material),
      grade: normalizeGrade(item.grade ?? extractAttributes(item.description).grade),
      pressureRating: normalizePressure(item.pressureRating ?? extractAttributes(item.description).pressureRating),
      schedule: normalizeSchedule(item.schedule ?? extractAttributes(item.description).schedule),
      standard: (item.standard ?? extractAttributes(item.description).standard)?.toUpperCase() ?? null,
      category: category?.name ?? item.category ?? "Other Industrial Supplies",
      otherSpecs: item.otherSpecs ?? {},
      fastenerSpec: fastenerCategory
        ? (item.fastenerSpec ??
          parseFastenerSpec({
            description: item.description,
            size: extractFastenerDimension(item.description) ?? item.size,
            material: item.material,
            grade: item.grade,
            standard: item.standard,
            rawText: item.description,
          }))
        : item.fastenerSpec,
    };

    // For fasteners only the structured requirements decide what is missing; stale
    // generic extraction labels must not linger once the field is known.
    const missing = new Set<string>(fastenerCategory ? [] : (item.missingFields ?? []));
    if (normalized.quantity == null || !(normalized.quantity > 0)) missing.add("quantity");
    if (normalized.quantity != null && !normalized.unit) missing.add("unit");

    if (fastenerCategory && normalized.fastenerSpec) {
      // Fasteners have their own required attributes. Generic size/material/grade
      // labels are replaced so the owner sees the exact missing engineering field.
      for (const field of missingFastenerFields(normalized.fastenerSpec)) missing.add(field);
    } else if (category && !industrialCategory) {
      for (const key of category.required) {
        if (!attributeValue(normalized, key)) missing.add(ATTRIBUTE_LABELS[key]);
      }
      if (category.variantRequired && !hasVariantDetail(normalized)) {
        missing.add(ATTRIBUTE_LABELS.typeVariant);
      }
    }

    // OGS industrial schemas are deterministic: the AI may interpret the
    // source, but only the schema decides which attributes are required.
    let industrialSpec: IndustrialSpec | null = null;
    if (industrialCategory) {
      normalized.category = industrialCategory;
      if (true) {
        industrialSpec = buildIndustrialSpec(
          industrialCategory,
          extractIndustrialAttributes(industrialCategory, {
            description: normalized.description,
            size: normalized.size,
            material: normalized.material,
            grade: normalized.grade,
            pressureRating: normalized.pressureRating,
            schedule: normalized.schedule,
            standard: normalized.standard,
            brand: normalized.brand,
            quantity: normalized.quantity,
            unit: normalized.unit,
            otherSpecs: normalized.otherSpecs,
          }),
          { confidence: normalized.confidence ?? {} },
        );
        for (const label of industrialSpec.missingRequired) {
          // Avoid duplicate labels that differ only by case ("Size" vs "size").
          const exists = [...missing].some((entry) => entry.toLowerCase() === label.toLowerCase());
          if (!exists) missing.add(label);
        }
      }
    }

    const quantityMissing = normalized.quantity == null || !(normalized.quantity > 0);
    return {
      ...normalized,
      missingFields: [...missing],
      industrialSpec,
      clarificationQuestion:
        industrialSpec && !quantityMissing
          ? industrialClarificationQuestion(industrialSpec, normalized.description) ??
            buildClarificationQuestion(normalized, [...missing])
          : buildClarificationQuestion(normalized, [...missing]),
    };
  });
}

function attributeValue(item: ExtractedItem, key: AttributeKey): string | null {
  if (key === "typeVariant") {
    const fromSpecs = item.otherSpecs?.typeVariant;
    return fromSpecs ?? (hasVariantDetail(item) ? item.description : null);
  }
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function hasVariantDetail(item: ExtractedItem): boolean {
  if (item.otherSpecs?.typeVariant) return true;
  const tokens = item.description.toLowerCase().split(/\s+/).filter(Boolean);
  const generic = ["hammer", "valve", "gasket", "tool", "fitting", "flange", "coupling", "hose"];
  const words = tokens.filter((t) => !["the", "of", "for", "and", "pcs", "nos", "inch", "mm"].includes(t));
  if (words.length <= 1) return false;
  // "industrial valves" or "SS valves" describe no type: they are still generic.
  const genericWords = words.slice(0, 2).map((word) => singular(word));
  const onlyGeneric = genericWords.some((word) => generic.includes(word));
  if (onlyGeneric && words.length <= 2) return false;
  return words.length >= 2;
}

function singular(noun: string): string {
  const word = noun.toLowerCase();
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses") || word.endsWith("shes") || word.endsWith("ches")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function buildClarificationQuestion(item: ExtractedItem, missing: string[]): string | null {
  if (missing.length === 0) return null;
  const name = item.description.split(/\s+/).slice(0, 4).join(" ");
  if (missing.includes("quantity")) return `What quantity of ${name} is required?`;
  const labels = missing.filter((m) => m !== "quantity");
  if (labels.length === 0) return null;
  const head = singular(item.description.split(/\s+/)[0] ?? "product");
  const typeMissing = labels.includes(ATTRIBUTE_LABELS.typeVariant);
  if (typeMissing) {
    const others = labels.filter((label) => label !== ATTRIBUTE_LABELS.typeVariant);
    return others.length > 0
      ? `Which ${head} type is required? Please also confirm the ${others.map((label) => label.toLowerCase()).join(", ")}.`
      : `Which ${head} type is required?`;
  }
  return `Please confirm the ${labels.map((label) => label.toLowerCase()).join(", ")} for ${name}.`;
}

function documentBlock(documents: SourceDocument[]): string {
  return documents
    .map(
      (doc, index) =>
        `<document index="${index + 1}" filename="${doc.filename}" kind="${doc.kind}" unreadable="${Boolean(doc.unreadable)}">\n${doc.text.slice(0, 30000)}\n</document>`,
    )
    .join("\n\n");
}

/**
 * Splits a document into the smallest unit that still carries provenance.
 * A PDF page keeps its page number; a worksheet row keeps its sheet and row;
 * anything else falls back to the filename. This is what allows an RFQ line to
 * say where its description, quantity and grade came from.
 */
export function sourceBlocks(doc: SourceDocument): Array<{ text: string; sourceRef: string }> {
  if (doc.pages && doc.pages.length > 0) {
    return doc.pages
      .filter((page) => page.text.trim().length > 0)
      .map((page) => ({
        text: page.text,
        sourceRef: `${doc.filename} page ${page.page}${page.ocr ? " (OCR)" : ""}`,
      }));
  }

  if (/\[page\s+\d+\]/i.test(doc.text)) {
    const blocks: Array<{ text: string; sourceRef: string }> = [];
    const parts = doc.text.split(/\[page\s+(\d+)\]/i);
    // split() yields [before, number, text, number, text, ...].
    for (let index = 1; index < parts.length; index += 2) {
      const page = parts[index];
      const text = (parts[index + 1] ?? "").trim();
      if (text) blocks.push({ text, sourceRef: `${doc.filename} page ${page}` });
    }
    if (blocks.length > 0) return blocks;
  }

  const rowLines = doc.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\[[^\]]*row\s+\d+\]/i.test(line));
  if (rowLines.length > 0) {
    return rowLines.map((line) => {
      const marker = line.match(/\[([^\]]*row\s+\d+)\]/i)?.[1]?.trim() ?? "row";
      return {
        text: line.replace(/\[[^\]]*row\s+\d+\]\s*$/i, "").trim(),
        sourceRef: `${doc.filename} · ${marker}`,
      };
    });
  }

  return [{ text: doc.text, sourceRef: doc.filename }];
}

function mergeCustomerContext(ai: CustomerContext | undefined, deterministic: CustomerContext): CustomerContext {
  const union = (a: string[] | undefined, b: string[]) =>
    [...new Set([...(a ?? []), ...b].map((value) => value.trim()).filter(Boolean))].slice(0, 10);
  return {
    greeting: ai?.greeting?.trim() || deterministic.greeting,
    urgency: ai?.urgency?.trim() || deterministic.urgency,
    requestedDeliveryTimeframe:
      ai?.requestedDeliveryTimeframe?.trim() || deterministic.requestedDeliveryTimeframe,
    deliveryLocation: ai?.deliveryLocation?.trim() || deterministic.deliveryLocation,
    instructions: union(ai?.instructions, deterministic.instructions),
    commercialRequirements: union(ai?.commercialRequirements, deterministic.commercialRequirements),
    certifications: union(ai?.certifications, deterministic.certifications),
    notes: union(ai?.notes, deterministic.notes),
  };
}

function sanitizeAiItems(items: ExtractedItem[], context: CustomerContext): ExtractedItem[] {
  const kept: ExtractedItem[] = [];
  for (const item of items) {
    const description = item.description.replace(/\s+/g, " ").trim();
    if (!description) continue;
    const sourceRef = item.sourceRef?.trim() || "Email body";
    if (!hasProductEvidence(description) || isClearlyNonProductText(description)) {
      // Never silently lose the text: it stays as enquiry context and asks for
      // review instead of becoming a fake product line.
      context.notes = [...new Set([...context.notes, description.slice(0, 240)])].slice(0, 8);
      continue;
    }
    const evidence = item.evidence?.length
      ? item.evidence
      : [
          { field: "description", value: description.slice(0, 300), sourceRef, quote: description.slice(0, 300) },
          ...(item.quantity != null && item.quantity > 0
            ? [{ field: "quantity", value: String(item.quantity), sourceRef }]
            : []),
        ];
    kept.push({ ...item, description, sourceRef, evidence });
  }
  return dedupeExtractedItems(kept);
}

function ruleItemsFor(input: ExtractionInput): ItemDraft[] {
  const raw: ItemDraft[] = [
    ...parseLineItems(input.subject ?? "", "Email subject"),
    ...parseLineItems(input.text, "Email body"),
    ...input.documents.flatMap((doc) =>
      sourceBlocks(doc).flatMap((block) => parseLineItems(block.text, block.sourceRef)),
    ),
  ];
  return dedupeExtractedItems(raw);
}

export type ExtractionOutput = {
  extraction: ExtractionResult;
  items: ItemDraft[];
  source: "ai" | "rule";
  aiError?: string;
};

/** Bump when the prompt or the deterministic filters change. */
export const EXTRACTION_PROMPT_VERSION = "2026-11-25.semantic.1";

/**
 * Safe in-process cache. Keyed by the exact inputs and prompt version, so an
 * unchanged workbook or email is not sent to a paid model again during a retry
 * or a second queue attempt. Only successful AI results are cached.
 */
const extractionCache = new Map<string, ExtractionOutput>();
const EXTRACTION_CACHE_LIMIT = 50;

function extractionCacheKey(input: ExtractionInput, options: { industrial?: boolean; secondPass?: boolean }): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        EXTRACTION_PROMPT_VERSION,
        options.industrial ? "industrial" : "general",
        options.secondPass ? "second" : "first",
        input.subject ?? "",
        input.text,
        input.documents.map((doc) => [doc.filename, doc.kind, doc.text, doc.pages ?? []]),
      ]),
    )
    .digest("hex");
}

function readExtractionCache(key: string): ExtractionOutput | null {
  const hit = extractionCache.get(key);
  if (!hit) return null;
  return {
    ...hit,
    extraction: JSON.parse(JSON.stringify(hit.extraction)) as ExtractionResult,
    items: JSON.parse(JSON.stringify(hit.items)) as ItemDraft[],
  };
}

function writeExtractionCache(key: string, output: ExtractionOutput): void {
  if (output.source !== "ai") return;
  if (extractionCache.size >= EXTRACTION_CACHE_LIMIT) {
    const oldest = extractionCache.keys().next().value;
    if (oldest) extractionCache.delete(oldest);
  }
  extractionCache.set(key, output);
}

export async function extractEnquiry(
  input: ExtractionInput,
  options: { industrial?: boolean; allowAi?: boolean; secondPass?: boolean } = {},
): Promise<ExtractionOutput> {
  const documents = input.documents;
  const deterministicContext = extractCustomerContext({
    subject: input.subject ?? null,
    body: input.text,
    documents: documents.map((doc) => ({ filename: doc.filename, text: doc.text })),
  });
  const cacheKey = extractionCacheKey(input, options);
  const cached = readExtractionCache(cacheKey);
  if (cached) return cached;

  const ruleRaw = ruleItemsFor(input);
  // Dedupe again after normalization: "0.5 inch" and "0.5in" are the same
  // requested line, but their source rows still decide whether they are truly
  // repeated or two separate rows in the same document.
  const ruleItems = dedupeExtractedItems(finalizeItems(ruleRaw, options));

  if (options.allowAi === false || !aiStatus().configured) {
    const unreadable = documents.filter((d) => d.unreadable).map((d) => d.filename);
    const output: ExtractionOutput = {
      extraction: {
        isRfq: true,
        classification: "RFQ",
        classificationConfidence: 0.6,
        classificationReason: "Read with the built-in parser because no AI provider is connected.",
        customerContext: deterministicContext,
        items: ruleItems,
        unreadableParts: unreadable,
        notes:
          ruleItems.length === 0 && (input.text.trim() || documents.some((doc) => doc.text.trim()))
            ? "The built-in parser found no product line. The message text is kept as enquiry context and needs review; nothing was created as a product."
            : null,
      },
      items: ruleItems,
      source: "rule",
      aiError: options.allowAi === false ? "AI disabled for this evaluation run." : aiStatus().reason,
    };
    return output;
  }

  // Page renders and photos go to the vision model. OCR text remains in the
  // prompt so the model can compare both readings.
  const visionImages = documents.flatMap((doc) => doc.images ?? []).slice(0, 6);
  const visionModel = env.AI_VISION_MODEL.trim() || env.AI_MODEL;

  const secondPassNote = options.secondPass
    ? " This is a verification pass: re-check every previously uncertain field against the source text and only fill values that are explicitly stated. "
    : "";
  const aiRequest = (images: string[] | undefined) => ({
    system:
      "You interpret a customer quotation request for an industrial building-materials trader in the UAE. The request may include an email body and attachments. " +
      "First segment the content semantically. Then return products only where the text provides evidence of an actual requested item. " +
      secondPassNote +
      "Return JSON only matching this shape: {\"isRfq\":boolean,\"classification\":\"RFQ\"|\"AVAILABILITY\"|\"FOLLOW_UP\"|\"SUPPLIER\"|\"BUSINESS_OTHER\"|\"PERSONAL\"|\"UNCLEAR\",\"classificationConfidence\":0..1,\"classificationReason\":string," +
      "\"customerName\":string|null,\"customerPhone\":string|null,\"customerEmail\":string|null,\"deliveryLocation\":string|null,\"deliveryDate\":string|null,\"currency\":string|null," +
      "\"customerContext\":{\"greeting\":string|null,\"urgency\":string|null,\"requestedDeliveryTimeframe\":string|null,\"deliveryLocation\":string|null,\"instructions\":string[],\"commercialRequirements\":string[],\"certifications\":string[],\"notes\":string[]}," +
      "\"items\":[{\"description\":string,\"quantity\":number|null,\"unit\":string|null,\"category\":string|null,\"brand\":string|null,\"size\":string|null,\"material\":string|null,\"grade\":string|null,\"pressureRating\":string|null,\"schedule\":string|null,\"standard\":string|null,\"otherSpecs\":object,\"sourceRef\":string|null,\"evidence\":[{\"field\":string,\"value\":string,\"sourceRef\":string,\"quote\":string}],\"missingFields\":string[],\"confidence\":object}]," +
      "\"notes\":string|null,\"unreadableParts\":string[]}. " +
      "Segmentation rules: a greeting ('Hi', 'Dear supplier') is communication context, never a product. 'Please process this urgently' is an instruction. 'Need delivery within 3 days' is a requested delivery timeframe, not a product and not a supplier lead time. 'Please confirm availability' is communication context. Payment, validity, MOQ and shipping terms are commercial requirements. Signatures and disclaimers are not products. " +
      "A product requires evidence of an actual requested item: a product family noun (elbow, valve, flange, pipe, gasket, fastener, chemical, spare part, tool, etc.), a part number attached to a product, and normally a quantity. A standalone technical specification (for example 'ASTM A105, 0.5in, MS') is context, not a separate product. A product heading with specifications and quantity is one product. " +
      "Read the email body and every attachment together. Do not discard the body when an attachment exists: the body may contain products, urgency, delivery dates, certifications or shipping instructions, while the attachment may contain the item table. Genuine products in the body must still be extracted. " +
      "Deduplicate the same product repeated in the body, a pasted document and attachments. Do not merge genuinely separate row items whose quantities, specifications or source positions differ. " +
      "For each item set sourceRef to 'Email body', '<filename> page N', '<filename> · <sheet> row N', or '<filename> image'. Record evidence for each field (description, quantity, unit, size, material, grade, pressureRating, schedule, standard, brand) with field, value, sourceRef and a short quote from the source. " +
      "Extract only what the source states. Never invent sizes, materials, grades, ratings, quantities, brands, prices or delivery promises; never convert the customer's stated units. If a quantity is not stated use null and add 'quantity' to missingFields. If a description is generic (e.g. 'hammer', 'valve'), add the missing type detail to missingFields. " +
      "For fasteners, populate type, size, material, grade, standard and, when stated, thread/pitch and length. Each distinct product specification must become its own item. Keep the customer's wording in description; put recognized attributes in their own fields. Give per-field confidence between 0 and 1. If part of a document cannot be read, list it in unreadableParts. " +
      DATA_ONLY_RULE,
    user:
      `<email_subject>${(input.subject ?? "").slice(0, 500)}</email_subject>\n` +
      `<customer_message>\n${input.text.slice(0, 12000)}\n</customer_message>\n\n` +
      `<attachments>\n${documentBlock(documents)}\n</attachments>`,
    maxTokens: 4000,
    model: images?.length ? visionModel : undefined,
    images,
    jobType: "extraction.enquiry",
  });
  let ai = await completeJson(aiRequest(visionImages), AIExtractionResponseSchema);
  if (!ai.ok && visionImages.length > 0) {
    // Vision is best-effort: a model without image support still reads the text.
    ai = await completeJson(aiRequest(undefined), AIExtractionResponseSchema);
  }

  if (!ai.ok) {
    const output: ExtractionOutput = {
      extraction: {
        isRfq: true,
        classification: "RFQ",
        classificationConfidence: 0.5,
        classificationReason: "AI extraction unavailable; built-in parser used. Please review.",
        customerContext: deterministicContext,
        items: ruleItems,
        unreadableParts: documents.filter((d) => d.unreadable).map((d) => d.filename),
        notes: null,
      },
      items: ruleItems,
      source: "rule",
      aiError: ai.error,
    };
    return output;
  }

  const customerContext = mergeCustomerContext(ai.data.customerContext, deterministicContext);
  const sanitizedItems = sanitizeAiItems(ai.data.items ?? [], customerContext);
  const items = dedupeExtractedItems(finalizeItems(sanitizedItems, options));
  if (items.length === 0 && ruleItems.length > 0) {
    // A greeting or an unusual layout can make the model return an empty list.
    // Keep the deterministically parsed lines instead of showing an empty enquiry.
    const output: ExtractionOutput = {
      extraction: { ...ai.data, customerContext, items: ruleItems },
      items: ruleItems,
      source: "rule",
      aiError: "The AI returned no product lines; the built-in parser was used.",
    };
    return output;
  }

  const output: ExtractionOutput = {
    extraction: {
      ...ai.data,
      customerContext,
      items,
      notes:
        ai.data.notes ??
        (items.length === 0 && (input.text.trim() || documents.some((doc) => doc.text.trim()))
          ? "No product line was identified. The email text is retained as context and needs review; nothing was created as a product."
          : null),
    },
    items,
    source: "ai",
  };
  writeExtractionCache(cacheKey, output);
  return output;
}
