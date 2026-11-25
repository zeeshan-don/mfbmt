import { describe, expect, it } from "vitest";
import {
  composeSupplierRfq,
  cleanSupplierDescription,
  mergeRfqFindings,
  validateSupplierRfqDraft,
  type SupplierRfqItem,
} from "../src/lib/outbound/supplierRfq";

const elbow: SupplierRfqItem = {
  description: "Long-radius elbow, carbon steel, ASTM A234 WPB, 0.5in",
  quantity: 90,
  unit: "pcs",
  size: "0.5in",
  material: "Carbon Steel",
  grade: "A234 WPB",
  standard: "ASTM A234",
  missingFields: ["Pressure class"],
};

function compose(items: SupplierRfqItem[] = [elbow]) {
  return composeSupplierRfq({
    supplierName: "sales@sunnysteel.com",
    companyName: "Multi Fasteners Building Materials Trading LLC",
    enquiryRef: "ENQ-2026-0001",
    items,
    link: "https://app.example/supplier-response/token",
    correlationToken: "A1B2C3D4",
    requiredDelivery: "3 days",
  });
}

describe("supplier-facing RFQ composition", () => {
  it("renders one clean product line without repeating the description or specifications", () => {
    const draft = compose();
    const elbowMentions = draft.body.match(/long-radius elbow/gi) ?? [];
    expect(elbowMentions).toHaveLength(1);
    expect((draft.body.match(/astm a234/gi) ?? []).length).toBe(1);
    expect((draft.body.match(/0\.5in/gi) ?? []).length).toBe(1);
    expect(draft.body).toContain("90 pcs");
    expect(draft.body).toMatch(/please confirm the pressure class/i);
    expect(draft.subject).toContain("[RFQ-A1B2C3D4]");
    expect(draft.ok).toBe(true);
  });

  it("never leaks internal catalogue notes, source references or internal URLs", () => {
    const draft = compose([
      {
        ...elbow,
        description:
          "Long-radius elbow — catalogue-derived product line — Confirm exact item — Catalogue Details row 27",
        internalNotes: "Internal match confidence 0.92; sourceRef Sheet1 row 27; https://ogs.example/catalogue/12",
        sourceRef: "Sheet1 row 27",
      },
    ]);
    expect(draft.body).not.toMatch(/catalogue-derived/i);
    expect(draft.body).not.toMatch(/confirm exact item/i);
    expect(draft.body).not.toMatch(/row 27/i);
    expect(draft.body).not.toMatch(/ogs\.example/i);
    expect(draft.body).not.toMatch(/match confidence/i);
    expect(draft.body).toMatch(/long-radius elbow/i);
  });

  it("does not invent specifications that were not provided", () => {
    const draft = compose([
      {
        description: "Long-radius elbow",
        quantity: 90,
        unit: "pcs",
        missingFields: ["Material", "Grade", "Dimensions", "Pressure class"],
      },
    ]);
    expect(draft.body).not.toMatch(/astm|a234|carbon steel|class 150/i);
    expect(draft.body).toMatch(/please confirm the material/i);
    expect(draft.body).toMatch(/please confirm the grade/i);
  });

  it("keeps multiple legitimate product lines and separate quantities", () => {
    const draft = compose([
      elbow,
      { description: "Gate valve 2 inch SS316 Class 150", quantity: 40, unit: "pcs" },
      { ...elbow, quantity: 25 },
    ]);
    expect(draft.items).toHaveLength(3);
    expect(draft.body).toMatch(/gate valve/i);
    expect((draft.body.match(/90 pcs/g) ?? []).length).toBe(1);
    expect(draft.body).toMatch(/25 pcs/);
  });

  it("collapses the same product repeated by the original request", () => {
    const draft = compose([elbow, { ...elbow }]);
    expect(draft.items).toHaveLength(1);
    expect((draft.body.match(/long-radius elbow/gi) ?? []).length).toBe(1);
  });

  it("strips duplicated specification text from a catalogue-style description", () => {
    const description = cleanSupplierDescription(
      "Long radius elbow carbon steel ASTM A234 WPB 0.5in — carbon steel — ASTM A234",
      { material: "Carbon Steel", standard: "ASTM A234", size: "0.5in" },
    );
    expect(description).toMatch(/long radius elbow/i);
    expect((description.match(/carbon steel/gi) ?? []).length).toBe(1);
  });
});

describe("supplier RFQ draft validation", () => {
  it("accepts a clean draft", () => {
    const draft = compose();
    expect(draft.findings.filter((finding) => finding.severity === "error")).toHaveLength(0);
  });

  it("blocks duplicate product lines", () => {
    const findings = validateSupplierRfqDraft({
      subject: "RFQ",
      body: compose().body,
      items: [elbow, { ...elbow }],
    });
    expect(findings.some((finding) => finding.code === "DUPLICATE_ITEM" && finding.severity === "error")).toBe(true);
  });

  it("blocks internal wording, repeated URLs, empty labels and dangling specifications", () => {
    const findings = validateSupplierRfqDraft({
      subject: "RFQ",
      body:
        "Dear Sales Team,\n1. Elbow — 90 pcs\n" +
        "catalogue-derived product line\n" +
        "https://ogs.example/catalogue/1 https://ogs.example/catalogue/1\n" +
        "Size: \n0.5in - MS",
      items: [elbow],
    });
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain("INTERNAL_WORDING");
    expect(codes).toContain("REPEATED_URL");
    expect(codes).toContain("EMPTY_SPEC_LABEL");
    expect(codes).toContain("DANGLING_SPECIFICATION");
  });

  it("does not treat an attached size and material as a dangling fragment", () => {
    const findings = validateSupplierRfqDraft({
      subject: "RFQ",
      body: "1. Long radius elbow, 0.5in - MS — 90 pcs",
      items: [{ description: "Long radius elbow, 0.5in - MS", quantity: 90, unit: "pcs" }],
    });
    expect(findings.some((finding) => finding.code === "DANGLING_SPECIFICATION")).toBe(false);
  });

  it("blocks a missing quantity and a line that is not a product", () => {
    const findings = validateSupplierRfqDraft({
      subject: "RFQ",
      body: "Hi, I need these items urgently in 3 days.",
      items: [{ description: "Hi, I need these items urgently in 3 days.", quantity: null, unit: "pcs" }],
    });
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain("MISSING_QUANTITY");
    expect(codes).toContain("NOT_A_PRODUCT");
  });

  it("blocks contradictory material or size", () => {
    const findings = validateSupplierRfqDraft({
      subject: "RFQ",
      body: "1. Elbow SS316 0.5in — 10 pcs",
      items: [
        {
          description: "Elbow SS316 0.5in",
          quantity: 10,
          unit: "pcs",
          material: "MS",
          size: "1in",
        },
      ],
    });
    expect(findings.filter((finding) => finding.code === "CONTRADICTORY_SPECIFICATION").length).toBeGreaterThan(0);
  });

  it("merges deterministic and semantic findings without dropping either", () => {
    const merged = mergeRfqFindings(
      [{ code: "MISSING_QUANTITY", severity: "error", message: "No quantity." }],
      [{ code: "UNPROFESSIONAL", severity: "warning", message: "Unprofessional wording." }],
    );
    expect(merged).toHaveLength(2);
  });
});
