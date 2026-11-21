import { db } from "../db";
import { env } from "../env";
import { getTenantId } from "../tenant";

/** Provider-reported token usage is stored as evidence. Cost uses configured rates. */
export type AiUsageInput = {
  jobType: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number | null;
  enquiryId?: string | null;
  success?: boolean;
  error?: string | null;
};

export function estimateAiCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (Math.max(0, inputTokens) / 1_000_000) * env.AI_INPUT_COST_PER_1M_USD +
    (Math.max(0, outputTokens) / 1_000_000) * env.AI_OUTPUT_COST_PER_1M_USD
  );
}

export async function recordAiUsage(input: AiUsageInput): Promise<void> {
  const organizationId = getTenantId();
  if (!organizationId) return;
  try {
    await db.aiUsage.create({
      data: {
        organizationId,
        jobType: input.jobType.slice(0, 80),
        provider: input.provider.slice(0, 80),
        model: input.model.slice(0, 120),
        inputTokens: Math.max(0, Math.trunc(input.inputTokens)),
        outputTokens: Math.max(0, Math.trunc(input.outputTokens)),
        estimatedCostUsd:
          input.estimatedCostUsd === undefined
            ? estimateAiCostUsd(input.inputTokens, input.outputTokens)
            : input.estimatedCostUsd,
        enquiryId: input.enquiryId ?? null,
        success: input.success ?? true,
        error: input.error?.slice(0, 500) ?? null,
      },
    });
  } catch (error) {
    // Metering must never turn a successful extraction into a failure. The
    // structured failure is logged without prompts or customer content.
    console.error("[ai-usage] failed to record usage", error instanceof Error ? error.message : "unknown");
  }
}
