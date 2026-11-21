import {
  AIExtractionResponseSchema,
  type ExtractedItem,
  type ExtractionResult,
} from "../validation/extraction";
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

const HEADER_WORDS = /^(description|item|product|qty|quantity|unit|price|sr\.?|s\.?no|no\.?|total|amount)$/i;
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 2);

  const items: ItemDraft[] = [];
  for (const line of lines) {
    if (HEADER_WORDS.test(line)) continue;
    if (/^(dear|hi|hello|regards|thanks|please find|kindly|attached|subject|to|from|date)\b/i.test(line)) continue;

    let quantity: number | null = null;
    let unit: string | null = null;
    let description = "";

    const leading = line.match(
      /^(\d+(?:[.,]\d+)?)\s*(pcs?|pieces?|nos?|units?|sets?|kgs?|m|meters?|metres?|boxes?|box|rolls?|drums?|bags?|litres?|liters?|tonnes?|tons?)?\b[\s.:\-–—]*([A-Za-z][A-Za-z0-9'"./% -]*)$/i,
    );
    const trailing = line.match(
      /^([A-Za-z].*?)\s*[-–—:]\s*(\d+(?:[.,]\d+)?)\s*(pcs?|pieces?|nos?|units?|sets?|kgs?|m|boxes?|box|rolls?|drums?|bags?)?$/i,
    );

    if (leading) {
      const rest = leading[3].trim();
      const firstWord = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
      // "1 inch SS316 elbow" states a size, not a quantity.
      const looksLikeSize = /^(inch|inches|in|mm|dn|")$/.test(firstWord) || /^\d+\/\d+$/.test(firstWord);
      if (!looksLikeSize) {
        quantity = Number(leading[1].replace(",", ""));
        unit = leading[2] ?? null;
        description = rest;
      } else {
        description = line;
      }
    } else if (trailing) {
      quantity = Number(trailing[2].replace(",", ""));
      unit = trailing[3] ?? null;
      description = trailing[1];
    } else {
      // Real WhatsApp and email requests are prose: "Please quote 20 pcs SS316
      // elbow, 1 inch." The quantity sits mid-sentence, so it must be found
      // before the line is dismissed as narrative.
      const inline = line.match(
        /\b(\d+(?:[.,]\d+)?)\s*(pcs?|pieces?|nos?|units?|sets?|kgs?|meters?|metres?|m|boxes?|box|rolls?|litres?|liters?)\b\.?\s+([A-Za-z].*)$/i,
      );
      if (inline) {
        quantity = Number(inline[1].replace(",", ""));
        unit = inline[2];
        description = inline[3];
      } else {
        description = line;
      }
    }

    description = description
      .replace(/\s{2,}/g, " ")
      .replace(/^[-–—:.\s]+/, "")
      .replace(/[.;,]+$/, "")
      .trim();
    if (description.length < 3) continue;
    if (!/[a-z]/i.test(description)) continue;
    if (description.split(" ").length > 25) continue;
    // Narrative lines ("Please quote:", "Kindly advise") are not products.
    if (quantity == null && NARRATIVE_LINE.test(description)) continue;

    const attrs = extractAttributes(description);
    items.push({
      description,
      quantity: quantity && quantity > 0 ? quantity : null,
      unit: normalizeUnit(unit),
      ...attrs,
      sourceRef,
      missingFields: quantity && quantity > 0 ? [] : ["quantity"],
      confidence: {},
      clarificationQuestion: null,
    });
  }
  return items;
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
      size: normalizeSize(item.size) ?? item.size ?? extractAttributes(item.description).size,
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
            size: item.size,
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
        `<document index="${index + 1}" filename="${doc.filename}" kind="${doc.kind}">\n${doc.text.slice(0, 12000)}\n</document>`,
    )
    .join("\n\n");
}

export type ExtractionOutput = {
  extraction: ExtractionResult;
  items: ItemDraft[];
  source: "ai" | "rule";
  aiError?: string;
};

export async function extractEnquiry(
  input: ExtractionInput,
  options: { industrial?: boolean; allowAi?: boolean; secondPass?: boolean } = {},
): Promise<ExtractionOutput> {
  const documents = input.documents;
  const ruleItems = finalizeItems(
    [
      ...parseLineItems(input.text, "message"),
      ...documents.flatMap((doc) => parseLineItems(doc.text, `${doc.filename}`)),
    ],
    options,
  );

  // Nothing parseable must still become a reviewable line, never a silently
  // empty enquiry: the owner is asked for the quantity instead of the request
  // disappearing.
  if (ruleItems.length === 0 && input.text.trim()) {
    const fallback = finalizeItems([
      {
        description: input.text.replace(/\s+/g, " ").trim().slice(0, 240),
        quantity: null,
        unit: null,
        category: null,
        brand: null,
        size: null,
        material: null,
        grade: null,
        pressureRating: null,
        schedule: null,
        standard: null,
        otherSpecs: {},
        sourceRef: "message",
        missingFields: ["quantity"],
        confidence: {},
      },
    ], options);
    ruleItems.push(...fallback);
  }

  if (options.allowAi === false || !aiStatus().configured) {
    const unreadable = documents.filter((d) => d.unreadable).map((d) => d.filename);
    return {
      extraction: {
        isRfq: true,
        classification: "RFQ",
        classificationConfidence: 0.6,
        classificationReason: "Read with the built-in parser because no AI provider is connected.",
        items: ruleItems,
        unreadableParts: unreadable,
        notes: null,
      },
      items: ruleItems,
      source: "rule",
      aiError: options.allowAi === false ? "AI disabled for this evaluation run." : aiStatus().reason,
    };
  }

  const secondPassNote = options.secondPass
    ? " This is a verification pass: re-check every previously uncertain field against the source text and only fill values that are explicitly stated. "
    : "";
  const ai = await completeJson(
    {
      system:
        "You extract product line items from customer quotation requests for an industrial building materials trader in the UAE. " + secondPassNote +
        "Return JSON only matching this shape: {\"isRfq\":boolean,\"classification\":\"RFQ\"|\"AVAILABILITY\"|\"FOLLOW_UP\"|\"SUPPLIER\"|\"BUSINESS_OTHER\"|\"PERSONAL\"|\"UNCLEAR\",\"classificationConfidence\":0..1,\"classificationReason\":string," +
        "\"customerName\":string|null,\"customerPhone\":string|null,\"customerEmail\":string|null,\"deliveryLocation\":string|null,\"deliveryDate\":string|null,\"currency\":string|null," +
        "\"items\":[{\"description\":string,\"quantity\":number|null,\"unit\":string|null,\"category\":string|null,\"brand\":string|null,\"size\":string|null,\"material\":string|null,\"grade\":string|null,\"pressureRating\":string|null,\"schedule\":string|null,\"standard\":string|null,\"otherSpecs\":object,\"sourceRef\":string|null,\"missingFields\":string[],\"confidence\":object}]," +
        "\"notes\":string|null,\"unreadableParts\":string[]}. " +
        "Rules: extract only what the document states. Never invent sizes, materials, grades, ratings, quantities, brands, prices or delivery promises. " +
        "If a quantity is not stated, use null and add \"quantity\" to missingFields. If a description is generic (e.g. 'hammer', 'valve'), add the missing type detail to missingFields. " +
        "Keep the customer's wording in description; put recognized attributes in their own fields. " +
        "For each item, set sourceRef to the page number, sheet/row or message where it was found. " +
        "Give per-field confidence between 0 and 1. If part of a document cannot be read, list it in unreadableParts. " +
        DATA_ONLY_RULE,
      user: `<customer_message>\n${input.text.slice(0, 8000)}\n</customer_message>\n\n${documentBlock(documents)}`,
      maxTokens: 3500,
    },
    AIExtractionResponseSchema,
  );

  if (!ai.ok) {
    return {
      extraction: {
        isRfq: true,
        classification: "RFQ",
        classificationConfidence: 0.5,
        classificationReason: "AI extraction unavailable; built-in parser used. Please review.",
        items: ruleItems,
        unreadableParts: documents.filter((d) => d.unreadable).map((d) => d.filename),
        notes: null,
      },
      items: ruleItems,
      source: "rule",
      aiError: ai.error,
    };
  }

  const items = finalizeItems(ai.data.items ?? [], options);
  return { extraction: ai.data, items, source: "ai" };
}
