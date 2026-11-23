import { z } from "zod";
import { completeJson, aiStatus, DATA_ONLY_RULE } from "../ai/provider";
import type { SourcingCandidate } from "./types";

export const AiSupplierComparisonSchema = z.object({
  shortlist: z
    .array(
      z.object({
        supplier: z.string().min(1).max(200),
        domain: z.string().max(200).nullable(),
        recommended: z.boolean(),
        specAlignment: z.enum(["MATCH", "PARTIAL", "UNKNOWN", "MISMATCH"]),
        reason: z.string().min(1).max(240),
      }),
    )
    .max(20),
  summary: z.string().min(1).max(400),
});

export type AiSupplierComparison = z.infer<typeof AiSupplierComparisonSchema>;

export type AiCandidateAssessment = {
  recommended: boolean;
  specAlignment: "MATCH" | "PARTIAL" | "UNKNOWN" | "MISMATCH";
  reason: string;
};

export function aiAssessmentKey(candidate: SourcingCandidate): string {
  return `${candidate.supplierName.trim().toLowerCase()}|${(candidate.evidence?.domain as string | undefined) ?? ""}`;
}

/**
 * Compares sourced supplier candidates against the required product specification
 * using the configured AI model. The model may only judge evidence that is
 * already present (title, snippet, page excerpt, extracted specs/price/MOQ/
 * lead time). It must never invent a price, stock level, lead time or
 * certification; missing evidence stays unknown and the candidate is not
 * recommended on that basis.
 *
 * Returns null when AI is unavailable, the budget is exhausted, or the call
 * fails, so sourcing degrades to the existing deterministic behaviour.
 */
export async function compareSourcedSuppliers(input: {
  request: {
    description: string;
    quantity: number;
    unit: string;
    category?: string | null;
    material?: string | null;
    size?: string | null;
    grade?: string | null;
    pressureRating?: string | null;
    schedule?: string | null;
    standard?: string | null;
    brand?: string | null;
  };
  candidates: SourcingCandidate[];
  enquiryId?: string | null;
}): Promise<{ assessment: Map<string, AiCandidateAssessment>; summary: string } | null> {
  if (!aiStatus().configured) return null;
  if (input.candidates.length === 0) return null;

  const budget = await import("../limits").then((m) => m.aiBudgetStatus()).catch(() => null);
  if (budget && !budget.allowed) return null;

  const candidateBlocks = input.candidates.slice(0, 20).map((candidate, index) => {
    const specs = (candidate.evidence?.specifications ?? {}) as Record<string, unknown>;
    const pageExcerpt = typeof candidate.evidence?.pageExcerpt === "string" ? (candidate.evidence.pageExcerpt as string).slice(0, 1200) : "";
    return [
      `Candidate ${index + 1}:`,
      `supplier: ${candidate.supplierName}`,
      `title: ${candidate.title.slice(0, 200)}`,
      `snippet: ${(candidate.snippet ?? "").slice(0, 400)}`,
      `sourceUrl: ${candidate.sourceUrl ?? "unknown"}`,
      `unitPrice: ${candidate.unitPrice ?? "unknown"} ${candidate.currency ?? ""}`.trim(),
      `moq: ${candidate.moq ?? "unknown"}`,
      `leadTimeDays: ${candidate.leadTimeDays ?? "unknown"}`,
      `availability: ${candidate.availability ?? "unknown"}`,
      `extractedSpecs: ${JSON.stringify(specs).slice(0, 600)}`,
      `pageExcerpt: ${pageExcerpt}`,
    ].join("\n");
  });

  const user = [
    "Required product:",
    JSON.stringify(
      {
        description: input.request.description,
        quantity: input.request.quantity,
        unit: input.request.unit,
        category: input.request.category ?? null,
        material: input.request.material ?? null,
        size: input.request.size ?? null,
        grade: input.request.grade ?? null,
        pressureRating: input.request.pressureRating ?? null,
        schedule: input.request.schedule ?? null,
        standard: input.request.standard ?? null,
        brand: input.request.brand ?? null,
      },
      null,
      0,
    ),
    "",
    "Sourced candidates (evidence only, nothing else):",
    candidateBlocks.join("\n\n"),
  ].join("\n");

  const result = await completeJson(
    {
      system:
        "You compare sourced supplier candidates against a required industrial product specification for a procurement company. " +
        "You may only use the evidence supplied (title, snippet, page excerpt, extracted specs, price, MOQ, lead time). " +
        "Never invent a price, stock level, lead time, certification, equivalence or availability. " +
        "If evidence is missing or unclear, mark specAlignment as UNKNOWN and recommended as false. " +
        "A candidate is recommended only when its visible evidence shows the requested product/species and a usable contact or RFQ path. " +
        "Reply with JSON only: {\"shortlist\":[{\"supplier\":string,\"domain\":string|null,\"recommended\":boolean,\"specAlignment\":\"MATCH\"|\"PARTIAL\"|\"UNKNOWN\"|\"MISMATCH\",\"reason\":string}],\"summary\":string}. " +
        DATA_ONLY_RULE,
      user: `<candidates>\n${user}\n</candidates>`,
      maxTokens: 1200,
      jobType: "sourcing.ai_compare",
      enquiryId: input.enquiryId ?? null,
    },
    AiSupplierComparisonSchema,
  );

  if (!result.ok) return null;

  const assessment = new Map<string, AiCandidateAssessment>();
  for (const entry of result.data.shortlist) {
    assessment.set(entry.supplier.trim().toLowerCase(), {
      recommended: entry.recommended,
      specAlignment: entry.specAlignment,
      reason: entry.reason,
    });
  }
  return { assessment, summary: result.data.summary };
}