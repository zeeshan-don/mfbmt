import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { OGS_EVAL_CASES, type EvalCase } from "../eval/ogs-cases";
import { classifyMessage } from "../lib/ai/classify";
import { extractEnquiry } from "../lib/ai/extract";
import { aiStatus } from "../lib/ai/provider";
import { db } from "../lib/db";
import { runWithTenant } from "../lib/tenant";

type Mode = "rules" | "ai";
type Range = { start: Date; end: Date };

type RunResult = {
  mode: Mode;
  total: number;
  rfqCases: number;
  correctClassification: number;
  correctFields: number;
  wrongButConfident: number;
  aiCalls: number;
  costUsd: number;
  failures: string[];
  byCategory: Map<string, { total: number; correct: number }>;
};

async function loadFolderCases(folder: string, labelsPath: string): Promise<EvalCase[]> {
  const files = (await readdir(folder)).filter((file) => /\.(txt|md)$/i.test(file)).sort();
  if (files.length === 0) throw new Error(`No .txt or .md enquiry files found in ${folder}`);
  const raw = JSON.parse(await readFile(labelsPath, "utf8")) as {
    cases?: Array<{ id: string; sourceKind?: EvalCase["sourceKind"]; expected?: EvalCase["expected"] }>;
    labels?: Array<{ id: string; sourceKind?: EvalCase["sourceKind"]; expected?: EvalCase["expected"] }>;
  };
  const labels = new Map((raw.cases ?? raw.labels ?? []).map((label) => [label.id, label]));
  const cases: EvalCase[] = [];
  for (const file of files) {
    const id = basename(file).replace(/\.(txt|md)$/i, "");
    const label = labels.get(id);
    if (!label?.expected) {
      throw new Error(`Missing label for ${id}. Add it to ${labelsPath} before measuring accuracy.`);
    }
    cases.push({
      id,
      sourceKind: label.sourceKind ?? "EMAIL",
      text: await readFile(join(folder, file), "utf8"),
      expected: label.expected,
      difficulty: "HARD",
    });
  }
  return cases;
}

async function evaluate(cases: EvalCase[], mode: Mode, organizationId: string): Promise<RunResult> {
  if (mode === "ai" && !aiStatus().configured) {
    throw new Error("AI mode requested, but AI_PROVIDER/AI_API_KEY are not configured. No AI result is claimed.");
  }
  const range: Range = { start: new Date(), end: new Date() };
  let correctClassification = 0;
  let correctFields = 0;
  let wrongButConfident = 0;
  let rfqCases = 0;
  const failures: string[] = [];
  const byCategory = new Map<string, { total: number; correct: number }>();

  for (const testCase of cases) {
    const classified = await classifyMessage({
      text: testCase.text,
      channel: testCase.sourceKind,
      hasAttachments: false,
      allowAi: mode === "ai",
    });
    const gotRfq = classified.result.classification === "RFQ";
    if (gotRfq === testCase.expected.rfq) correctClassification += 1;
    else if (classified.result.confidence >= 0.8) wrongButConfident += 1;
    else failures.push(`${testCase.id}: classification ${classified.result.classification}`);

    if (!testCase.expected.rfq) continue;
    rfqCases += 1;
    const extraction = await runWithTenant({ organizationId, source: "test" }, () =>
      extractEnquiry(
        { text: testCase.text, subject: null, documents: [] },
        { industrial: true, allowAi: mode === "ai" },
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
  range.end = new Date();

  const usage = mode === "ai"
    ? await runWithTenant({ organizationId, source: "test" }, () =>
        db.aiUsage.aggregate({
          where: { createdAt: { gte: range.start, lte: range.end } },
          _sum: { estimatedCostUsd: true },
          _count: { _all: true },
        }),
      )
    : null;

  return {
    mode,
    total: cases.length,
    rfqCases,
    correctClassification,
    correctFields,
    wrongButConfident,
    aiCalls: usage?._count._all ?? 0,
    costUsd: usage?._sum.estimatedCostUsd ?? 0,
    failures,
    byCategory,
  };
}

function printResult(label: string, result: RunResult) {
  const classificationPct = (result.correctClassification / Math.max(1, result.total)) * 100;
  const fieldPct = (result.correctFields / Math.max(1, result.rfqCases)) * 100;
  console.log(`\n=== ${label} ===`);
  console.log(`cases: ${result.total}; RFQs: ${result.rfqCases}`);
  console.log(`classification accuracy: ${result.correctClassification}/${result.total} (${classificationPct.toFixed(1)}%)`);
  console.log(`RFQ field accuracy: ${result.correctFields}/${result.rfqCases} (${fieldPct.toFixed(1)}%)`);
  console.log(`wrong-but-confident: ${result.wrongButConfident}`);
  for (const [category, stats] of [...result.byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${category.padEnd(22)} ${stats.correct}/${stats.total} (${((stats.correct / stats.total) * 100).toFixed(1)}%)`);
  }
  console.log(`AI calls: ${result.aiCalls}; AI cost: $${result.costUsd.toFixed(6)}; cost/enquiry: $${(result.costUsd / Math.max(1, result.rfqCases)).toFixed(6)}`);
  if (result.failures.length) {
    console.log(`\nFirst ${Math.min(10, result.failures.length)} mismatches:`);
    for (const failure of result.failures.slice(0, 10)) console.log(`  - ${failure}`);
  }
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const folder = argValue("--folder");
  const labels = argValue("--labels") ?? (folder ? join(folder, "labels.json") : null);
  const both = process.argv.includes("--both");
  const aiOnly = process.argv.includes("--ai") && !both;
  const modes: Mode[] = both ? ["rules", "ai"] : aiOnly ? ["ai"] : ["rules"];
  const organizationId = process.env.EVAL_ORGANIZATION_ID || "org_ogs";

  const cases = folder
    ? await loadFolderCases(resolve(folder), labels ? resolve(labels) : resolve(folder, "labels.json"))
    : OGS_EVAL_CASES;
  console.log(`${folder ? "Real anonymised folder" : "Synthetic OGS corpus"}: ${cases.length} cases`);
  if (folder && !labels) throw new Error("A labels file is required for folder mode.");

  for (const mode of modes) {
    try {
      const result = await evaluate(cases, mode, organizationId);
      printResult(mode === "ai" ? "AI" : "RULES-ONLY", result);
    } catch (error) {
      console.log(`\n=== ${mode === "ai" ? "AI" : "RULES-ONLY"} ===`);
      console.log(`SKIPPED: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 2;
    }
  }
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error("evaluation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
