import { describe, expect, it } from "vitest";
import { qualifySupplierCandidate, type ResearchEvidenceRecord } from "../src/lib/sourcing/research/qualification";
import type { ResearchEvidenceClaim, ResearchProductUnderstanding } from "../src/lib/validation/research";

const item = {
  description: "Long radius elbow 6 inch carbon steel ASTM A234 WPB schedule 40 class 150",
  category: "Fittings",
  brand: null,
  size: "6 inch",
  material: "Carbon Steel",
  grade: "WPB",
  pressureRating: "Class 150",
  schedule: "SCH 40",
  standard: "ASTM A234",
  industrialSpecJson: null,
  fastenerSpecJson: null,
};

const understanding: ResearchProductUnderstanding = {
  productFamily: "Elbow",
  productName: "Long radius elbow",
  commonTerminology: ["elbow", "long radius elbow"],
  material: "Carbon Steel",
  grade: "WPB",
  manufacturingStandard: "ASTM A234",
  dimensions: null,
  diameter: "6 inch",
  scheduleOrWallThickness: "SCH 40",
  pressureClass: "Class 150",
  connectionType: "Butt weld",
  finish: null,
  brand: null,
  quantity: 20,
  unit: "pcs",
  deliveryLocation: "Dubai, UAE",
  deliveryTimeframe: "3 days",
  certifications: [],
  mandatorySpecifications: ["Size", "Material"],
  optionalSpecifications: ["Grade", "Pressure rating", "Schedule", "Standard"],
  unknownSpecifications: [],
  alternativesRequiringReview: [],
};

function evidence(field: string, value: string, overrides: Partial<ResearchEvidenceClaim> = {}): ResearchEvidenceRecord {
  return {
    id: `${field}-${value}`,
    field,
    claim: `${field} is ${value}`,
    value,
    sourceUrl: "https://supplier.example/products/elbow",
    pageTitle: "Elbow products",
    sourceType: "PAGE",
    excerpt: `Published ${field}: ${value}`,
    retrievedAt: new Date().toISOString(),
    extractionMethod: "DETERMINISTIC",
    verificationStatus: "SUPPORTED",
    ...overrides,
  };
}

const fullEvidence = [
  evidence("productFamily", "Elbow"),
  evidence("material", "Carbon Steel"),
  evidence("grade", "WPB"),
  evidence("size", "6 inch"),
  evidence("pressureRating", "Class 150"),
  evidence("schedule", "SCH 40"),
  evidence("connection", "Butt weld"),
  evidence("standard", "ASTM A234"),
];

describe("deterministic deep-research qualification", () => {
  it("is EXACT only when every requested critical attribute has comparable evidence", () => {
    const result = qualifySupplierCandidate({ item, understanding, evidence: fullEvidence, hasFamilyEvidence: true });
    expect(result.status).toBe("EXACT");
    expect(result.matchingAttributes.length).toBeGreaterThanOrEqual(6);
    expect(result.missingAttributes).toHaveLength(0);
    expect(result.conflictingAttributes).toHaveLength(0);
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.explanation).toMatch(/published evidence/i);
  });

  it("cannot be EXACT when technical values match but the product family is unconfirmed", () => {
    const result = qualifySupplierCandidate({
      item,
      understanding,
      evidence: fullEvidence.filter((entry) => entry.field !== "productFamily"),
      hasFamilyEvidence: false,
    });
    expect(result.status).toBe("POSSIBLE");
    expect(result.missingAttributes.map((entry) => entry.label)).toContain("Product family");
    expect(result.explanation).toMatch(/product family/i);
  });

  it("cannot be EXACT when a critical attribute is missing", () => {
    const result = qualifySupplierCandidate({
      item,
      understanding,
      evidence: fullEvidence.filter((entry) => entry.field !== "pressureRating"),
      hasFamilyEvidence: true,
    });
    expect(result.status).not.toBe("EXACT");
    expect(result.status).toBe("POSSIBLE");
    expect(result.missingAttributes.map((entry) => entry.label)).toContain("Pressure rating");
  });

  it("returns NO_MATCH on a known material conflict even when every other attribute matches", () => {
    const result = qualifySupplierCandidate({
      item,
      understanding,
      evidence: fullEvidence.map((entry) => (entry.field === "material" ? evidence("material", "SS304") : entry)),
      hasFamilyEvidence: true,
    });
    expect(result.status).toBe("NO_MATCH");
    expect(result.conflictingAttributes.map((entry) => entry.label)).toContain("Material");
  });

  it("keeps product-family evidence as POSSIBLE, never EXACT", () => {
    const result = qualifySupplierCandidate({
      item,
      understanding,
      evidence: [],
      hasFamilyEvidence: true,
    });
    expect(result.status).toBe("POSSIBLE");
    expect(result.matchingAttributes).toHaveLength(0);
    expect(result.explanation).toMatch(/family/i);
  });

  it("never turns search-snippet-only values into strong technical evidence", () => {
    const snippets = fullEvidence.map((entry) => ({
      ...entry,
      sourceType: "SEARCH_SNIPPET" as const,
      verificationStatus: "SNIPPET_ONLY" as const,
    }));
    const result = qualifySupplierCandidate({ item, understanding, evidence: snippets, hasFamilyEvidence: true });
    expect(result.status).toBe("POSSIBLE");
    expect(result.matchingAttributes).toHaveLength(0);
  });

  it("rejects an incorrect standard that looks similar", () => {
    const result = qualifySupplierCandidate({
      item,
      understanding,
      evidence: fullEvidence.map((entry) => (entry.field === "standard" ? evidence("standard", "ASTM A105") : entry)),
      hasFamilyEvidence: true,
    });
    expect(result.status).toBe("NO_MATCH");
    expect(result.conflictingAttributes.map((entry) => entry.label)).toContain("Standard");
  });

  it("treats an owner-approved material substitution as COMPATIBLE, not EXACT", () => {
    const result = qualifySupplierCandidate({
      item: { ...item, material: "SS316" },
      understanding: { ...understanding, material: "SS316" },
      evidence: fullEvidence.map((entry) =>
        entry.field === "material" ? evidence("material", "SS316L") : entry,
      ),
      hasFamilyEvidence: true,
      equivalences: [
        {
          requestedMaterial: "SS316",
          offeredMaterial: "SS316L",
          requestedGrade: "",
          offeredGrade: "",
          reason: "Owner-approved substitution for this service.",
        },
      ],
    });
    expect(result.status).toBe("COMPATIBLE");
    expect(result.usedApprovedEquivalence).toBe(true);
  });

  it("does not allow a missing size to be treated as a size match", () => {
    const result = qualifySupplierCandidate({
      item: { ...item, size: null },
      understanding: { ...understanding, diameter: null },
      evidence: fullEvidence.filter((entry) => entry.field !== "size"),
      hasFamilyEvidence: true,
    });
    expect(result.status).toBe("POSSIBLE");
    expect(result.missingAttributes.map((entry) => entry.label)).toContain("Size");
  });

  it("uses exact industrial-schema requirements, including attributes absent from the RFQ", () => {
    const industrialSpecJson = JSON.stringify({
      version: 1,
      category: "Fittings",
      attributes: {
        fittingType: "Elbow",
        size: "6 inch",
        schedule: "SCH 40",
        material: "Carbon Steel",
        grade: "WPB",
        connection: "Butt weld",
        standard: "ASTM A234",
      },
      missingRequired: [],
      missingOptional: [],
      confidence: {},
      source: "EXTRACTED",
    });
    const result = qualifySupplierCandidate({
      item: { ...item, industrialSpecJson },
      understanding,
      evidence: fullEvidence,
      hasFamilyEvidence: true,
    });
    expect(result.status).toBe("EXACT");
  });
});
