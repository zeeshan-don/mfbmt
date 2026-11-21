import { OGS_EVAL_CASES } from "../eval/ogs-cases";
import { ruleClassify } from "../lib/ai/classify";
import { extractEnquiry } from "../lib/ai/extract";
import { runWithTenant } from "../lib/tenant";
import { db } from "../lib/db";
import { getTenantId } from "../lib/tenant";

/**
 * Rules-first evaluation. `--ai` enables the provider when AI_PROVIDER/AI_API_KEY
 * are configured; without credentials the run is explicitly rules-only.
 */
async function main() {
  const useAi = process.argv.includes("--ai");
  const organizationId = process.env.EVAL_ORGANIZATION_ID || "org_ogs";
  const started = new Date();
  let correctClassification = 0;
  let wrongButConfident = 0;
  let correctFields = 0;
  let rfqCases = 0;
  const byCategory = new Map<string, { total: number; correct: number }>();
  const failures: string[] = [];

  for (const testCase of OGS_EVAL_CASES) {
    const classified = ruleClassify({
      text: testCase.text,
      channel: testCase.sourceKind,
      hasAttachments: false,
      allowAi: false,
    });
    const gotRfq = classified.classification === "RFQ";
    if (gotRfq === testCase.expected.rfq) correctClassification += 1;
    else if (classified.confidence >= 0.8) wrongButConfident += 1;
    else failures.push(`${testCase.id}: classification ${classified.classification}`);

    if (!testCase.expected.rfq) continue;
    rfqCases += 1;
    const extraction = await runWithTenant({ organizationId, source: "test" }, () =>
      extractEnquiry(
        { text: testCase.text, subject: null, documents: [] },
        { industrial: true, allowAi: useAi },
      ),
    );
    const first = extraction.items[0];
    const category = first?.industrialSpec?.category ?? first?.category ?? "—";
    const quantity = first?.quantity ?? null;
    const correct = quantity === testCase.expected.quantity && category === testCase.expected.category;
    const stats = byCategory.get(testCase.expected.category ?? "—") ?? { total: 0, correct: 0 };
    stats.total += 1;
    if (correct) {
      correctFields += 1;
      stats.correct += 1;
    } else {
      failures.push(
        `${testCase.id}: expected ${testCase.expected.category}/${testCase.expected.quantity}, got ${category}/${quantity}`,
      );
    }
    byCategory.set(testCase.expected.category ?? "—", stats);
  }

  const usage = useAi
    ? await runWithTenant({ organizationId, source: "test" }, () =>
        db.aiUsage.aggregate({
          where: { createdAt: { gte: started } },
          _sum: { estimatedCostUsd: true },
          _count: { _all: true },
        }),
      )
    : null;
  const cost = usage?._sum.estimatedCostUsd ?? 0;
  const aiCalls = usage?._count._all ?? 0;

  console.log(`OGS evaluation — ${OGS_EVAL_CASES.length} cases, ${rfqCases} RFQs, mode=${useAi ? "AI" : "rules-only"}`);
  console.log(`classification accuracy: ${correctClassification}/${OGS_EVAL_CASES.length} (${((correctClassification / OGS_EVAL_CASES.length) * 100).toFixed(1)}%)`);
  console.log(`RFQ field accuracy: ${correctFields}/${rfqCases} (${((correctFields / Math.max(1, rfqCases)) * 100).toFixed(1)}%)`);
  console.log(`wrong-but-confident: ${wrongButConfident}`);
  for (const [category, stats] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${category.padEnd(22)} ${stats.correct}/${stats.total} (${((stats.correct / stats.total) * 100).toFixed(1)}%)`);
  }
  console.log(`AI calls: ${aiCalls}; AI cost: $${cost.toFixed(6)}; cost/enquiry: $${(cost / Math.max(1, rfqCases)).toFixed(6)}`);
  if (failures.length > 0) {
    console.log(`\nFirst ${Math.min(10, failures.length)} mismatches:`);
    for (const failure of failures.slice(0, 10)) console.log(`  - ${failure}`);
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error("evaluation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
