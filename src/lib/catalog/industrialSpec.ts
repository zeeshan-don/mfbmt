import { z } from "zod";
import { normalizeMaterial, normalizePressure, normalizeSchedule, normalizeSize, sizeToMm } from "./normalize";

/**
 * Configurable industrial product specifications for OGS.
 *
 * These schemas are data, not code paths: a category lists the attributes that
 * must be present before a product can be called an exact match. Fasteners keep
 * their separate, versioned deterministic matcher (src/lib/fasteners/spec.ts),
 * so adding industrial categories never changes MFBMT's fastener behaviour.
 */

export type IndustrialCategory =
  | "Pipes"
  | "Valves"
  | "Flanges"
  | "Fittings"
  | "Gaskets"
  | "Insulation Kits"
  | "Chemicals"
  | "Industrial Spares"
  | "Services";

export type IndustrialAttribute = {
  key: string;
  label: string;
  required: boolean;
  /** Numeric attributes are compared with unit-aware normalisation. */
  numeric?: boolean;
  aliases?: string[];
};

export const INDUSTRIAL_SCHEMAS: Record<IndustrialCategory, IndustrialAttribute[]> = {
  Pipes: [
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "nominalSize", label: "Nominal size", required: true },
    { key: "outsideDiameter", label: "Outside diameter", required: true, numeric: true },
    { key: "wallThickness", label: "Wall thickness", required: true, numeric: true },
    { key: "schedule", label: "Schedule", required: true },
    { key: "length", label: "Length", required: false },
    { key: "manufacturingType", label: "Manufacturing type", required: false },
    { key: "standard", label: "Standard", required: true },
    { key: "endPreparation", label: "End preparation", required: true },
    { key: "coating", label: "Coating", required: false },
    { key: "certification", label: "Certification", required: false },
    { key: "lengthBasis", label: "Sold by metre/length", required: false },
    { key: "serviceCondition", label: "NACE / sour service", required: false },
  ],
  Valves: [
    { key: "valveType", label: "Valve type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "pressureClass", label: "Pressure class", required: true },
    { key: "endConnection", label: "End connection", required: true },
    { key: "bodyMaterial", label: "Body material", required: true },
    { key: "trimMaterial", label: "Trim material", required: true },
    { key: "operation", label: "Operation type", required: true },
    { key: "standard", label: "Applicable standard", required: true },
    { key: "testing", label: "Testing / certification", required: false },
  ],
  Flanges: [
    { key: "flangeType", label: "Flange type", required: true },
    { key: "nominalSize", label: "Nominal size", required: true },
    { key: "pressureClass", label: "Pressure class", required: true },
    { key: "facing", label: "Facing", required: true },
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "standard", label: "Standard", required: true },
    { key: "dimensions", label: "Dimensions", required: false },
  ],
  Fittings: [
    { key: "fittingType", label: "Fitting type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "schedule", label: "Schedule", required: true },
    { key: "material", label: "Material", required: true },
    { key: "grade", label: "Grade", required: true },
    { key: "connection", label: "Connection type", required: true },
    { key: "standard", label: "Standard", required: true },
    { key: "serviceCondition", label: "NACE / sour service", required: false },
  ],
  Gaskets: [
    { key: "gasketType", label: "Gasket type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "pressureClass", label: "Pressure class", required: true },
    { key: "material", label: "Material", required: true },
    { key: "filler", label: "Filler material", required: false },
    { key: "standard", label: "Standard", required: true },
  ],
  "Insulation Kits": [
    { key: "kitType", label: "Insulation kit type", required: true },
    { key: "size", label: "Size", required: true },
    { key: "pressureClass", label: "Pressure class", required: false },
    { key: "material", label: "Insulation material", required: true },
    { key: "standard", label: "Standard", required: false },
  ],
  Chemicals: [
    { key: "productName", label: "Product name", required: true },
    { key: "manufacturer", label: "Manufacturer", required: false },
    { key: "casNumber", label: "CAS number", required: false },
    { key: "chemicalGrade", label: "Chemical grade", required: true },
    { key: "purity", label: "Purity / concentration", required: true },
    { key: "physicalForm", label: "Physical form", required: true },
    { key: "packaging", label: "Packaging", required: true },
    { key: "quantity", label: "Quantity", required: true, numeric: true },
    { key: "unit", label: "Unit", required: true },
    { key: "sds", label: "SDS / MSDS", required: false },
    { key: "coa", label: "Certificate of Analysis", required: false },
    { key: "hazardClass", label: "Hazardous-material details", required: false },
  ],
  "Industrial Spares": [
    { key: "manufacturer", label: "Manufacturer", required: true },
    { key: "partNumber", label: "Part number", required: true },
    { key: "model", label: "Model", required: false },
    { key: "compatibleEquipment", label: "Compatible equipment", required: true },
    { key: "specifications", label: "Specifications", required: true },
    { key: "documentation", label: "Documentation", required: false },
  ],
  /** Services are deliberately not products: they require manual quoting. */
  Services: [
    { key: "serviceType", label: "Service type", required: true },
    { key: "scope", label: "Scope of work", required: true },
    { key: "standard", label: "Applicable standard / procedure", required: false },
    { key: "turnaround", label: "Required turnaround", required: false },
  ],
};

const CATEGORY_ALIASES: Array<{ match: RegExp; category: IndustrialCategory }> = [
  // Specific product families win over the generic "pipe"/"spares" words.
  { match: /\bgasket|\bspiral\s*wound|\bring\s*(?:joint|type)|\bsheet\s*gasket|\bmetal\s*jacketed/i, category: "Gaskets" },
  { match: /\binsulation\s*(?:kit|set|blanket|jacket)|\bcladding\s*kit/i, category: "Insulation Kits" },
  { match: /\bservices?\b|\bmachining|\bhydro\s*test|\bhydrotest|\bplating|\bndt\b|\bnon[\s-]*destructive|\bpmi\b|\bpositive\s*material|\bpassivation|\bwelding\s*service/i, category: "Services" },
  { match: /\bfitting|\belbow|\btee\b|\breducer|\bcoupling/i, category: "Fittings" },
  { match: /\bpipes?\b/i, category: "Pipes" },
  { match: /\bvalve/i, category: "Valves" },
  { match: /\bflange/i, category: "Flanges" },
  { match: /\bchemical|\bsolvent|\bacids?\b|\bcaustic/i, category: "Chemicals" },
  { match: /\bspares?\b|\bspare parts?|\bbearings?\b|\bseals?\b/i, category: "Industrial Spares" },
];

const SERVICE_WORK = /\b(machining|hydro\s*test|hydrotest|plating|ndt|non[\s-]*destructive\s*testing|pmi|positive\s*material\s*identification|passivation|welding\s*service)\b/i;

export function isServiceDescription(description: string | null | undefined): boolean {
  return SERVICE_WORK.test(description ?? "");
}

export function isServiceCategory(category: string | null | undefined): boolean {
  return resolveIndustrialCategory(category) === "Services" || /\bservices?\b/i.test(category ?? "");
}

export function resolveIndustrialCategory(category: string | null | undefined): IndustrialCategory | null {
  if (!category) return null;
  for (const alias of CATEGORY_ALIASES) {
    if (alias.match.test(category)) return alias.category;
  }
  return null;
}

export function schemaFor(category: string | null | undefined): IndustrialAttribute[] | null {
  const resolved = resolveIndustrialCategory(category);
  return resolved ? INDUSTRIAL_SCHEMAS[resolved] : null;
}

export function requiredAttributes(category: string | null | undefined): IndustrialAttribute[] {
  return (schemaFor(category) ?? []).filter((attribute) => attribute.required);
}

export const INDUSTRIAL_SPEC_VERSION = 1 as const;

export const IndustrialSpecSchema = z.object({
  version: z.literal(INDUSTRIAL_SPEC_VERSION),
  category: z.enum(["Pipes", "Valves", "Flanges", "Fittings", "Gaskets", "Insulation Kits", "Chemicals", "Industrial Spares", "Services"]),
  attributes: z.record(z.string(), z.string()),
  missingRequired: z.array(z.string()).default([]),
  missingOptional: z.array(z.string()).default([]),
  confidence: z.record(z.number().min(0).max(1)).default({}),
  source: z.enum(["EXTRACTED", "MANUAL", "SUPPLIER_CONFIRMED"]).default("EXTRACTED"),
});
export type IndustrialSpec = z.infer<typeof IndustrialSpecSchema>;

export function parseIndustrialSpecJson(raw: string | null | undefined): IndustrialSpec | null {
  if (!raw) return null;
  try {
    const parsed = IndustrialSpecSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type IndustrialMatchStatus = "EXACT" | "EQUIVALENT" | "INSUFFICIENT" | "NO_MATCH";

export type IndustrialMatch = {
  status: IndustrialMatchStatus;
  reasons: string[];
  mismatches: string[];
  missing: string[];
  usedEquivalence: boolean;
};

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function sameValue(attribute: IndustrialAttribute, requested: string, offered: string): boolean {
  if (attribute.numeric) {
    const requestedMm = sizeToMm(requested);
    const offeredMm = sizeToMm(offered);
    if (requestedMm != null && offeredMm != null) return Math.abs(requestedMm - offeredMm) < 0.01;
    const a = Number(requested.replace(/[^0-9.]+/g, ""));
    const b = Number(offered.replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  switch (attribute.key) {
    case "size":
      return (normalizeSize(requested) ?? "").toUpperCase() === (normalizeSize(offered) ?? "").toUpperCase();
    case "schedule":
      return normalizeSchedule(requested) === normalizeSchedule(offered);
    case "pressureClass":
      return normalizePressure(requested) === normalizePressure(offered);
    case "material":
    case "bodyMaterial":
    case "trimMaterial":
      return normalizeMaterial(requested) === normalizeMaterial(offered);
    default:
      return requested.replace(/\s+/g, " ").toUpperCase() === offered.replace(/\s+/g, " ").toUpperCase();
  }
}

/**
 * Deterministic comparison. A cheap incompatible product can never be promoted
 * by price: a conflict on a required attribute is NO_MATCH, and absent required
 * information is INSUFFICIENT. Approving a material substitution requires an
 * explicit equivalence rule.
 */
/**
 * Deterministic attribute extraction. Only values stated in the customer's text
 * or fields are recorded; nothing is invented. Unrecognised attributes stay
 * absent so `buildIndustrialSpec` can report them as missing.
 */
function capture(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1]?.trim() ?? null;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim().replace(/\s{2,}/g, " ");
  return trimmed.length > 0 ? trimmed : undefined;
}

export type IndustrialAttributeInput = {
  description: string;
  extraText?: string | null;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
  brand?: string | null;
  quantity?: number | null;
  unit?: string | null;
  otherSpecs?: Record<string, string> | null;
};

/** Extracts the attributes a category schema asks for, when the source states them. */
export function extractIndustrialAttributes(
  category: IndustrialCategory,
  input: IndustrialAttributeInput,
): Record<string, string> {
  const text = `${input.description} ${input.extraText ?? ""}`.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const other = input.otherSpecs ?? {};
  const attrs: Record<string, string> = {};

  const size = clean(input.size) ?? text.match(/\b(?:nps\s*\d+(?:\.\d+)?|dn\s*\d+|\d+(?:\.\d+)?\s*(?:inch|in|"|mm)|\d+\/\d+(?:\s*(?:inch|in|"))?)\b/i)?.[0];
  const material = clean(input.material) ?? text.match(/\b(?:ss\s*-?\s*(?:316l?|304l?)|stainless\s*steel(?:\s*(?:316l?|304l?))?|carbon\s*steel|mild\s*steel|cast\s*iron|ductile\s*iron|copper|brass|pvc|upvc|ppr|hdpe|alloy\s*steel|monel|duplex|incoloy|inconel|graphite|ptfe|teflon)\b/i)?.[0];
  const grade = clean(input.grade) ?? text.match(/\b(?:uns\s*[a-z]\d{4,5}|gr\.?\s*[0-9a-z.]+|astm\s*a\d+(?:\s*(?:gr\.?|grade)\s*[a-z0-9]+)?|a\d{3}\s*(?:gr\.?|grade)?\s*[a-z]?|a194\s*(?:gr\.?|grade)?\s*(?:2hm?|8m?|7|4))\b/i)?.[0];
  const pressure = clean(input.pressureRating) ?? text.match(/\b(?:class\s*(?:150|300|400|600|900|1500|2500)|pn\s*\d+|\d+(?:\.\d+)?\s*(?:bar|psi))\b/i)?.[0];
  const schedule = clean(input.schedule) ?? text.match(/\b(?:sch\s*-?\s*\d+|schedule\s*\d+)\b/i)?.[0];
  const standard = clean(input.standard) ?? text.match(/\b(?:asme\s*[a-z]?\d+(?:\.\d+)?|ansi\s*[a-z]?\d+(?:\.\d+)?|astm\s*[a-z]\d+|api\s*\d+[a-z]?|din\s*\d+|bs\s*\d+|en\s*\d+|iso\s*\d+|nace\s*mr\d+)\b/i)?.[0];
  const brand = clean(input.brand) ?? clean(other.brand);

  const set = (key: string, value: string | null | undefined) => {
    const cleaned = clean(value);
    if (cleaned) attrs[key] = cleaned;
  };

  switch (category) {
    case "Pipes": {
      set("material", material);
      set("grade", grade);
      set("nominalSize", size);
      set("schedule", schedule);
      set("standard", standard);
      set("outsideDiameter", other.outsideDiameter ?? capture(text, /\b(?:od|outside\s*diameter)\s*[:=]?\s*([\d.,]+\s*mm)/i));
      set("wallThickness", other.wallThickness ?? capture(text, /\b(?:wt|wall\s*thickness|thickness)\s*[:=]?\s*([\d.,]+\s*mm)/i));
      set("length", other.length ?? capture(text, /\b(?:length|long)\s*[:=]?\s*([\d.,]+\s*(?:m|mm|ft))/i));
      set("manufacturingType", other.manufacturingType ?? (/seamless/i.test(lower) ? "Seamless" : /erw|welded/i.test(lower) ? "Welded" : null));
      set("endPreparation", other.endPreparation ?? (/\bbw\b|butt\s*weld|bevel/i.test(lower) ? "Bevelled" : /\bpe\b|plain\s*end/i.test(lower) ? "Plain end" : /\bthd\b|thread/i.test(lower) ? "Threaded" : /\bsw\b|socket/i.test(lower) ? "Socket" : null));
      set("coating", other.coating ?? (/galvan/i.test(lower) ? "Galvanized" : /epoxy|fbe/i.test(lower) ? "Epoxy/FBE" : /paint/i.test(lower) ? "Painted" : null));
      set("certification", other.certification ?? (/en\s*10204\s*3\.1/i.test(lower) ? "EN 10204 3.1" : /mill\s*certificate/i.test(lower) ? "Mill certificate" : null));
      set("lengthBasis", other.lengthBasis ?? (/double\s*random/i.test(lower) ? "Double random" : /random\s*length/i.test(lower) ? "Random length" : /per\s*(?:meter|metre|m)\b/i.test(lower) ? "Per metre" : /per\s*(?:length|joint)\b/i.test(lower) ? "Per length" : null));
      set("serviceCondition", other.serviceCondition ?? (/\bnace\b|sour\s*service|\bh2s\b/i.test(lower) ? "NACE / sour service" : null));
      break;
    }
    case "Valves": {
      set("valveType", other.valveType ?? (lower.match(/\b(gate|ball|globe|check|butterfly|needle|plug|diaphragm|safety|relief)\s+valve\b/i)?.[1]));
      set("size", size);
      set("pressureClass", pressure);
      set("endConnection", other.endConnection ?? (/butt\s*weld|\bbw\b/i.test(lower) ? "Butt weld" : /socket\s*weld|\bsw\b/i.test(lower) ? "Socket weld" : /flang/i.test(lower) ? "Flanged" : /thread|npt/i.test(lower) ? "Threaded" : null));
      set("bodyMaterial", clean(input.material) ?? other.bodyMaterial ?? material);
      set("trimMaterial", other.trimMaterial ?? capture(text, /\btrim\s*[:=]?\s*([a-z0-9 /-]{2,30})/i));
      set("operation", other.operation ?? (/hand\s*wheel|handwheel/i.test(lower) ? "Handwheel" : /lever/i.test(lower) ? "Lever" : /pneumatic/i.test(lower) ? "Pneumatic" : /electric|motor/i.test(lower) ? "Electric" : null));
      set("standard", standard ?? other.standard);
      set("testing", other.testing ?? (/api\s*598/i.test(lower) ? "API 598" : null));
      break;
    }
    case "Flanges": {
      set("flangeType", other.flangeType ?? (/weld\s*neck|\bwn\b/i.test(lower) ? "Weld neck" : /slip[\s-]*on|\bso\b/i.test(lower) ? "Slip on" : /blind/i.test(lower) ? "Blind" : /lap\s*joint/i.test(lower) ? "Lap joint" : /thread/i.test(lower) ? "Threaded" : /socket/i.test(lower) ? "Socket weld" : null));
      set("nominalSize", size);
      set("pressureClass", pressure);
      set("facing", other.facing ?? (/\brtj\b|ring\s*type\s*joint/i.test(lower) ? "RTJ" : /\bff\b|flat\s*face/i.test(lower) ? "FF" : /\brf\b|raised\s*face/i.test(lower) ? "RF" : null));
      set("material", material);
      set("grade", grade);
      set("standard", standard);
      set("dimensions", other.dimensions ?? clean(input.size));
      break;
    }
    case "Fittings": {
      set("fittingType", other.fittingType ?? (lower.match(/\b(elbow|tee|reducer|coupling|union|cap|nipple|bend|cross|plug|bushing)\b/i)?.[1]));
      set("size", size);
      set("schedule", schedule);
      set("material", material);
      set("grade", grade);
      set("connection", other.connection ?? (/butt\s*weld|\bbw\b/i.test(lower) ? "Butt weld" : /socket\s*weld|\bsw\b/i.test(lower) ? "Socket weld" : /flang/i.test(lower) ? "Flanged" : /thread|npt/i.test(lower) ? "Threaded" : null));
      set("standard", standard);
      break;
    }
    case "Gaskets": {
      set("gasketType", other.gasketType ?? (/spiral\s*wound/i.test(lower) ? "Spiral wound" : /metal\s*jacketed/i.test(lower) ? "Metal jacketed" : /ring\s*(?:joint|type)/i.test(lower) ? "Ring type joint" : /sheet/i.test(lower) ? "Sheet" : /insulation/i.test(lower) ? "Insulation kit" : null));
      set("size", size);
      set("pressureClass", pressure);
      set("material", material);
      set(
        "filler",
        other.filler ??
          text.match(/\b([a-z0-9-]{2,30})\s+filler\b/i)?.[1] ??
          capture(text, /\b(?:filler|filling)\s*[:=]\s*([a-z0-9 /-]{2,30})/i),
      );
      set("standard", standard);
      break;
    }
    case "Insulation Kits": {
      set("kitType", other.kitType ?? (/flange\s*insulation/i.test(lower) ? "Flange insulation kit" : /valve\s*insulation/i.test(lower) ? "Valve insulation kit" : /pipe\s*insulation/i.test(lower) ? "Pipe insulation kit" : /insulation\s*(?:kit|set|blanket|jacket)/i.test(lower) ? "Insulation kit" : null));
      set("size", size);
      set("pressureClass", pressure);
      set("material", material);
      set("standard", standard);
      break;
    }
    case "Services": {
      set("serviceType", other.serviceType ?? (lower.match(/\b(machining|hydro\s*test|hydrotest|plating|ndt|non[\s-]*destructive\s*testing|pmi|positive\s*material\s*identification|passivation)\b/i)?.[1]));
      set("scope", other.scope ?? clean(input.description));
      set("standard", standard);
      set("turnaround", other.turnaround ?? capture(text, /\b(?:turnaround|lead\s*time|delivery)\s*[:=]?\s*([0-9]+\s*(?:days?|weeks?|hours?))/i));
      break;
    }
    case "Chemicals": {
      set("productName", other.productName ?? clean(input.description.split(/[,;|]/)[0]?.slice(0, 90)));
      set("manufacturer", other.manufacturer ?? brand);
      set("casNumber", other.casNumber ?? capture(text, /\b(\d{2,7}-\d{2}-\d)\b/));
      set("chemicalGrade", other.chemicalGrade ?? (lower.match(/\b(technical|industrial|food|pharmaceutical|pharma|reagent|analytical)\s*(?:grade)?\b/i)?.[1]));
      set("purity", other.purity ?? text.match(/(\d{1,3}(?:\.\d+)?\s*%)/)?.[1]);
      set("physicalForm", other.physicalForm ?? (lower.match(/\b(flakes?|powder|liquid|granules?|pellets?|crystals?|solution|gas)\b/i)?.[1]));
      set("packaging", other.packaging ?? text.match(/\b(\d+(?:\.\d+)?\s*(?:kg|g|l|litre|liter|ml)\s*(?:bag|drum|ibc|tanker|bottle|can|container)?|\d+\s*(?:bag|drum|ibc|tanker|bottle|can)s?)\b/i)?.[0]);
      if (input.quantity != null && input.quantity > 0) set("quantity", String(input.quantity));
      set("unit", clean(input.unit));
      set("sds", other.sds ?? (/\bsds\b|\bmsds\b|safety\s*data\s*sheet/i.test(lower) ? "Stated" : null));
      set("coa", other.coa ?? (/\bcoa\b|certificate\s*of\s*analysis/i.test(lower) ? "Stated" : null));
      set("hazardClass", other.hazardClass);
      break;
    }
    case "Industrial Spares": {
      set("manufacturer", other.manufacturer ?? brand ?? (text.match(/\b([A-Z][A-Za-z0-9&.-]{2,30})\b/)?.[1]));
      set("partNumber", other.partNumber ?? capture(text, /\b(?:part\s*(?:no\.?|number)|p\/n|model\s*no\.?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9./_-]{1,40})/i));
      set("model", other.model ?? capture(text, /\bmodel\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9./ _-]{1,40})/i));
      set("compatibleEquipment", other.compatibleEquipment ?? capture(text, /\b(?:for|compatible\s*with|fits)\s+([A-Za-z0-9][A-Za-z0-9 ./_-]{2,60})/i));
      set("specifications", other.specifications ?? clean(input.description));
      set("documentation", other.documentation ?? (/datasheet|drawing|manual|certificate/i.test(lower) ? "Stated" : null));
      break;
    }
  }

  return attrs;
}

export function buildIndustrialSpec(
  category: IndustrialCategory,
  attributes: Record<string, string | null | undefined>,
  options: { source?: IndustrialSpec["source"]; confidence?: Record<string, number> } = {},
): IndustrialSpec {
  const schema = INDUSTRIAL_SCHEMAS[category];
  const present: Record<string, string> = {};
  for (const attribute of schema) {
    const value = clean(attributes[attribute.key]);
    if (value) present[attribute.key] = value;
  }
  const missingRequired = schema
    .filter((attribute) => attribute.required && !present[attribute.key])
    .map((attribute) => attribute.label);
  const missingOptional = schema
    .filter((attribute) => !attribute.required && !present[attribute.key])
    .map((attribute) => attribute.label);

  return {
    version: INDUSTRIAL_SPEC_VERSION,
    category,
    attributes: present,
    missingRequired,
    missingOptional,
    confidence: options.confidence ?? {},
    source: options.source ?? "EXTRACTED",
  };
}

/** Builds a spec from the generic enquiry fields, without inventing values. */
export function industrialSpecFromFields(
  category: string | null | undefined,
  input: IndustrialAttributeInput,
  options: { source?: IndustrialSpec["source"] } = {},
): IndustrialSpec | null {
  const resolved = resolveIndustrialCategory(category);
  if (!resolved) return null;
  return buildIndustrialSpec(resolved, extractIndustrialAttributes(resolved, input), options);
}

/** Customer clarification for missing required industrial attributes. */
export function industrialClarificationQuestion(spec: IndustrialSpec, description?: string): string | null {
  if (spec.missingRequired.length === 0) return null;
  const subject = (description ?? spec.attributes.productName ?? spec.category)
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  const list = spec.missingRequired.map((label) => label.toLowerCase()).join(", ");
  return `Please confirm the ${list} for ${subject}.`;
}

export function compareIndustrialSpec(
  category: string | null | undefined,
  requested: Record<string, string | null | undefined>,
  offered: Record<string, string | null | undefined>,
  options: {
    equivalences?: Array<{
      requestedMaterial: string;
      offeredMaterial: string;
      requestedGrade?: string;
      offeredGrade?: string;
      reason?: string | null;
    }>;
  } = {},
): IndustrialMatch {
  const schema = schemaFor(category);
  if (!schema) {
    return { status: "INSUFFICIENT", reasons: [], mismatches: [], missing: ["Product category"], usedEquivalence: false };
  }

  const reasons: string[] = [];
  const mismatches: string[] = [];
  const missing: string[] = [];
  let usedEquivalence = false;

  for (const attribute of schema) {
    const requiredValue = text(requested[attribute.key]);
    const offeredValue = text(offered[attribute.key]);
    if (!attribute.required) continue;
    if (!requiredValue) {
      missing.push(attribute.label);
      continue;
    }
    if (!offeredValue) {
      missing.push(attribute.label);
      continue;
    }
    if (sameValue(attribute, requiredValue, offeredValue)) {
      reasons.push(`${attribute.label} matches (${offeredValue})`);
      continue;
    }

    if (attribute.key === "material" || attribute.key === "bodyMaterial") {
      const rule = (options.equivalences ?? []).find(
        (entry) =>
          normalizeMaterial(entry.requestedMaterial) === normalizeMaterial(requiredValue) &&
          normalizeMaterial(entry.offeredMaterial) === normalizeMaterial(offeredValue) &&
          (!entry.requestedGrade || entry.requestedGrade === text(requested.grade)) &&
          (!entry.offeredGrade || entry.offeredGrade === text(offered.grade)),
      );
      if (rule) {
        usedEquivalence = true;
        reasons.push(
          rule.reason
            ? `Approved substitution ${requiredValue} → ${offeredValue}: ${rule.reason}`
            : `Approved substitution ${requiredValue} → ${offeredValue}`,
        );
        continue;
      }
    }

    mismatches.push(`${attribute.label} differs: requested ${requiredValue}, offered ${offeredValue}`);
  }

  if (mismatches.length > 0) {
    return { status: "NO_MATCH", reasons, mismatches, missing, usedEquivalence };
  }
  if (missing.length > 0) {
    return { status: "INSUFFICIENT", reasons, mismatches, missing, usedEquivalence };
  }
  return { status: usedEquivalence ? "EQUIVALENT" : "EXACT", reasons, mismatches, missing, usedEquivalence };
}
