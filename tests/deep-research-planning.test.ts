import { describe, expect, it } from "vitest";
import { buildResearchPlan, planFollowUpQueries } from "../src/lib/sourcing/research/planner";
import { ResearchPlanSchema } from "../src/lib/validation/research";

const item = {
  id: "item-1",
  enquiryId: "enq-1",
  description: "Long radius elbow 6 inch carbon steel ASTM A234 WPB schedule 40 class 150 butt weld",
  category: "Fittings",
  brand: null,
  size: "6 inch",
  material: "Carbon Steel",
  grade: "WPB",
  pressureRating: "Class 150",
  schedule: "SCH 40",
  standard: "ASTM A234",
  quantity: 20,
  quantityToSource: 20,
  unit: "pcs",
  missingFields: "[]",
  industrialSpecJson: null,
  fastenerSpecJson: null,
  enquiry: { deliveryLocation: "Dubai, UAE", requestedDeliveryTimeframe: "3 days", urgency: "urgent" },
};

const context = {
  location: "UAE",
  deliveryLocation: "Dubai, UAE",
  deliveryTimeframe: "3 days",
  maxQueries: 40,
};

describe("deep research planner", () => {
  it("keeps the exact technical specification in the exact query", () => {
    const plan = buildResearchPlan(item, context);
    expect(ResearchPlanSchema.safeParse(plan).success).toBe(true);
    const exact = plan.queries.find((query) => query.category === "EXACT_SPECIFICATION");
    expect(exact).toBeDefined();
    for (const required of ["Long radius elbow", "6 inch", "Carbon Steel", "WPB", "SCH 40", "Class 150", "ASTM A234"]) {
      expect(exact?.query).toContain(required);
    }
    expect(exact?.objective).toMatch(/supplier|specification/i);
    expect(exact?.reason.length).toBeGreaterThan(5);
  });

  it("generates terminology, standard, manufacturer, distributor, regional and catalogue intents", () => {
    const plan = buildResearchPlan(item, context);
    const categories = new Set(plan.queries.map((query) => query.category));
    expect(categories.has("COMMON_TERMINOLOGY")).toBe(true);
    expect(categories.has("TECHNICAL_STANDARD")).toBe(true);
    expect(categories.has("MANUFACTURER")).toBe(true);
    expect(categories.has("DISTRIBUTOR")).toBe(true);
    expect(categories.has("REGIONAL")).toBe(true);
    expect(categories.has("CATALOGUE")).toBe(true);
    expect(plan.queries.some((query) => /pdf|catalog/i.test(query.query))).toBe(true);
    expect(plan.queries.some((query) => /Dubai|UAE|Sharjah/i.test(query.query))).toBe(true);
  });

  it("uses common abbreviations and metric conversion only when they add a purpose", () => {
    const plan = buildResearchPlan(
      { ...item, description: "LR elbow 6in CS WPB", size: "6in", material: "CS", standard: "A234" },
      context,
    );
    expect(plan.queries.some((query) => query.category === "COMMON_TERMINOLOGY")).toBe(true);
    expect(plan.queries.some((query) => /152\.4mm|152mm|6in/i.test(query.query))).toBe(true);
    expect(plan.queries.length).toBeLessThanOrEqual(40);
  });

  it("records missing specifications as unknown instead of inventing values", () => {
    const plan = buildResearchPlan(
      {
        ...item,
        description: "Gate valve",
        category: "Valves",
        size: null,
        material: null,
        grade: null,
        pressureRating: null,
        schedule: null,
        standard: null,
        missingFields: JSON.stringify(["Size", "Pressure rating", "Body material"]),
      },
      context,
    );
    expect(plan.product.unknownSpecifications).toEqual(expect.arrayContaining(["Size", "Pressure rating"]));
    expect(plan.product.material).toBeNull();
    expect(plan.notes.join(" ")).toMatch(/gaps, not assumptions/i);
  });

  it("generates bounded follow-up searches from an evidence gap and avoids duplicates", () => {
    const plan = buildResearchPlan(item, context);
    const followups = planFollowUpQueries({
      item,
      plan,
      gaps: [{ domain: "gulf-fittings.example", supplierName: "Gulf Fittings", missing: ["Pressure rating"], reason: "Catalogue did not state the pressure class." }],
      existingQueries: plan.queries.map((query) => query.query),
      iteration: 2,
    });
    expect(followups.length).toBeGreaterThan(0);
    expect(followups.length).toBeLessThanOrEqual(6);
    expect(followups.every((query) => query.category === "FOLLOW_UP" || query.category === "CATALOGUE")).toBe(true);
    expect(followups.some((query) => query.query.startsWith("site:gulf-fittings.example"))).toBe(true);
    expect(followups.some((query) => /pressure rating/i.test(query.objective))).toBe(true);
    expect(new Set(followups.map((query) => query.query.toLowerCase())).size).toBe(followups.length);
  });

  it("bounds overlong extracted text instead of failing plan validation", () => {
    const long = buildResearchPlan(
      {
        ...item,
        description: `Long radius elbow ${"carbon steel ".repeat(30)}`.trim(),
        material: "Carbon Steel".repeat(20),
      },
      context,
    );
    expect(ResearchPlanSchema.safeParse(long).success).toBe(true);
    expect(long.product.productName.length).toBeLessThanOrEqual(240);
    expect(long.queries.every((query) => query.productTarget.length <= 160)).toBe(true);
  });

  it("adds an Arabic query for Gulf delivery locations but not for unrelated markets", () => {
    const gulf = buildResearchPlan(item, { ...context, location: "UAE", deliveryLocation: "Dubai, UAE" });
    expect(gulf.queries.some((query) => /[\u0600-\u06FF]/.test(query.query))).toBe(true);

    const europe = buildResearchPlan(
      { ...item, enquiry: { deliveryLocation: "Berlin, Germany" } },
      { ...context, location: "Germany", deliveryLocation: "Berlin, Germany" },
    );
    expect(europe.queries.some((query) => /[\u0600-\u06FF]/.test(query.query))).toBe(false);
  });

  it("does not treat a service line as a product to research", () => {
    expect(() => buildResearchPlan({ ...item, description: "Hydrotest service for pipe spools" }, context)).toThrow(/service/i);
  });
});
