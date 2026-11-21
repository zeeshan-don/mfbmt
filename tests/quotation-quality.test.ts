import { describe, expect, it } from "vitest";
import { marginFloorProblem } from "../src/lib/workflow/quotations";

describe("quotation margin floor", () => {
  it("does not block when cost is incomplete or the floor is zero", () => {
    expect(
      marginFloorProblem({
        quotation: { internalCostComplete: false, internalCostTotal: 100, subtotal: 110 },
        minMarginPct: 20,
        exceptionReason: null,
      }),
    ).toBeNull();
    expect(
      marginFloorProblem({
        quotation: { internalCostComplete: true, internalCostTotal: 100, subtotal: 110 },
        minMarginPct: 0,
        exceptionReason: null,
      }),
    ).toBeNull();
  });

  it("blocks a known margin below the configured floor", () => {
    const problem = marginFloorProblem({
      quotation: { internalCostComplete: true, internalCostTotal: 100, subtotal: 110 },
      minMarginPct: 20,
      exceptionReason: null,
    });
    expect(problem).toMatch(/below the 20% floor/i);
  });

  it("allows an explicit owner exception", () => {
    expect(
      marginFloorProblem({
        quotation: { internalCostComplete: true, internalCostTotal: 100, subtotal: 110 },
        minMarginPct: 20,
        exceptionReason: "Strategic customer, approved by owner.",
      }),
    ).toBeNull();
  });
});
