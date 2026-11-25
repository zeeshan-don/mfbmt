import { z } from "zod";

/**
 * Contracts for Deep Supplier Research.
 *
 * The planner returns structured, validated research intent. It never returns
 * an unbounded list of query strings: every query has a purpose, category and
 * evidence target, and the engine enforces a hard execution budget.
 */

export const RESEARCH_MODES = ["QUICK", "DEEP"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

export const RESEARCH_STATUSES = [
  "QUEUED",
  "PLANNING",
  "SEARCHING",
  "INVESTIGATING",
  "ANALYZING",
  "FOLLOW_UP",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_ACTIVE_STATUSES: ResearchStatus[] = [
  "QUEUED",
  "PLANNING",
  "SEARCHING",
  "INVESTIGATING",
  "ANALYZING",
  "FOLLOW_UP",
];

export const QUERY_CATEGORIES = [
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
] as const;
export type QueryCategory = (typeof QUERY_CATEGORIES)[number];

export const QUERY_CATEGORY_LABELS: Record<QueryCategory, string> = {
  EXACT_SPECIFICATION: "Exact specification",
  COMMON_TERMINOLOGY: "Industrial terminology",
  TECHNICAL_STANDARD: "Technical standard",
  MANUFACTURER: "Manufacturer",
  DISTRIBUTOR: "Distributor / stockist",
  REGIONAL: "Regional supplier",
  CATALOGUE: "Catalogue / datasheet",
  PRODUCT_CATEGORY: "Product category",
  ALTERNATIVE: "Alternative terminology",
  FOLLOW_UP: "Evidence-gap follow-up",
};

export const EvidenceSourceTypeSchema = z.enum([
  "SEARCH_SNIPPET",
  "PAGE",
  "PDF",
  "SPREADSHEET",
  "OCR",
  "VISION",
  "INTERNAL",
  "AI_INTERPRETATION",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EvidenceVerificationSchema = z.enum([
  "SUPPORTED",
  "INDIRECT",
  "SNIPPET_ONLY",
  "INTERPRETATION",
  "UNAVAILABLE",
]);
export type EvidenceVerification = z.infer<typeof EvidenceVerificationSchema>;

export const ResearchQuerySchema = z.object({
  query: z.string().trim().min(3).max(300),
  productTarget: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(240),
  location: z.string().trim().max(120).nullable().default(null),
  requiredEvidence: z.string().trim().min(1).max(240),
  category: z.enum(QUERY_CATEGORIES),
  reason: z.string().trim().min(1).max(240),
});
export type ResearchQuery = z.infer<typeof ResearchQuerySchema>;

export const ResearchProductUnderstandingSchema = z.object({
  productFamily: z.string().max(120).nullable(),
  productName: z.string().trim().min(1).max(240),
  commonTerminology: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  material: z.string().max(100).nullable(),
  grade: z.string().max(80).nullable(),
  manufacturingStandard: z.string().max(120).nullable(),
  dimensions: z.string().max(160).nullable(),
  diameter: z.string().max(80).nullable(),
  scheduleOrWallThickness: z.string().max(80).nullable(),
  pressureClass: z.string().max(80).nullable(),
  connectionType: z.string().max(80).nullable(),
  finish: z.string().max(80).nullable(),
  brand: z.string().max(100).nullable(),
  quantity: z.number().finite().nonnegative(),
  unit: z.string().max(24),
  deliveryLocation: z.string().max(200).nullable(),
  deliveryTimeframe: z.string().max(160).nullable(),
  certifications: z.array(z.string().max(120)).max(12).default([]),
  mandatorySpecifications: z.array(z.string().max(120)).max(30).default([]),
  optionalSpecifications: z.array(z.string().max(120)).max(30).default([]),
  unknownSpecifications: z.array(z.string().max(120)).max(30).default([]),
  alternativesRequiringReview: z.array(z.string().max(200)).max(12).default([]),
});
export type ResearchProductUnderstanding = z.infer<typeof ResearchProductUnderstandingSchema>;

export const ResearchPlanSchema = z.object({
  enquiryId: z.string(),
  enquiryItemId: z.string(),
  product: ResearchProductUnderstandingSchema,
  queries: z.array(ResearchQuerySchema).min(1).max(40),
  notes: z.array(z.string().max(300)).max(20).default([]),
  source: z.enum(["DETERMINISTIC", "AI_ASSISTED"]).default("DETERMINISTIC"),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

export const ResearchEvidenceClaimSchema = z.object({
  field: z.string().trim().min(1).max(60),
  claim: z.string().trim().min(1).max(240),
  value: z.string().max(400).nullable(),
  sourceUrl: z.string().max(2048),
  pageTitle: z.string().max(300).nullable().optional(),
  sourceType: EvidenceSourceTypeSchema,
  excerpt: z.string().max(1200).nullable(),
  documentLocation: z.string().max(180).nullable().optional(),
  pageNumber: z.number().int().positive().nullable().optional(),
  sheetName: z.string().max(120).nullable().optional(),
  rowNumber: z.number().int().positive().nullable().optional(),
  retrievedAt: z.string().datetime(),
  extractionMethod: z.enum(["DETERMINISTIC", "AI", "MANUAL"]).default("DETERMINISTIC"),
  verificationStatus: EvidenceVerificationSchema,
});
export type ResearchEvidenceClaim = z.infer<typeof ResearchEvidenceClaimSchema>;

export const ResearchSupplierProfileSchema = z.object({
  canonicalName: z.string().trim().min(1).max(220),
  domain: z.string().max(200).nullable(),
  website: z.string().max(2048).nullable(),
  description: z.string().max(1200).nullable(),
  classification: z.enum(["MANUFACTURER", "DISTRIBUTOR", "STOCKIST", "TRADER", "UNKNOWN"]).default("UNKNOWN"),
  countries: z.array(z.string().max(80)).max(12).default([]),
  locations: z.array(z.string().max(120)).max(20).default([]),
  contacts: z
    .array(
      z.object({
        type: z.enum(["EMAIL", "PHONE", "CONTACT_PAGE"]),
        value: z.string().max(300),
        sourceUrl: z.string().max(2048),
        verificationStatus: EvidenceVerificationSchema,
      }),
    )
    .max(20)
    .default([]),
  productCategories: z.array(z.string().max(120)).max(30).default([]),
  capabilities: z.array(z.string().max(160)).max(30).default([]),
  certifications: z.array(z.string().max(160)).max(30).default([]),
  aliases: z.array(z.string().max(220)).max(20).default([]),
  branches: z.array(z.string().max(180)).max(20).default([]),
});
export type ResearchSupplierProfile = z.infer<typeof ResearchSupplierProfileSchema>;

export const ResearchAttributeMatchSchema = z.object({
  field: z.string().max(60),
  label: z.string().max(80),
  requested: z.string().max(160).nullable(),
  offered: z.string().max(240).nullable(),
  evidenceId: z.string().max(80).nullable().optional(),
  sourceUrl: z.string().max(2048).nullable().optional(),
});
export type ResearchAttributeMatch = z.infer<typeof ResearchAttributeMatchSchema>;

export const ResearchQualificationSchema = z.object({
  status: z.enum(["EXACT", "COMPATIBLE", "POSSIBLE", "UNVERIFIED", "NO_MATCH"]),
  matchingAttributes: z.array(ResearchAttributeMatchSchema).max(40).default([]),
  missingAttributes: z.array(ResearchAttributeMatchSchema).max(40).default([]),
  conflictingAttributes: z.array(ResearchAttributeMatchSchema).max(40).default([]),
  evidenceIds: z.array(z.string().max(80)).max(80).default([]),
  explanation: z.string().max(1200),
  confidence: z.number().min(0).max(1),
  /** True only when an owner-approved equivalence caused the compatible result. */
  usedApprovedEquivalence: z.boolean().default(false),
});
export type ResearchQualification = z.infer<typeof ResearchQualificationSchema>;

export const ResearchLimitsSchema = z.object({
  maxRounds: z.number().int().min(1).max(10),
  maxQueries: z.number().int().min(1).max(100),
  maxUrls: z.number().int().min(1).max(100),
  maxPagesPerDomain: z.number().int().min(1).max(30),
  maxConcurrentPages: z.number().int().min(1).max(10),
  maxFollowUpAiPasses: z.number().int().min(0).max(5),
  maxAiCalls: z.number().int().min(0).max(50),
  /** Per-run AI/search budget in AED. Null means the organization budget applies. */
  budgetAed: z.number().min(0).max(100_000).nullable(),
  maxPageBytes: z.number().int().min(10_000).max(2_000_000),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000),
});
export type ResearchLimits = z.infer<typeof ResearchLimitsSchema>;

export const ResearchRunOptionsSchema = z.object({
  mode: z.literal("DEEP").optional(),
  maxRounds: z.number().int().min(1).max(10).optional(),
  maxQueries: z.number().int().min(1).max(100).optional(),
  maxUrls: z.number().int().min(1).max(100).optional(),
  maxPagesPerDomain: z.number().int().min(1).max(30).optional(),
  maxConcurrentPages: z.number().int().min(1).max(10).optional(),
  budgetAed: z.number().min(0).max(100_000).nullable().optional(),
  resumeRunId: z.string().optional(),
});
export type ResearchRunOptions = z.input<typeof ResearchRunOptionsSchema>;
