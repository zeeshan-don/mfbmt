import { afterAll, describe, expect, it } from "vitest";
import { rawDb } from "../src/lib/db-base";
import { runWithTenant } from "../src/lib/tenant";
import { getIntegrationDiagnostics } from "../src/lib/integrations/diagnostics";
import { encryptSecret } from "../src/lib/crypto";

const rows: string[] = [];

afterAll(async () => {
  for (const id of rows) await rawDb.integration.delete({ where: { id } }).catch(() => undefined);
});

describe("organization-scoped integration diagnostics", () => {
  it("reports stored status without exposing credentials and isolates tenants", async () => {
    const secret = "super-secret-provider-token-value";
    const row = await rawDb.integration.create({
      data: {
        organizationId: "org_mfbmt",
        key: "GMAIL",
        name: "Gmail",
        status: "CONNECTED",
        accountLabel: "mailbox@example.com",
        secretsJson: JSON.stringify({ refreshToken: encryptSecret(secret) }),
        lastSuccessAt: new Date(),
        lastCheckedAt: new Date(),
      },
    });
    rows.push(row.id);

    const mfbmt = await runWithTenant({ organizationId: "org_mfbmt", source: "test" }, () =>
      getIntegrationDiagnostics(),
    );
    const gmail = mfbmt.find((entry) => entry.key === "GMAIL");
    expect(gmail?.connected).toBe(true);
    expect(gmail?.authenticated).toBe(true);
    expect(gmail?.usable).toBe(true);
    expect(JSON.stringify(mfbmt)).not.toContain(secret);
    expect(JSON.stringify(mfbmt)).not.toContain("refreshToken");
    expect(JSON.stringify(mfbmt)).not.toContain("secretsJson");

    const ogs = await runWithTenant({ organizationId: "org_ogs", source: "test" }, () =>
      getIntegrationDiagnostics(),
    );
    const ogsGmail = ogs.find((entry) => entry.key === "GMAIL");
    // MFBMT's connected mailbox must never be reported as OGS's integration.
    expect(ogsGmail?.connected).toBe(false);
    expect(ogsGmail?.authenticated).toBe(false);
    expect(ogsGmail?.usable).toBe(false);
  });

  it("does not claim an integration is connected just because credentials exist", async () => {
    const row = await rawDb.integration.create({
      data: {
        organizationId: "org_ogs",
        key: "AI_PROVIDER",
        name: "AI reading service",
        status: "NOT_CONFIGURED",
        secretsJson: JSON.stringify({ apiKey: encryptSecret("unused-key") }),
      },
    });
    rows.push(row.id);
    const diagnostics = await runWithTenant({ organizationId: "org_ogs", source: "test" }, () =>
      getIntegrationDiagnostics(),
    );
    const ai = diagnostics.find((entry) => entry.key === "AI_PROVIDER");
    expect(ai?.connected).toBe(false);
    expect(ai?.authenticated).not.toBe(true);
    expect(ai?.usable).toBe(false);
  });
});
