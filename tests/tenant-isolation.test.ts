import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { db } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant";
import { saveIntegration } from "../src/lib/integrations/store";
import { getWhatsAppCredentials, resolveWhatsAppOrganization } from "../src/lib/integrations/whatsapp";
import { enqueueJob } from "../src/lib/workflow/jobs";
import { nextNumber } from "../src/lib/workflow/sequences";
import { writeAudit } from "../src/lib/audit";

const MFBMT = "org_mfbmt";
const OGS = "org_ogs";
const RUN = randomUUID().slice(0, 8);
const SKU = `ISO-${RUN}`;
const EMAIL = `shared-${RUN}@example.test`;
const JOB_KEY = `iso-job-${RUN}`;
const SEQ = `ISO${RUN}`;
const MFBMT_PHONE = `PN-MFBMT-${RUN}`;
const OGS_PHONE = `PN-OGS-${RUN}`;

async function cleanup() {
  await rawDb.supplierOffer.deleteMany({ where: { organizationId: OGS } });
  await rawDb.enquiryItem.deleteMany({ where: { organizationId: OGS } });
  await rawDb.enquiry.deleteMany({ where: { organizationId: OGS } });
  await rawDb.inventoryStock.deleteMany({ where: { organizationId: { in: [MFBMT, OGS] }, product: { sku: SKU } } });
  await rawDb.product.deleteMany({ where: { sku: SKU } });
  await rawDb.user.deleteMany({ where: { email: EMAIL } });
  await rawDb.integration.deleteMany({ where: { organizationId: OGS } });
  await rawDb.backgroundJob.deleteMany({ where: { idempotencyKey: JOB_KEY } });
  await rawDb.numberSequence.deleteMany({ where: { scope: `${SEQ}-${new Date().getFullYear()}` } });
  await rawDb.auditLog.deleteMany({ where: { action: `iso.audit.${RUN}` } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("organization isolation", () => {
  it("allows the same SKU in two companies but never exposes one company's row to the other", async () => {
    const mfbmt = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.product.create({ data: { sku: SKU, name: "MFBMT isolated product", category: "Valves" } }),
    );
    const ogs = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.product.create({ data: { sku: SKU, name: "OGS isolated product", category: "Pipes" } }),
    );

    expect(mfbmt.organizationId).toBe(MFBMT);
    expect(ogs.organizationId).toBe(OGS);
    expect(await rawDb.product.count({ where: { sku: SKU } })).toBe(2);

    const mfbmtView = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.product.findMany({ where: { sku: SKU } }),
    );
    const ogsView = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.product.findUnique({ where: { id: mfbmt.id } }),
    );

    expect(mfbmtView).toHaveLength(1);
    expect(mfbmtView[0].name).toBe("MFBMT isolated product");
    expect(ogsView).toBeNull();
  });

  it("allows the same email in two companies and scopes user lookups", async () => {
    await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.user.create({ data: { email: EMAIL, name: "MFBMT user", passwordHash: "x", role: "OWNER" } }),
    );
    await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.user.create({ data: { email: EMAIL, name: "OGS user", passwordHash: "x", role: "OWNER" } }),
    );

    expect(await rawDb.user.count({ where: { email: EMAIL } })).toBe(2);
    const ogsUsers = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.user.findMany({ where: { email: EMAIL } }),
    );
    expect(ogsUsers).toHaveLength(1);
    expect(ogsUsers[0].organizationId).toBe(OGS);
  });

  it("keeps WhatsApp credentials and webhook routing separate", async () => {
    await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      saveIntegration({
        key: "WHATSAPP",
        status: "CONNECTED",
        secrets: { ACCESS_TOKEN: "mfbmt-token", WABA_ID: "WABA-MFBMT", PHONE_NUMBER_ID: MFBMT_PHONE },
      }),
    );
    await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      saveIntegration({
        key: "WHATSAPP",
        status: "CONNECTED",
        secrets: { ACCESS_TOKEN: "ogs-token", WABA_ID: "WABA-OGS", PHONE_NUMBER_ID: OGS_PHONE },
      }),
    );

    expect(await resolveWhatsAppOrganization(MFBMT_PHONE)).toBe(MFBMT);
    expect(await resolveWhatsAppOrganization(OGS_PHONE)).toBe(OGS);
    expect(await resolveWhatsAppOrganization(`unknown-${RUN}`)).toBeNull();

    const ogsCredentials = await runWithTenant({ organizationId: OGS, source: "test" }, () => getWhatsAppCredentials());
    const mfbmtCredentials = await runWithTenant({ organizationId: MFBMT, source: "test" }, () => getWhatsAppCredentials());
    expect(ogsCredentials?.accessToken).toBe("ogs-token");
    expect(mfbmtCredentials?.accessToken).toBe("mfbmt-token");
  });

  it("scopes catalogued and historical supplier offers", async () => {
    const enquiry = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.enquiry.create({
        data: {
          publicRef: `ISO-ENQ-${RUN}`,
          channel: "MANUAL",
          rawText: "OGS pipe request",
          items: { create: [{ description: "Pipe 4 inch SCH 40", category: "Pipes", quantity: 10, unit: "pcs" }] },
        },
        include: { items: true },
      }),
    );
    const item = enquiry.items[0];
    await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.supplierOffer.create({
        data: { enquiryItemId: item.id, supplierName: "OGS supplier", productTitle: "Pipe", matchStatus: "EXACT" },
      }),
    );

    const mfbmtOffers = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.supplierOffer.findMany({ where: { enquiryItemId: item.id } }),
    );
    const ogsOffers = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.supplierOffer.findMany({ where: { enquiryItemId: item.id } }),
    );
    expect(mfbmtOffers).toHaveLength(0);
    expect(ogsOffers).toHaveLength(1);
  });

  it("scopes job idempotency keys and document sequences per company", async () => {
    await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      enqueueJob({ type: "PURGE_EXPIRED", payload: {}, idempotencyKey: JOB_KEY }),
    );
    await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      enqueueJob({ type: "PURGE_EXPIRED", payload: {}, idempotencyKey: JOB_KEY }),
    );
    expect(await rawDb.backgroundJob.count({ where: { idempotencyKey: JOB_KEY } })).toBe(2);

    const mfbmtJob = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.backgroundJob.findFirst({ where: { idempotencyKey: JOB_KEY } }),
    );
    expect(mfbmtJob?.organizationId).toBe(MFBMT);

    const [mfbmtNumber, ogsNumber] = await Promise.all([
      runWithTenant({ organizationId: MFBMT, source: "test" }, () => nextNumber(SEQ)),
      runWithTenant({ organizationId: OGS, source: "test" }, () => nextNumber(SEQ)),
    ]);
    expect(mfbmtNumber.endsWith("-0001")).toBe(true);
    expect(ogsNumber.endsWith("-0001")).toBe(true);
  });

  it("does not leak audit entries across companies", async () => {
    await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      writeAudit({ action: `iso.audit.${RUN}`, entityType: "Test", actorLabel: "ogs" }),
    );
    const mfbmtAudit = await runWithTenant({ organizationId: MFBMT, source: "test" }, () =>
      db.auditLog.count({ where: { action: `iso.audit.${RUN}` } }),
    );
    const ogsAudit = await runWithTenant({ organizationId: OGS, source: "test" }, () =>
      db.auditLog.count({ where: { action: `iso.audit.${RUN}` } }),
    );
    expect(mfbmtAudit).toBe(0);
    expect(ogsAudit).toBe(1);
  });
});
