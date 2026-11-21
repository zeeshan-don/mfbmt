/**
 * Category knowledge base. Required attributes are what MFBMT needs before a
 * product can be priced or sourced. Nothing here is inferred at search time:
 * missing required attributes force a clarification question instead.
 */
export type AttributeKey =
  | "size"
  | "material"
  | "grade"
  | "pressureRating"
  | "schedule"
  | "standard"
  | "typeVariant"
  | "brand";

export type CategoryRule = {
  name: string;
  synonyms: string[];
  required: AttributeKey[];
  optional: AttributeKey[];
  /** When true, a bare generic description (e.g. "hammer") needs clarification. */
  variantRequired: boolean;
  searchHints: string[];
};

export const CATEGORIES: CategoryRule[] = [
  {
    name: "Industrial Fasteners",
    synonyms: ["fastener", "bolt", "nut", "washer", "screw", "stud", "anchor"],
    required: ["size", "material", "grade"],
    optional: ["standard", "brand"],
    variantRequired: false,
    searchHints: ["bolt", "nut", "washer", "stud bolt", "fastener"],
  },
  {
    name: "Pipe Fittings",
    synonyms: ["elbow", "tee", "reducer", "coupling", "union", "nipple", "cap", "bend", "fitting"],
    required: ["size", "material"],
    optional: ["pressureRating", "schedule", "standard", "brand"],
    variantRequired: false,
    searchHints: ["pipe fitting", "elbow", "tee", "coupling"],
  },
  {
    name: "Valves",
    synonyms: ["valve", "gate valve", "ball valve", "globe valve", "check valve", "butterfly"],
    required: ["size", "material", "pressureRating", "typeVariant"],
    optional: ["standard", "brand"],
    variantRequired: true,
    searchHints: ["industrial valve", "gate valve", "ball valve"],
  },
  {
    name: "Flanges",
    synonyms: ["flange", "weld neck", "slip on", "blind flange"],
    required: ["size", "pressureRating", "material"],
    optional: ["standard", "schedule"],
    variantRequired: false,
    searchHints: ["flange", "weld neck flange", "slip on flange"],
  },
  {
    name: "Gaskets",
    synonyms: ["gasket", "spiral wound", "ring joint", "sheet gasket"],
    required: ["size", "material", "pressureRating"],
    optional: ["standard", "brand"],
    variantRequired: true,
    searchHints: ["gasket", "spiral wound gasket"],
  },
  {
    name: "Insulation Kits",
    synonyms: ["insulation kit", "insulation set", "flange insulation", "valve insulation", "pipe insulation"],
    required: ["size", "material"],
    optional: ["pressureRating", "standard"],
    variantRequired: false,
    searchHints: ["insulation kit", "flange insulation kit"],
  },
  {
    name: "Hoses & Couplings",
    synonyms: ["hose", "coupling", "camlock", "clamp", "hose fitting"],
    required: ["size", "material"],
    optional: ["pressureRating", "brand"],
    variantRequired: false,
    searchHints: ["hose", "camlock coupling", "hose coupling"],
  },
  {
    name: "Stainless Steel Fittings",
    synonyms: ["ss fitting", "ss316", "ss304", "stainless fitting"],
    required: ["size", "material"],
    optional: ["pressureRating", "schedule", "standard"],
    variantRequired: false,
    searchHints: ["stainless steel fitting", "SS316 fitting"],
  },
  {
    name: "Mild Steel Fittings",
    synonyms: ["ms fitting", "mild steel", "carbon steel fitting"],
    required: ["size", "material"],
    optional: ["schedule", "standard"],
    variantRequired: false,
    searchHints: ["mild steel fitting", "carbon steel fitting"],
  },
  {
    name: "PVC / PPR / HDPE",
    synonyms: ["pvc", "ppr", "hdpe", "upvc", "plastic pipe"],
    required: ["size", "material"],
    optional: ["pressureRating", "standard"],
    variantRequired: false,
    searchHints: ["PVC fitting", "PPR pipe", "HDPE pipe"],
  },
  {
    name: "Tools & General Supplies",
    synonyms: ["hammer", "drill", "tool", "safety", "consumable", "gloves", "helmet"],
    required: ["typeVariant"],
    optional: ["size", "brand", "material"],
    variantRequired: true,
    searchHints: ["industrial tool", "hand tool"],
  },
  {
    name: "Industrial Spares",
    synonyms: ["spare part", "spares", "bearing", "mechanical seal", "seal kit", "impeller"],
    required: ["typeVariant"],
    optional: ["brand", "material"],
    variantRequired: true,
    searchHints: ["industrial spare part", "mechanical seal"],
  },
  {
    name: "Industrial Services",
    synonyms: ["machining", "hydrotest", "hydro test", "plating", "ndt", "pmi", "passivation", "welding service"],
    required: ["typeVariant"],
    optional: ["standard"],
    variantRequired: true,
    searchHints: [],
  },
  {
    name: "Other Industrial Supplies",
    synonyms: [],
    required: ["typeVariant"],
    optional: ["size", "material", "brand"],
    variantRequired: true,
    searchHints: ["industrial supply"],
  },
];

export function findCategory(raw: string | null | undefined): CategoryRule | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  for (const category of CATEGORIES) {
    if (category.name.toLowerCase() === text) return category;
    if (category.synonyms.some((syn) => text.includes(syn))) return category;
  }
  return null;
}

export function inferCategoryFromDescription(description: string): CategoryRule | null {
  const text = description.toLowerCase();
  let best: { rule: CategoryRule; score: number } | null = null;
  for (const rule of CATEGORIES) {
    let score = 0;
    for (const syn of rule.synonyms) {
      if (text.includes(syn)) score += syn.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { rule, score };
  }
  return best?.rule ?? null;
}

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  size: "Size",
  material: "Material",
  grade: "Grade",
  pressureRating: "Pressure rating",
  schedule: "Schedule",
  standard: "Standard",
  typeVariant: "Product type",
  brand: "Brand",
};
