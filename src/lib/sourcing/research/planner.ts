import { z } from "zod";
import { aiStatus, completeJson, DATA_ONLY_RULE, type AIUsageSnapshot } from "../../ai/provider";
import { expandAbbreviations, sizeToMm } from "../../catalog/normalize";
import { inferCategoryFromDescription } from "../../catalog/categories";
import {
  isServiceCategory,
  isServiceDescription,
  parseIndustrialSpecJson,
  schemaFor,
} from "../../catalog/industrialSpec";
import { parseFastenerSpecJson } from "../../fasteners/spec";
import { parseJson } from "../../json";
import {
  ResearchPlanSchema,
  ResearchQuerySchema,
  type QueryCategory,
  type ResearchPlan,
  type ResearchProductUnderstanding,
  type ResearchQuery,
} from "../../validation/research";

type PlannerItem = {
  id: string;
  enquiryId: string;
  description: string;
  category: string | null;
  brand: string | null;
  size: string | null;
  material: string | null;
  grade: string | null;
  pressureRating: string | null;
  schedule: string | null;
  standard: string | null;
  quantity: number;
  quantityToSource?: number;
  unit: string;
  missingFields: string;
  industrialSpecJson: string | null;
  fastenerSpecJson: string | null;
  enquiry?: {
    deliveryLocation?: string | null;
    requestedDeliveryTimeframe?: string | null;
    urgency?: string | null;
    customerContextJson?: string | null;
  } | null;
};

type PlannerContext = {
  location?: string | null;
  deliveryLocation?: string | null;
  deliveryTimeframe?: string | null;
  certifications?: string[];
  maxQueries?: number;
};

const FAMILY_TERMS: Array<{ match: RegExp; family: string; terms: string[]; arabic?: string }> = [
  { match: /\belbows?\b/i, family: "Elbow", terms: ["elbow", "long radius elbow", "90 degree elbow", "butt weld elbow"], arabic: "كوع" },
  { match: /\btees?\b/i, family: "Tee", terms: ["tee", "equal tee", "butt weld tee"], arabic: "تي" },
  { match: /\breducers?\b/i, family: "Reducer", terms: ["reducer", "concentric reducer", "eccentric reducer"], arabic: "مخفض" },
  { match: /\bcouplings?\b/i, family: "Coupling", terms: ["coupling", "socket weld coupling", "pipe coupling"], arabic: "وصلة" },
  { match: /\bflanges?\b/i, family: "Flange", terms: ["flange", "weld neck flange", "raised face flange"], arabic: "فلنجة" },
  { match: /\bvalves?\b/i, family: "Valve", terms: ["valve", "industrial valve", "gate valve", "ball valve"], arabic: "صمام" },
  { match: /\bpipes?\b/i, family: "Pipe", terms: ["pipe", "seamless pipe", "steel pipe"], arabic: "أنبوب" },
  { match: /\bgaskets?\b/i, family: "Gasket", terms: ["gasket", "spiral wound gasket", "ring joint gasket"], arabic: "حشية" },
  { match: /\bbolts?\b/i, family: "Bolt", terms: ["bolt", "hex bolt", "stud bolt"], arabic: "برغي" },
  { match: /\bnuts?\b/i, family: "Nut", terms: ["nut", "hex nut"], arabic: "صامولة" },
  { match: /\bwashers?\b/i, family: "Washer", terms: ["washer", "flat washer"], arabic: "حلقة" },
  { match: /\bbearings?\b/i, family: "Bearing", terms: ["bearing", "industrial bearing"], arabic: "محمل" },
  { match: /\bseals?\b/i, family: "Seal", terms: ["mechanical seal", "seal kit"], arabic: "ختم" },
  { match: /\bpumps?\b/i, family: "Pump", terms: ["pump", "industrial pump"], arabic: "مضخة" },
  { match: /\bchemicals?\b/i, family: "Chemical", terms: ["chemical", "industrial chemical"] },
  { match: /\bcaustic\b/i, family: "Caustic soda", terms: ["caustic soda", "sodium hydroxide"] },
];

const UAE_REGIONS = ["UAE", "Dubai", "Sharjah", "Abu Dhabi"];

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  const cleaned = clean(value);
  return cleaned ? cleaned.slice(0, max) : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const cleaned = clean(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

/** Keeps the query focused but never drops a requested technical attribute. */
function dedupeWords(value: string): string {
  const seen = new Map<string, number>();
  const words: string[] = [];
  for (const word of value.replace(/\s+/g, " ").trim().split(" ")) {
    if (!word) continue;
    const key = word.toLowerCase();
    const existing = seen.get(key);
    if (existing != null) {
      // Prefer the extracted field's casing (Carbon Steel) over the same words
      // lower-cased inside a free-text description. Search is case-insensitive;
      // this only keeps the displayed query readable and faithful to the field.
      if (/^[A-Z]/.test(word) && /^[a-z]/.test(words[existing] ?? "")) words[existing] = word;
      continue;
    }
    seen.set(key, words.length);
    words.push(word);
  }
  return words.join(" ");
}

function productFamily(item: PlannerItem): { family: string; terms: string[]; arabic?: string } {
  const text = `${item.description} ${item.category ?? ""}`;
  return FAMILY_TERMS.find((entry) => entry.match.test(text)) ?? {
    family: clean(item.category) ?? "Industrial product",
    terms: [clean(item.category) ?? "industrial product"],
  };
}

function deliveryLocation(item: PlannerItem, context: PlannerContext): string | null {
  return clean(context.deliveryLocation) ?? clean(item.enquiry?.deliveryLocation) ?? clean(context.location);
}

function regionTerms(location: string | null): string[] {
  const value = (location ?? "").toUpperCase();
  if (/\b(UAE|UNITED ARAB EMIRATES|DUBAI|SHARJAH|ABU DHABI)\b/.test(value)) return UAE_REGIONS;
  return location ? [location] : [];
}

/** Arabic-language supplier material is relevant to the Gulf, not to every market. */
function arabicRegionRelevant(location: string | null): boolean {
  const value = (location ?? "").toUpperCase();
  return /\b(UAE|UNITED ARAB EMIRATES|DUBAI|SHARJAH|ABU DHABI|SAUDI|RIYADH|JEDDAH|QATAR|DOHA|OMAN|MUSCAT|KUWAIT|BAHRAIN|MANAMA|GULF|MIDDLE EAST)\b/.test(
    value,
  );
}

function specText(item: PlannerItem): string {
  return unique([
    item.size,
    item.material,
    item.grade,
    item.schedule,
    item.pressureRating,
    item.standard,
    item.brand,
  ]).join(" ");
}

function requiredFieldSet(item: PlannerItem): Set<string> {
  const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
  if (industrial) {
    return new Set(
      (schemaFor(industrial.category) ?? [])
        .filter((attribute) => attribute.required)
        .map((attribute) => attribute.key),
    );
  }
  const category = inferCategoryFromDescription(`${item.description} ${item.category ?? ""}`);
  return new Set(category?.required ?? []);
}

function fieldValue(item: PlannerItem, key: string): string | null {
  const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
  if (industrial?.attributes[key]) return clean(industrial.attributes[key]);
  const fastener = parseFastenerSpecJson(item.fastenerSpecJson);
  if (fastener) {
    const map: Record<string, string | null | undefined> = {
      diameter: fastener.diameter,
      threadSeries: fastener.threadSeries,
      lengthMm: fastener.lengthMm != null ? String(fastener.lengthMm) : null,
      propertyClass: fastener.propertyClass,
      finish: fastener.finish,
      material: fastener.material,
      grade: fastener.propertyClass,
      standard: fastener.standard,
      size: fastener.diameter,
      brand: item.brand,
    };
    if (map[key]) return clean(map[key]);
  }
  const map: Record<string, string | null> = {
    size: item.size,
    nominalSize: item.size,
    material: item.material,
    bodyMaterial: item.material,
    grade: item.grade,
    pressureRating: item.pressureRating,
    pressureClass: item.pressureRating,
    schedule: item.schedule,
    standard: item.standard,
    brand: item.brand,
    manufacturer: item.brand,
    valveType: productFamily(item).family,
    fittingType: productFamily(item).family,
    flangeType: productFamily(item).family,
    gasketType: productFamily(item).family,
  };
  return clean(map[key]);
}

function labelsForCategory(item: PlannerItem): Array<{ key: string; label: string; required: boolean }> {
  const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
  const schema = industrial ? schemaFor(industrial.category) : null;
  if (schema) return schema.map((attribute) => ({ key: attribute.key, label: attribute.label, required: attribute.required }));
  const category = inferCategoryFromDescription(`${item.description} ${item.category ?? ""}`);
  const labels: Record<string, string> = {
    size: "Size",
    material: "Material",
    grade: "Grade",
    pressureRating: "Pressure rating",
    schedule: "Schedule",
    standard: "Standard",
    typeVariant: "Product type",
    brand: "Brand",
  };
  return (category?.required ?? []).map((key) => ({ key, label: labels[key] ?? key, required: true }));
}

export function deriveProductUnderstanding(item: PlannerItem, context: PlannerContext = {}): ResearchProductUnderstanding {
  const family = productFamily(item);
  const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
  const required = requiredFieldSet(item);
  const fields = labelsForCategory(item);
  const missingFromExtraction = new Set(parseJson<string[]>(item.missingFields, []));
  const mandatory = fields
    .filter((field) => field.required && (fieldValue(item, field.key) || required.has(field.key)))
    .map((field) => field.label);
  const mandatoryPresent = fields
    .filter((field) => field.required && fieldValue(item, field.key))
    .map((field) => field.label);
  const optional = fields.filter((field) => !field.required).map((field) => field.label);
  const unknown = unique(
    fields
      .filter((field) => field.required && !fieldValue(item, field.key))
      .map((field) => field.label),
  );
  for (const missing of missingFromExtraction) {
    if (!mandatoryPresent.includes(missing) && !unknown.includes(missing)) unknown.push(missing);
  }

  const delivery = deliveryLocation(item, context);
  return {
    productFamily: bounded(family.family, 120),
    productName: bounded(item.description, 240) ?? bounded(family.family, 240) ?? "Industrial product",
    commonTerminology: unique(family.terms).map((term) => term.slice(0, 80)),
    material: bounded(item.material, 100) ?? bounded(industrial?.attributes.material, 100),
    grade: bounded(item.grade, 80) ?? bounded(industrial?.attributes.grade, 80),
    manufacturingStandard: bounded(item.standard, 120) ?? bounded(industrial?.attributes.standard, 120),
    dimensions: bounded(industrial?.attributes.dimensions, 160) ?? bounded(industrial?.attributes.outsideDiameter, 160),
    diameter: bounded(item.size, 80) ?? bounded(industrial?.attributes.nominalSize, 80),
    scheduleOrWallThickness:
      bounded(item.schedule, 80) ??
      bounded(industrial?.attributes.schedule, 80) ??
      bounded(industrial?.attributes.wallThickness, 80),
    pressureClass:
      bounded(item.pressureRating, 80) ??
      bounded(industrial?.attributes.pressureClass, 80) ??
      bounded(industrial?.attributes.pressureRating, 80),
    connectionType: bounded(industrial?.attributes.connection, 80) ?? bounded(industrial?.attributes.endConnection, 80),
    finish: bounded(industrial?.attributes.finish, 80) ?? bounded(industrial?.attributes.coating, 80),
    brand: bounded(item.brand, 100) ?? bounded(industrial?.attributes.manufacturer, 100),
    quantity: item.quantityToSource ?? item.quantity,
    unit: bounded(item.unit, 24) ?? "pcs",
    deliveryLocation: bounded(delivery, 200),
    deliveryTimeframe:
      bounded(context.deliveryTimeframe, 160) ??
      bounded(item.enquiry?.requestedDeliveryTimeframe, 160) ??
      bounded(item.enquiry?.urgency, 160),
    certifications: unique(context.certifications ?? []).map((entry) => entry.slice(0, 120)),
    mandatorySpecifications: unique(mandatory),
    optionalSpecifications: unique(optional),
    unknownSpecifications: unique(unknown),
    alternativesRequiringReview: [],
  };
}

function addQuery(
  list: ResearchQuery[],
  seen: Set<string>,
  input: {
    query: string;
    productTarget: string;
    objective: string;
    requiredEvidence: string;
    category: QueryCategory;
    reason: string;
    location?: string | null;
  },
): void {
  const query = dedupeWords(input.query).slice(0, 300);
  const key = query.toLowerCase();
  if (query.length < 3 || seen.has(key)) return;
  seen.add(key);
  list.push(
    ResearchQuerySchema.parse({
      query,
      productTarget: input.productTarget.slice(0, 160) || "Industrial product",
      objective: input.objective.slice(0, 240),
      location: bounded(input.location, 120),
      requiredEvidence: input.requiredEvidence.slice(0, 240),
      category: input.category,
      reason: input.reason.slice(0, 240),
    }),
  );
}

/**
 * Builds a structured plan from the already-extracted RFQ line. It deliberately
 * does not "understand" the product from scratch: the semantic extraction is
 * the source of truth. Unknown attributes stay unknown; they are never filled
 * in to make a query look more precise.
 */
export function buildResearchPlan(item: PlannerItem, context: PlannerContext = {}): ResearchPlan {
  if (isServiceCategory(item.category) || isServiceDescription(item.description)) {
    throw new Error("Services are not sourced as products; research was not started.");
  }
  const product = deriveProductUnderstanding(item, context);
  const family = productFamily(item);
  const spec = specText(item);
  // Put the extracted specification fields first so their canonical notation
  // survives when the free-text description repeats the same words (for example
  // "schedule 40" in the description and "SCH 40" in the schedule field).
  const core = dedupeWords(`${spec} ${product.productName}`);
  const target = product.productName;
  const location = product.deliveryLocation;
  const queries: ResearchQuery[] = [];
  const seen = new Set<string>();

  addQuery(queries, seen, {
    query: `${core} supplier`,
    productTarget: target,
    objective: "Find a supplier listing for the exact requested specification.",
    requiredEvidence: "Product page or datasheet showing the requested specification.",
    category: "EXACT_SPECIFICATION",
    reason: "The exact RFQ wording and all extracted attributes are the strongest discovery signal.",
    location,
  });

  const expanded = expandAbbreviations(core);
  if (expanded !== core) {
    addQuery(queries, seen, {
      query: expanded,
      productTarget: target,
      objective: "Find suppliers that use the expanded industrial terminology.",
      requiredEvidence: "Product evidence using expanded terms while retaining the requested attributes.",
      category: "COMMON_TERMINOLOGY",
      reason: "Supplier catalogues often use the full form of an abbreviation.",
      location,
    });
  }

  addQuery(queries, seen, {
    query: `${family.terms[0]} ${spec} supplier`,
    productTarget: target,
    objective: "Broaden discovery to the product family without losing the critical specification.",
    requiredEvidence: "At least one comparable technical attribute.",
    category: "PRODUCT_CATEGORY",
    reason: "A family term reaches category pages that do not repeat the customer's full description.",
    location,
  });

  for (const term of family.terms.slice(1, 3)) {
    addQuery(queries, seen, {
      query: `${term} ${spec}`,
      productTarget: target,
      objective: `Find suppliers using the common term “${term}”.`,
      requiredEvidence: "Comparable size/material/standard evidence.",
      category: "ALTERNATIVE",
      reason: "Industrial terminology varies by region and supplier.",
      location,
    });
  }

  if (item.standard) {
    addQuery(queries, seen, {
      query: `${family.terms[0]} ${item.standard} manufacturer catalogue`,
      productTarget: target,
      objective: "Find manufacturers and technical catalogues for the requested standard.",
      requiredEvidence: "Published product or catalogue evidence for the requested standard.",
      category: "TECHNICAL_STANDARD",
      reason: "The manufacturing standard is a critical technical attribute.",
      location,
    });
  }

  if (item.brand) {
    addQuery(queries, seen, {
      query: `${item.brand} ${family.terms[0]} ${spec} distributor`,
      productTarget: target,
      objective: "Find an authorised distributor for the requested brand.",
      requiredEvidence: "Brand authorisation or brand-specific product evidence.",
      category: "MANUFACTURER",
      reason: "The customer named a brand; an unrelated equivalent is not the same request.",
      location,
    });
  }

  addQuery(queries, seen, {
    query: `${family.terms[0]} ${spec} manufacturer`,
    productTarget: target,
    objective: "Identify manufacturers rather than directories.",
    requiredEvidence: "Manufacturer identity and product evidence.",
    category: "MANUFACTURER",
    reason: "Manufacturers can confirm specifications even when local stock is unknown.",
    location,
  });

  addQuery(queries, seen, {
    query: `${family.terms[0]} ${spec} distributor stockist${location ? ` ${location}` : ""}`,
    productTarget: target,
    objective: "Identify distributors or stockists that serve the delivery region.",
    requiredEvidence: "Company product range and a serviceable location or contact.",
    category: "DISTRIBUTOR",
    reason: "A regional distributor is more actionable than an unrelated global directory.",
    location,
  });

  for (const region of regionTerms(location).slice(0, 3)) {
    addQuery(queries, seen, {
      query: `${family.terms[0]} ${item.material ?? ""} ${item.size ?? ""} supplier ${region}`,
      productTarget: target,
      objective: `Find suppliers serving ${region}.`,
      requiredEvidence: "Regional presence or delivery evidence.",
      category: "REGIONAL",
      reason: "Regional coverage affects lead time and delivery practicality.",
      location: region,
    });
  }

  addQuery(queries, seen, {
    query: `${family.terms[0]} ${spec} catalogue PDF datasheet`,
    productTarget: target,
    objective: "Find a downloadable product catalogue or technical datasheet.",
    requiredEvidence: "Catalogue or datasheet with product specifications.",
    category: "CATALOGUE",
    reason: "Catalogues contain the field-level technical evidence that snippets usually lack.",
    location,
  });

  if (family.arabic && arabicRegionRelevant(location)) {
    addQuery(queries, seen, {
      query: `${family.arabic} ${item.material ?? ""} ${item.size ?? ""} مورد الإمارات`,
      productTarget: target,
      objective: "Find Arabic-language supplier pages for the same product family.",
      requiredEvidence: "Arabic product page with comparable technical attributes.",
      category: "COMMON_TERMINOLOGY",
      reason: "Regional supplier material is often published in Arabic.",
      location,
    });
  }

  const mm = sizeToMm(item.size);
  if (mm != null && item.size) {
    addQuery(queries, seen, {
      query: `${core.replace(item.size, `${mm}mm`)} supplier`,
      productTarget: target,
      objective: "Find suppliers that publish the size in millimetres.",
      requiredEvidence: "Comparable size evidence in either unit.",
      category: "COMMON_TERMINOLOGY",
      reason: "Supplier catalogues mix inch and metric size notation.",
      location,
    });
  }

  if (product.unknownSpecifications.length > 0) {
    addQuery(queries, seen, {
      query: `${family.terms[0]} ${unique([item.material, item.size, item.standard]).join(" ")} ${product.unknownSpecifications.slice(0, 2).join(" ")}`,
      productTarget: target,
      objective: "Find catalogue pages that may disclose a specification missing from the RFQ.",
      requiredEvidence: "Published attribute values; missing information must not be invented.",
      category: "FOLLOW_UP",
      reason: "The RFQ has unresolved attributes; search for published values rather than assuming them.",
      location,
    });
  }

  const maxQueries = Math.max(1, Math.min(context.maxQueries ?? 20, 40));
  return ResearchPlanSchema.parse({
    enquiryId: item.enquiryId,
    enquiryItemId: item.id,
    product,
    queries: queries.slice(0, maxQueries),
    notes: product.unknownSpecifications.length
      ? [`Unresolved before research: ${product.unknownSpecifications.join(", ")}. These are gaps, not assumptions.`]
      : [],
    source: "DETERMINISTIC",
  });
}

export type FollowUpGap = {
  domain?: string | null;
  supplierName?: string | null;
  missing: string[];
  reason: string;
};

/**
 * Generates focused follow-up searches from evidence gaps. Every follow-up names
 * the gap and the expected evidence, and duplicate queries are rejected.
 */
export function planFollowUpQueries(input: {
  item: PlannerItem;
  plan: ResearchPlan;
  gaps: FollowUpGap[];
  existingQueries: string[];
  iteration: number;
}): ResearchQuery[] {
  const family = productFamily(input.item);
  const seen = new Set(input.existingQueries.map((query) => query.toLowerCase()));
  const queries: ResearchQuery[] = [];
  const spec = specText(input.item);
  const target = input.plan.product.productName;

  for (const gap of input.gaps) {
    const missing = unique(gap.missing).slice(0, 4);
    if (missing.length === 0) continue;
    const domain = clean(gap.domain);
    if (domain) {
      addQuery(queries, seen, {
        query: `site:${domain} ${family.terms[0]} ${spec}`,
        productTarget: target,
        objective: `Resolve missing ${missing.join(", ")} from this supplier's own website.`,
        requiredEvidence: `Published ${missing.join(", ").toLowerCase()} evidence on the supplier's website or catalogue.`,
        category: "FOLLOW_UP",
        reason: gap.reason,
        location: input.plan.product.deliveryLocation,
      });
      addQuery(queries, seen, {
        query: `site:${domain} catalogue PDF ${family.terms[0]}`,
        productTarget: target,
        objective: "Find a catalogue or datasheet that may contain the unresolved attributes.",
        requiredEvidence: "Catalogue/datasheet page with the missing attributes.",
        category: "CATALOGUE",
        reason: gap.reason,
        location: input.plan.product.deliveryLocation,
      });
    } else if (gap.supplierName) {
      addQuery(queries, seen, {
        query: `"${gap.supplierName}" ${family.terms[0]} ${missing.join(" ")}`,
        productTarget: target,
        objective: `Find independent evidence for ${missing.join(", ")}.`,
        requiredEvidence: "A published source corroborating the missing technical attributes.",
        category: "FOLLOW_UP",
        reason: gap.reason,
        location: input.plan.product.deliveryLocation,
      });
    }
  }

  return queries.slice(0, Math.max(1, 6));
}

const AiQuerySchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(3).max(300),
        category: z.enum([
          "EXACT_SPECIFICATION",
          "COMMON_TERMINOLOGY",
          "TECHNICAL_STANDARD",
          "MANUFACTURER",
          "DISTRIBUTOR",
          "REGIONAL",
          "CATALOGUE",
          "PRODUCT_CATEGORY",
          "ALTERNATIVE",
          "FOLLOW_UP",
        ]),
        objective: z.string().min(1).max(240),
        reason: z.string().min(1).max(240),
        requiredEvidence: z.string().min(1).max(240),
      }),
    )
    .max(12),
});

/**
 * Optional semantic planning pass. It can add up to eight focused queries, but
 * the deterministic plan is always present and the AI cannot remove a critical
 * attribute or raise the execution budget.
 */
export async function augmentPlanWithAi(
  plan: ResearchPlan,
  options: {
    maxAdditional?: number;
    enquiryId?: string | null;
    /** Called once an AI request is actually attempted, whether or not it succeeds. */
    onAttempt?: () => void;
    onUsage?: (usage: AIUsageSnapshot) => void;
  } = {},
): Promise<ResearchPlan> {
  if (!aiStatus().configured) return plan;
  const maxAdditional = Math.max(0, Math.min(options.maxAdditional ?? 8, 12));
  if (maxAdditional === 0) return plan;
  options.onAttempt?.();
  const result = await completeJson(
    {
      system:
        "You plan focused supplier-discovery searches for an industrial procurement RFQ. " +
        "You may only use the supplied product specification. Do not invent attributes, standards, brands, stock or supplier names. " +
        "Return queries that have a distinct research purpose: exact specification, common terminology, standard, manufacturer, distributor, region, catalogue/PDF, or category page. " +
        "Do not generate near-duplicates. Never remove or weaken a critical attribute. " +
        "Return JSON only: {\"queries\":[{\"query\":string,\"category\":\"EXACT_SPECIFICATION\"|\"COMMON_TERMINOLOGY\"|\"TECHNICAL_STANDARD\"|\"MANUFACTURER\"|\"DISTRIBUTOR\"|\"REGIONAL\"|\"CATALOGUE\"|\"PRODUCT_CATEGORY\"|\"ALTERNATIVE\"|\"FOLLOW_UP\",\"objective\":string,\"reason\":string,\"requiredEvidence\":string}]}. " +
        DATA_ONLY_RULE,
      user: `<rfq>${JSON.stringify(plan.product)}</rfq>`,
      maxTokens: 900,
      jobType: "sourcing.deep_research.plan",
      enquiryId: options.enquiryId ?? null,
    },
    AiQuerySchema,
  );
  if (result.ok && result.usage) options.onUsage?.(result.usage);
  if (!result.ok) return plan;
  const seen = new Set(plan.queries.map((query) => query.query.toLowerCase()));
  const extra: ResearchQuery[] = [];
  for (const entry of result.data.queries) {
    const key = entry.query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const parsed = ResearchQuerySchema.safeParse({
      ...entry,
      productTarget: plan.product.productName,
      location: plan.product.deliveryLocation,
    });
    if (parsed.success) extra.push(parsed.data);
    if (extra.length >= maxAdditional) break;
  }
  if (extra.length === 0) return plan;
  return { ...plan, queries: [...plan.queries, ...extra].slice(0, 40), source: "AI_ASSISTED" };
}

export { productFamily, specText, unique, clean };
export type { PlannerItem, PlannerContext };
