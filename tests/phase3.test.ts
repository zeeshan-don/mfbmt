import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import {
  buildIndustrialSpec,
  compareIndustrialSpec,
  industrialSpecFromFields,
  isServiceCategory,
  isServiceDescription,
  resolveIndustrialCategory,
} from "../src/lib/catalog/industrialSpec";
import { parseFastenerSpec } from "../src/lib/fasteners/spec";
import { runSourcingForItem } from "../src/lib/sourcing/engine";

const ORG = "org_ogs";
const created: string[] = [];

afterAll(async () => {
  await runWithTenant({ organizationId: ORG, source: "test" }, async () => {
    await db.enquiry.deleteMany({ where: { id: { in: created } } });
  });
  await db.$disconnect();
});

describe("OGS gaskets, insulation and services", () => {
  it("parses a spiral-wound gasket without inventing a filler", () => {
    const spec = industrialSpecFromFields("Gaskets", {
      description: "6 inch Class 150 spiral wound gasket SS316 graphite filler ASME B16.20",
      size: "6 inch",
      pressureRating: "Class 150",
      material: "SS316",
      standard: "ASME B16.20",
    });
    expect(spec?.category).toBe("Gaskets");
    expect(spec?.attributes.gasketType).toBe("Spiral wound");
    expect(spec?.attributes.filler).toBe("graphite");
    expect(spec?.missingRequired).toEqual([]);
  });

  it("detects insulation kits and service lines", () => {
    expect(resolveIndustrialCategory("flange insulation kit")).toBe("Insulation Kits");
    const kit = industrialSpecFromFields("Insulation Kits", {
      description: "Flange insulation kit 6 inch Class 150 phenolic",
      size: "6 inch",
      material: "phenolic",
    });
    expect(kit?.missingRequired).toEqual([]);

    expect(isServiceCategory("Services")).toBe(true);
    expect(isServiceDescription("Machining of flange face")).toBe(true);
    const service = industrialSpecFromFields("Services", {
      description: "Machining of flange face to RTJ profile",
      standard: "ASME B16.5",
    });
    expect(service?.category).toBe("Services");
    expect(service?.attributes.serviceType?.toLowerCase()).toContain("machining");
    expect(service?.missingRequired).toEqual([]);
  });

  it("keeps a gasket type mismatch deterministic", () => {
    const requested = buildIndustrialSpec("Gaskets", {
      gasketType: "Spiral wound",
      size: "6 inch",
      pressureClass: "Class 150",
      material: "SS316",
      standard: "ASME B16.20",
    });
    const offered = { ...requested.attributes, gasketType: "Sheet" };
    expect(compareIndustrialSpec("Gaskets", requested.attributes, offered).status).toBe("NO_MATCH");
  });
});

describe("bolting vocabulary and A194 nut grades", () => {
  it("recognises A194 2H, 2HM, 8 and 8M nut grades", () => {
    for (const grade of ["2H", "2HM", "8", "8M", "7", "4"]) {
      const spec = parseFastenerSpec({
        description: `Hex nut M10 ASTM A194 Grade ${grade} zinc plated carbon steel`,
      });
      expect(spec.type).toBe("HEX_NUT");
      expect(spec.propertyClass).toBe(`A194 ${grade}`);
    }
  });

  it("recognises A193 B7M and U-bolts", () => {
    const stud = parseFastenerSpec({
      description: "Stud bolt M10 x 100 mm ASTM A193 B7M PTFE coated alloy steel",
    });
    expect(stud.type).toBe("STUD");
    expect(stud.propertyClass).toBe("A193 B7M");
    const uBolt = parseFastenerSpec({
      description: "U-bolt M10 x 100 mm A193 B7 zinc plated carbon steel",
    });
    expect(uBolt.type).toBe("U_BOLT");
  });

  it("rejects A194 2H when the customer asked for 2HM", () => {
    const requested = parseFastenerSpec({ description: "Hex nut M10 ASTM A194 2HM zinc plated carbon steel" });
    const offered = parseFastenerSpec({ description: "Hex nut M10 ASTM A194 2H zinc plated carbon steel" });
    expect(requested.propertyClass).toBe("A194 2HM");
    expect(offered.propertyClass).toBe("A194 2H");
  });
});

describe("service lines are not sourced", () => {
  it("marks a service item as manual and does not create a search session", async () => {
    const result = await runWithTenant({ organizationId: ORG, source: "test" }, async () => {
      const enquiry = await db.enquiry.create({
        data: {
          publicRef: `ENQ-SVC-${randomUUID().slice(0, 8)}`,
          channel: "EMAIL",
          rawText: "Please quote machining of flange face",
          status: "READY",
          currency: "AED",
          isDemo: true,
        },
      });
      created.push(enquiry.id);
      const item = await db.enquiryItem.create({
        data: {
          enquiryId: enquiry.id,
          lineNo: 1,
          description: "Machining of flange face to RTJ profile",
          category: "Services",
          quantity: 2,
          unit: "pcs",
          quantityToSource: 2,
          missingFields: "[]",
        },
      });
      const output = await runSourcingForItem(item.id);
      const stored = await db.enquiryItem.findUniqueOrThrow({ where: { id: item.id } });
      return { output, stored, sessions: await db.searchSession.count({ where: { enquiryItemId: item.id } }) };
    });
    expect(result.output.status).toBe("SKIPPED");
    expect(result.stored.sourcingStatus).toBe("NOT_REQUIRED");
    expect(result.sessions).toBe(0);
  });
});
