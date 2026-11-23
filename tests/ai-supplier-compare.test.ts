import { describe, expect, it } from "vitest";
import { compareSourcedSuppliers } from "../src/lib/sourcing/aiCompare";

describe("AI supplier comparison", () => {
  it("returns null when no AI provider is configured", async () => {
    const result = await compareSourcedSuppliers({
      request: { description: "SS 316 valve", quantity: 10, unit: "pcs" },
      candidates: [],
    });
    expect(result).toBeNull();
  });
});