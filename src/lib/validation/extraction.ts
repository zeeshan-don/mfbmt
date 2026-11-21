import { z } from "zod";
import { FastenerSpecSchema } from "../fasteners/spec";
import { IndustrialSpecSchema } from "../catalog/industrialSpec";

export const CLASSIFICATION_VALUES = [
  "RFQ",
  "AVAILABILITY",
  "FOLLOW_UP",
  "SUPPLIER",
  "BUSINESS_OTHER",
  "PERSONAL",
  "UNCLEAR",
] as const;

export const ClassificationSchema = z.object({
  classification: z.enum(CLASSIFICATION_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(600),
  mentionsProducts: z.boolean(),
  isQuotationRequest: z.boolean(),
});
export type ClassificationResult = z.infer<typeof ClassificationSchema>;

const numericOrNull = z.number().finite().positive().nullable();

export const ExtractedItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: numericOrNull,
  unit: z.string().max(24).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  size: z.string().max(80).nullable().optional(),
  material: z.string().max(80).nullable().optional(),
  grade: z.string().max(60).nullable().optional(),
  pressureRating: z.string().max(60).nullable().optional(),
  schedule: z.string().max(40).nullable().optional(),
  standard: z.string().max(80).nullable().optional(),
  otherSpecs: z.record(z.string(), z.string()).optional(),
  /** Structured fastener fields. Optional: the deterministic parser fills gaps from the text. */
  fastenerSpec: FastenerSpecSchema.optional(),
  /** Versioned OGS industrial specification. Only present for industrial categories. */
  industrialSpec: IndustrialSpecSchema.optional().nullable(),
  sourceRef: z.string().max(120).nullable().optional(),
  missingFields: z.array(z.string()).default([]),
  confidence: z.record(z.number().min(0).max(1)).default({}),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

export const ExtractionSchema = z.object({
  isRfq: z.boolean(),
  classification: z.enum(CLASSIFICATION_VALUES),
  classificationConfidence: z.number().min(0).max(1),
  classificationReason: z.string().max(800),
  customerName: z.string().max(160).nullable().optional(),
  customerPhone: z.string().max(60).nullable().optional(),
  customerEmail: z.string().max(160).nullable().optional(),
  deliveryLocation: z.string().max(200).nullable().optional(),
  deliveryDate: z.string().max(40).nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  items: z.array(ExtractedItemSchema).default([]),
  notes: z.string().max(1000).nullable().optional(),
  unreadableParts: z.array(z.string()).default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionSchema>;

export const AIClassificationResponseSchema = z.object({
  classification: z.enum(CLASSIFICATION_VALUES),
  reason: z.string().max(800).default(""),
  confidence: z.number().min(0).max(1),
  mentionsProducts: z.boolean().default(false),
  isQuotationRequest: z.boolean().default(false),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  customerEmail: z.string().nullable().optional(),
});

export const AIExtractionResponseSchema = ExtractionSchema;

/** Supplier page evidence — never a source of invented specs. */
export const SupplierEvidenceSchema = z.object({
  productTitle: z.string().max(300).nullable().optional(),
  unitPrice: z.number().finite().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  moq: z.number().finite().nonnegative().nullable().optional(),
  availability: z.string().max(200).nullable().optional(),
  leadTimeDays: z.number().int().nonnegative().nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  size: z.string().max(80).nullable().optional(),
  material: z.string().max(80).nullable().optional(),
  grade: z.string().max(60).nullable().optional(),
  pressureRating: z.string().max(60).nullable().optional(),
  standard: z.string().max(80).nullable().optional(),
  shippingCost: z.number().finite().nonnegative().nullable().optional(),
  notes: z.string().max(600).nullable().optional(),
});
export type SupplierEvidence = z.infer<typeof SupplierEvidenceSchema>;
