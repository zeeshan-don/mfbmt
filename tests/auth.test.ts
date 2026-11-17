import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { hashPassword, login } from "../src/lib/auth";

const EMAIL = "throttle-test@mfbmt.local";

beforeEach(async () => {
  await db.auditLog.deleteMany({ where: { entityId: EMAIL } });
  await db.user.deleteMany({ where: { email: EMAIL } });
  await db.user.create({
    data: {
      email: EMAIL,
      name: "Throttle Test",
      role: "STAFF",
      passwordHash: await hashPassword("CorrectHorse123!"),
      isActive: true,
    },
  });
});

describe("sign-in throttling", () => {
  it("returns the same message for an unknown account and a wrong password", async () => {
    const unknown = await login("nobody@mfbmt.local", "whatever", { ip: "10.0.0.1" });
    const wrong = await login(EMAIL, "wrong-password", { ip: "10.0.0.1" });
    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (unknown.ok || wrong.ok) return;
    expect(unknown.error).toBe("Email or password is incorrect.");
    expect(wrong.error).toBe(unknown.error);
  });

  it("locks an account after repeated failures and records them", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await login(EMAIL, "wrong-password", { ip: "10.0.0.2" });
      expect(result.ok).toBe(false);
    }

    // Even the correct password is refused while the account is locked.
    const locked = await login(EMAIL, "CorrectHorse123!", { ip: "10.0.0.2" });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.error).toContain("Too many sign-in attempts");

    const failures = await db.auditLog.count({
      where: { action: "auth.login_failed", entityId: EMAIL },
    });
    expect(failures).toBe(8);
  });

  it("does not lock an account after a single typo", async () => {
    const result = await login(EMAIL, "wrong-password", { ip: "10.0.0.3" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Email or password is incorrect.");
    // The account is still usable: the next attempt is evaluated normally (and fails on the password,
    // not on a lock), which is observable from the message.
    const second = await login(EMAIL, "still-wrong", { ip: "10.0.0.3" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("Email or password is incorrect.");
  });
});
