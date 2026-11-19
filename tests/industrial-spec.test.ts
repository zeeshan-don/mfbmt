import { describe, expect, it } from "vitest";
import { compareIndustrialSpec, requiredAttributes, resolveIndustrialCategory } from "../src/lib/catalog/industrialSpec";

const PIPE = {
  material: "Carbon Steel",
  grade: "ASTM A106 Grade B",
  nominalSize: "4 inch",
  outsideDiameter: "114.3 mm",
  wallThickness: "6.02 mm",
  schedule: "SCH 40",
  standard: "ASTM A106",
  endPreparation: "BEVELED",
};

describe("OGS industrial specifications", () => {
  it("recognises OGS catalogue categories", () => {
    expect(resolveIndustrialCategory("Pipe Fittings")).toBe("Fittings");
    expect(resolveIndustrialCategory("Industrial Valves")).toBe("Valves");
    expect(resolveIndustrialCategory("Chemicals & Solvents")).toBe("Chemicals");
    expect(resolveIndustrialCategory("Industrial Spares")).toBe("Industrial Spares");
  });

  it("requires pipes to state the schedule and dimensions", () => {
    const required = requiredAttributes("Pipes").map((attribute) => attribute.key);
    expect(required).toContain("schedule");
    expect(required).toContain("wallThickness");
    expect(required).toContain("outsideDiameter");
    expect(required).toContain("standard");
  });

  it("matches a pipe only when all required attributes agree", () => {
    const result = compareIndustrialSpec("Pipes", PIPE, { ...PIPE });
    expect(result.status).toBe("EXACT");
    expect(result.mismatches).toHaveLength(0);
  });

  it("treats a wall-thickness conflict as NO_MATCH even if the size matches", () => {
    const result = compareIndustrialSpec("Pipes", PIPE, { ...PIPE, wallThickness: "8.18 mm" });
    expect(result.status).toBe("NO_MATCH");
    expect(result.mismatches.join(" ")).toMatch(/Wall thickness/i);
  });

  it("returns INSUFFICIENT when a required pipe attribute is absent", () => {
    const offered = { ...PIPE, schedule: "" };
    const result = compareIndustrialSpec("Pipes", PIPE, offered);
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.missing).toContain("Schedule");
  });

  it("does not accept a different valve pressure class", () => {
    const requested = {
      valveType: "Gate valve",
      size: "2 inch",
      pressureClass: "Class 150",
      endConnection: "Flanged RF",
      bodyMaterial: "SS316",
      trimMaterial: "SS316",
      operation: "Handwheel",
      standard: "API 600",
    };
    const result = compareIndustrialSpec("Valves", requested, { ...requested, pressureClass: "Class 300" });
    expect(result.status).toBe("NO_MATCH");
  });

  it("does not accept a different flange facing", () => {
    const requested = {
      flangeType: "Weld neck",
      nominalSize: "6 inch",
      pressureClass: "Class 150",
      facing: "RF",
      material: "Carbon Steel",
      grade: "ASTM A105",
      standard: "ASME B16.5",
    };
    const result = compareIndustrialSpec("Flanges", requested, { ...requested, facing: "RTJ" });
    expect(result.status).toBe("NO_MATCH");
  });

  it("requires chemical purity, form and packaging", () => {
    const requested = {
      productName: "Caustic Soda Flakes",
      chemicalGrade: "Technical",
      purity: "99%",
      physicalForm: "Flakes",
      packaging: "25 kg bag",
      quantity: "1000",
      unit: "kg",
    };
    expect(compareIndustrialSpec("Chemicals", requested, { ...requested }).status).toBe("EXACT");
    expect(compareIndustrialSpec("Chemicals", requested, { ...requested, purity: "98%" }).status).toBe("NO_MATCH");
    expect(compareIndustrialSpec("Chemicals", requested, { ...requested, packaging: "" }).status).toBe("INSUFFICIENT");
  });

  it("requires a spare part number and compatible equipment", () => {
    const requested = {
      manufacturer: "Sulzer",
      partNumber: "ABC-123",
      compatibleEquipment: "Pump model X",
      specifications: "Mechanical seal",
    };
    expect(compareIndustrialSpec("Industrial Spares", requested, { ...requested }).status).toBe("EXACT");
    expect(
      compareIndustrialSpec("Industrial Spares", requested, { ...requested, partNumber: "ABC-999" }).status,
    ).toBe("NO_MATCH");
  });

  it("only allows a material substitution when the owner approved it", () => {
    const requested = { material: "SS316", grade: "316", nominalSize: "1 inch", outsideDiameter: "33.4 mm", wallThickness: "3.38 mm", schedule: "SCH 40S", standard: "ASTM A312", endPreparation: "PLAIN" };
    const offered = { ...requested, material: "SS316L" };
    expect(compareIndustrialSpec("Pipes", requested, offered).status).toBe("NO_MATCH");
    const approved = compareIndustrialSpec("Pipes", requested, offered, {
      equivalences: [{ requestedMaterial: "SS316", offeredMaterial: "SS316L", reason: "Owner approved" }],
    });
    expect(approved.status).toBe("EQUIVALENT");
  });
});
