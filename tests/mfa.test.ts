import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { rawDb } from "../src/lib/db-base";
import { hashPassword } from "../src/lib/auth";
import { runWithTenant } from "../src/lib/tenant";
import { sha256 } from "../src/lib/crypto";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  createMfaChallenge,
  generateTotpSecret,
  totpCode,
  verifyMfaChallenge,
  verifyTotp,
} from "../src/lib/mfa";

const ORG = "org_mfbmt";
const EMAIL = `mfa-${randomUUID().slice(0, 8)}@example.test`;
let userId = "";

beforeAll(async () => {
  await runWithTenant({ organizationId: ORG, source: "test" }, async () => {
    const user = await db.user.create({
      data: {
        email: EMAIL,
        name: "MFA test owner",
        passwordHash: await hashPassword("CorrectHorse123"),
        role: "OWNER",
      },
    });
    userId = user.id;
  });
});

afterAll(async () => {
  await rawDb.mfaChallenge.deleteMany({ where: { userId } });
  await rawDb.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("TOTP MFA", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(secret, "287082", 59_000, 0)).toEqual({ ok: true, counter: 1 });
    expect(verifyTotp(secret, "000000", 59_000, 0).ok).toBe(false);
  });

  it("enrols with a valid code and returns recovery codes exactly once", async () => {
    const started = await runWithTenant({ organizationId: ORG, source: "test" }, () =>
      beginMfaEnrollment({ userId, password: "CorrectHorse123", email: EMAIL }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const counter = Math.floor(Date.now() / 1000 / 30);
    const confirmed = await runWithTenant({ organizationId: ORG, source: "test" }, () =>
      confirmMfaEnrollment({ userId, code: totpCode(started.secret, counter), actorLabel: "test" }),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.recoveryCodes).toHaveLength(10);
    const stored = await rawDb.user.findUnique({ where: { id: userId } });
    expect(stored?.mfaEnabledAt).not.toBeNull();
    expect(stored?.mfaRecoveryCodesJson).not.toContain(confirmed.recoveryCodes[0]);
  });

  it("consumes a TOTP challenge once and rejects a replayed counter", async () => {
    const user = await rawDb.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = generateTotpSecret();
    await rawDb.user.update({
      where: { id: userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date(), mfaLastUsedCounter: 0 },
    });
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = totpCode(secret, counter);

    const first = await createMfaChallenge(user.id, ORG);
    expect(await verifyMfaChallenge({ token: first.token, code })).toMatchObject({ ok: true });
    expect(await verifyMfaChallenge({ token: first.token, code })).toMatchObject({ ok: false });

    const second = await createMfaChallenge(user.id, ORG);
    expect(await verifyMfaChallenge({ token: second.token, code })).toMatchObject({ ok: false });
  });

  it("accepts a recovery code once and removes it from storage", async () => {
    const recovery = "ABCDE-12345";
    await rawDb.user.update({
      where: { id: userId },
      data: {
        mfaSecret: generateTotpSecret(),
        mfaEnabledAt: new Date(),
        mfaLastUsedCounter: null,
        mfaRecoveryCodesJson: JSON.stringify([sha256("ABCDE12345")]),
      },
    });
    const first = await createMfaChallenge(userId, ORG);
    expect(await verifyMfaChallenge({ token: first.token, code: recovery })).toMatchObject({ ok: true });
    const stored = await rawDb.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.mfaRecoveryCodesJson).toBe("[]");

    const second = await createMfaChallenge(userId, ORG);
    expect(await verifyMfaChallenge({ token: second.token, code: recovery })).toMatchObject({ ok: false });
  });
});
