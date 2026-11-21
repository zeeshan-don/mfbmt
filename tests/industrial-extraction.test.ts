import { describe, expect, it } from "vitest";
import { finalizeItems } from "../src/lib/ai/extract";
import { matchProduct } from "../src/lib/inventory/matching";
import { industrialSpecFromFields, parseIndustrialSpecJson } from "../src/lib/catalog/industrialSpec";
import { stringifyJson } from "../src/lib/json";

const pipeRequest = {
  description: "10 pcs 6 inch SCH 40 SS316 seamless pipe ASTM A312 bevelled end",
  quantity: 10,
  unit: "pcs",
  category: "Pipes",
  size: "6 inch",
  material: "SS316",
  grade: "316",
  pressureRating: null,
  schedule: "SCH 40",
  standard: "ASTM A312",
  otherSpecs: {},
  missingFields: [],
  confidence: {},
  sourceRef: "message",
};

describe("OGS industrial extraction", () => {
  it("keeps MFBMT extraction unchanged when industrial mode is off", () => {
    const [item] = finalizeItems([
      {
        description: "20 pcs SS316 elbow 1 inch",
        quantity: 20,
        unit: "pcs",
        material: "SS316",
        size: "1 inch",
        confidence: {},
        missingFields: [],
      },
    ]);
    expect(item.industrialSpec).toBeNull();
    expect(item.missingFields).not.toContain("Outside diameter");
  });

  it("builds a versioned pipe specification and reports only genuinely missing required attributes", () => {
    const [item] = finalizeItems([{ ...pipeRequest }], { industrial: true });
    const spec = item.industrialSpec;
    expect(spec).not.toBeNull();
    expect(spec?.version).toBe(1);
    expect(spec?.category).toBe("Pipes");
    expect(spec?.attributes.material).toBeTruthy();
    expect(spec?.attributes.schedule).toBeTruthy();
    expect(spec?.attributes.standard).toBeTruthy();
    expect(spec?.attributes.endPreparation).toBeTruthy();
    // Not stated anywhere: must be reported missing, never invented.
    expect(spec?.attributes.outsideDiameter).toBeUndefined();
    expect(spec?.attributes.wallThickness).toBeUndefined();
    expect(spec?.missingRequired).toEqual(expect.arrayContaining(["Outside diameter", "Wall thickness"]));
    expect(item.missingFields).toEqual(expect.arrayContaining(["Outside diameter", "Wall thickness"]));
    expect(item.clarificationQuestion).toMatch(/outside diameter|wall thickness/i);
  });

  it("preserves the customer's original wording and source reference", () => {
    const [item] = finalizeItems([{ ...pipeRequest, sourceRef: "page 2" }], { industrial: true });
    expect(item.description).toContain("6 inch SCH 40 SS316");
    expect(item.sourceRef).toBe("page 2");
  });

  it("recognises chemicals and requires purity, form, packaging and quantity", () => {
    const [item] = finalizeItems(
      [
        {
          description: "Caustic soda flakes technical grade 99% in 25 kg bag",
          quantity: 1000,
          unit: "kg",
          category: null,
          confidence: {},
          missingFields: [],
        },
      ],
      { industrial: true },
    );
    expect(item.industrialSpec?.category).toBe("Chemicals");
    expect(item.industrialSpec?.attributes.purity).toMatch(/99/);
    expect(item.industrialSpec?.attributes.physicalForm).toMatch(/flakes/i);
    expect(item.industrialSpec?.attributes.packaging).toMatch(/25\s*kg/i);
    expect(item.industrialSpec?.attributes.chemicalGrade).toMatch(/technical/i);
    expect(item.industrialSpec?.missingRequired).not.toContain("Packaging");
  });

  it("requires a spare part number and compatible equipment", () => {
    const [item] = finalizeItems(
      [
        {
          description: "Mechanical seal for Sulzer pump model X part no ABC-123",
          quantity: 2,
          unit: "pcs",
          confidence: {},
          missingFields: [],
        },
      ],
      { industrial: true },
    );
    expect(item.industrialSpec?.category).toBe("Industrial Spares");
    expect(item.industrialSpec?.attributes.partNumber).toBe("ABC-123");
    expect(item.industrialSpec?.attributes.compatibleEquipment).toBeTruthy();
  });

  it("serialises and re-reads the specification without losing the schema version", () => {
    const [item] = finalizeItems([{ ...pipeRequest }], { industrial: true });
    const roundTrip = parseIndustrialSpecJson(stringifyJson(item.industrialSpec));
    expect(roundTrip).toEqual(item.industrialSpec);
  });
});

describe("industrial matching integration", () => {
  const requested = industrialSpecFromFields("Pipes", {
    description: "6 inch SCH 40 carbon steel pipe ASTM A106",
    size: "6 inch",
    material: "Carbon Steel",
    grade: "A106 Grade B",
    schedule: "SCH 40",
    standard: "ASTM A106",
    otherSpecs: { outsideDiameter: "168.3 mm", wallThickness: "7.11 mm", endPreparation: "Bevelled" },
  })!;

  it("returns EXACT only when every required attribute agrees", () => {
    const result = matchProduct(
      { description: requested.attributes.standard ?? "pipe", industrialSpec: requested },
      { description: "Carbon steel pipe", industrialSpec: requested },
    );
    expect(result.status).toBe("EXACT");
  });

  it("returns NO_MATCH on a wall-thickness conflict even with a matching price", () => {
    const offered = industrialSpecFromFields("Pipes", {
      description: "Carbon steel pipe",
      size: "6 inch",
      material: "Carbon Steel",
      grade: "A106 Grade B",
      schedule: "SCH 40",
      standard: "ASTM A106",
      otherSpecs: { outsideDiameter: "168.3 mm", wallThickness: "8.18 mm", endPreparation: "Bevelled" },
    });
    const result = matchProduct(
      { description: "pipe", industrialSpec: requested },
      { description: "pipe", industrialSpec: offered },
    );
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/Wall thickness/i);
  });

  it("returns INSUFFICIENT when the supplier omits a required attribute", () => {
    const offered = industrialSpecFromFields("Pipes", {
      description: "Carbon steel pipe",
      size: "6 inch",
      material: "Carbon Steel",
      schedule: "SCH 40",
      standard: "ASTM A106",
      otherSpecs: { outsideDiameter: "168.3 mm", wallThickness: "7.11 mm", endPreparation: "Bevelled" },
    });
    const result = matchProduct(
      { description: "pipe", industrialSpec: requested },
      { description: "pipe", industrialSpec: offered },
    );
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.missing).toContain("Grade");
  });
});
