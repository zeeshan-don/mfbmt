import { describe, expect, it } from "vitest";
import { OGS_EVAL_CASES, OGS_EXPECTED_RFQ_COUNT, OGS_HARD_CASES } from "../src/eval/ogs-cases";

describe("OGS golden dataset", () => {
  it("has at least 60 unique synthetic cases and the expected RFQ split", () => {
    expect(OGS_EVAL_CASES.length).toBeGreaterThanOrEqual(100);
    expect(OGS_HARD_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(OGS_EVAL_CASES.map((entry) => entry.id)).size).toBe(OGS_EVAL_CASES.length);
    expect(OGS_EVAL_CASES.filter((entry) => entry.expected.rfq)).toHaveLength(OGS_EXPECTED_RFQ_COUNT);
  });

  it("covers every OGS category and the non-RFQ classes", () => {
    const categories = new Set(OGS_EVAL_CASES.map((entry) => entry.expected.category).filter(Boolean));
    for (const category of ["Pipes", "Valves", "Flanges", "Fittings", "Gaskets", "Chemicals", "Industrial Spares", "Services", "Industrial Fasteners"]) {
      expect(categories.has(category)).toBe(true);
    }
    expect(OGS_EVAL_CASES.some((entry) => !entry.expected.rfq)).toBe(true);
    expect(OGS_HARD_CASES.some((entry) => entry.tags?.includes("arabic-mixed"))).toBe(true);
    expect(OGS_HARD_CASES.some((entry) => entry.tags?.includes("forwarded"))).toBe(true);
    expect(OGS_HARD_CASES.some((entry) => entry.tags?.includes("table"))).toBe(true);
  });
});
