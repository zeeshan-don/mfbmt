import { describe, expect, it } from "vitest";
import {
  compareFastenerSpecs,
  isFastenerSpecComplete,
  missingFastenerFields,
  parseFastenerSpec,
} from "../src/lib/fasteners/spec";
import { matchProduct } from "../src/lib/inventory/matching";

const BOLT =
  "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel";

function bolt(overrides: Partial<ReturnType<typeof parseFastenerSpec>> = {}) {
  return { ...parseFastenerSpec({ description: BOLT }), ...overrides };
}

describe("fastener specification parsing", () => {
  it("preserves every critical attribute stated by the customer", () => {
    const spec = parseFastenerSpec({ description: BOLT });
    expect(spec.type).toBe("HEX_BOLT");
    expect(spec.diameter).toBe("M10");
    expect(spec.diameterSystem).toBe("METRIC");
    expect(spec.threadSeries).toBe("METRIC_COARSE");
    expect(spec.pitchMm).toBe(1.5);
    expect(spec.lengthMm).toBe(30);
    expect(spec.material).toBe("MS");
    expect(spec.propertyClass).toBe("8.8");
    expect(spec.finish).toBe("ZINC_PLATED");
    expect(spec.standard).toBe("ISO 4017");
    expect(isFastenerSpecComplete(spec)).toBe(true);
  });

  it("does not invent an unstated pitch, property class or length", () => {
    const spec = parseFastenerSpec({ description: "Hex bolt M10 zinc plated carbon steel" });
    const missing = missingFastenerFields(spec);
    expect(missing).toContain("Thread pitch");
    expect(missing).toContain("Length");
    expect(missing).toContain("Property class");
    expect(spec.pitchMm).toBeNull();
    expect(spec.lengthMm).toBeNull();
    expect(spec.propertyClass).toBeNull();
  });

  it("recognises an inch thread callout without treating the length as the diameter", () => {
    const spec = parseFastenerSpec({
      description: 'Hex bolt 3/8-16 UNC x 1 1/2 in, class 8.8, zinc plated, carbon steel',
    });
    expect(spec.diameter).toBe("3/8");
    expect(spec.threadSeries).toBe("UNC");
    expect(spec.lengthMm).toBe(38.1);
  });
});

describe("deterministic fastener matching", () => {
  it("rejects an M12 bolt for an M10 request", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ diameter: "M12" }));
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/diameter/i);
  });

  it("rejects a 1.25 mm pitch for a 1.5 mm request", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ pitchMm: 1.25, threadSeries: "METRIC_FINE" }));
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/pitch|thread/i);
  });

  it("rejects a 50 mm bolt for a 30 mm request", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ lengthMm: 50 }));
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/length/i);
  });

  it("rejects a hex nut or washer offered for a hex bolt", () => {
    const nut = compareFastenerSpecs(bolt(), bolt({ type: "HEX_NUT", lengthMm: null }));
    expect(nut.status).toBe("NO_MATCH");
    expect(nut.mismatches.join(" ")).toMatch(/type/i);

    const washer = compareFastenerSpecs(bolt(), bolt({ type: "FLAT_WASHER", lengthMm: null }));
    expect(washer.status).toBe("NO_MATCH");
  });

  it("rejects property class 10.9 for a class 8.8 request", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ propertyClass: "10.9" }));
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/property class/i);
  });

  it("rejects A4 stainless for an A2 request", () => {
    const a2 = parseFastenerSpec({
      description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm A2-70 stainless steel passivated",
    });
    const a4 = parseFastenerSpec({
      description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm A4-80 stainless steel passivated",
    });
    expect(a2.material).toBe("SS304");
    expect(a4.material).toBe("SS316");
    const result = compareFastenerSpecs(a2, a4);
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/material|property class/i);
  });

  it("rejects hot-dip galvanized for a zinc-plated request", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ finish: "HOT_DIP_GALVANIZED" }));
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/finish/i);
  });

  it("treats DIN 931 / ISO 4014 as a different standard when the customer specified one", () => {
    const din933 = parseFastenerSpec({
      description: "Hex bolt DIN 933 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
    });
    const din931 = parseFastenerSpec({
      description: "Hex bolt DIN 931 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
    });
    expect(compareFastenerSpecs(din933, din931).status).toBe("NO_MATCH");

    const iso4017 = parseFastenerSpec({
      description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
    });
    const iso4014 = parseFastenerSpec({
      description: "Hex bolt ISO 4014 M10 x 1.5 x 30 mm class 8.8 zinc plated carbon steel",
    });
    expect(compareFastenerSpecs(iso4017, iso4014).status).toBe("NO_MATCH");
  });

  it("rejects UNC where the customer asked for UNF or metric", () => {
    const unc = parseFastenerSpec({
      description: 'Hex bolt 3/8-16 UNC x 1 1/2 in class 8.8 zinc plated carbon steel',
    });
    const unf = parseFastenerSpec({
      description: 'Hex bolt 3/8-24 UNF x 1 1/2 in class 8.8 zinc plated carbon steel',
    });
    expect(unc.threadSeries).toBe("UNC");
    expect(unf.threadSeries).toBe("UNF");
    expect(compareFastenerSpecs(unc, unf).status).toBe("NO_MATCH");
    expect(compareFastenerSpecs(unf, bolt()).status).toBe("NO_MATCH");
  });

  it("marks missing required supplier data as incomplete, not as a match", () => {
    const result = compareFastenerSpecs(bolt(), bolt({ lengthMm: null, propertyClass: null }));
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.missing).toEqual(expect.arrayContaining(["Length", "Property class"]));
    expect(result.status).not.toBe("EXACT");
  });

  it("keeps a fully matching offer eligible for ordering", () => {
    const result = compareFastenerSpecs(bolt(), bolt());
    expect(result.status).toBe("EXACT");
    expect(result.mismatches).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });
});

describe("fastener matching through the shared matcher", () => {
  const requested = {
    description: BOLT,
    category: "Industrial Fasteners",
    size: "M10",
    material: "MS",
    grade: "8.8",
    standard: "ISO 4017",
    fastenerSpec: parseFastenerSpec({ description: BOLT }),
  };

  it("never lets a textual similarity score override a hard fastener mismatch", () => {
    const result = matchProduct(requested, {
      description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 10.9 zinc plated carbon steel",
      category: "Industrial Fasteners",
      size: "M10",
      material: "MS",
      grade: "10.9",
      standard: "ISO 4017",
      fastenerSpec: parseFastenerSpec({
        description: "Hex bolt ISO 4017 M10 x 1.5 x 30 mm class 10.9 zinc plated carbon steel",
      }),
    });
    expect(result.status).toBe("NO_MATCH");
  });

  it("keeps a non-fastener category on the existing generic matcher", () => {
    const result = matchProduct(
      { description: "SS316 elbow 1 inch", category: "Pipe Fittings", size: "1 inch", material: "SS316" },
      {
        description: "Stainless Steel Elbow 90° 1 inch SS316",
        category: "Pipe Fittings",
        size: "1 inch",
        material: "SS316",
      },
    );
    expect(result.status).toBe("EXACT");
  });
});
