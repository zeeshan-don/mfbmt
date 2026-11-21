import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { hashPassword } from "../src/lib/auth";
import { acceptOwnerInvitation, createOwnerInvitation } from "../src/lib/onboarding/invite";
import { sha256 } from "../src/lib/crypto";

const createdOrganizations: string[] = [];

async function makeOrganization(label: string) {
  const organization = await rawDb.organization.create({
    data: {
      slug: `invite-${label}-${randomUUID().slice(0, 8)}`,
      name: `Invitation Test ${label}`,
      status: "ACTIVE",
      country: "AE",
      timezone: "Asia/Dubai",
      defaultCurrency: "AED",
      quotationPrefix: "IT",
    },
  });
  createdOrganizations.push(organization.id);
  return organization;
}

afterEach(async () => {
  for (const organizationId of createdOrganizations.splice(0)) {
    await rawDb.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  }
  // Remove any cross-tenant fixture users created by these tests.
  const fixtureUsers = await rawDb.user.findMany({ where: { email: { startsWith: "invite-fixture-" } }, select: { id: true } });
  for (const user of fixtureUsers) {
    await rawDb.auditLog.deleteMany({ where: { actorId: user.id } }).catch(() => undefined);
    await rawDb.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

describe("secure OGS owner onboarding", () => {
  it("stores only a token hash and accepts the invitation once", async () => {
    const organization = await makeOrganization("single");
    const email = `invite-fixture-${randomUUID()}@example.com`;
    const invitation = await createOwnerInvitation({ organizationId: organization.id, email, name: "OGS Owner" });
    expect(invitation.ok).toBe(true);
    if (!invitation.ok) return;

    const row = await rawDb.ownerInvitation.findUnique({ where: { id: invitation.invitationId } });
    expect(row?.tokenHash).toBe(sha256(invitation.token));
    expect(row?.tokenHash).not.toContain(invitation.token);
    expect(row?.usedAt).toBeNull();

    const accepted = await acceptOwnerInvitation({ token: invitation.token, password: "Str0ng-Owner-Pass-2026" });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      const user = await rawDb.user.findUnique({ where: { id: accepted.userId } });
      expect(user?.organizationId).toBe(organization.id);
      expect(user?.role).toBe("OWNER");
    }

    const second = await acceptOwnerInvitation({ token: invitation.token, password: "Another-Pass-2026" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already used|not valid/i);
    expect(await rawDb.user.count({ where: { email } })).toBe(1);
  });

  it("refuses an email that already belongs to another tenant", async () => {
    const ownerOrganization = await makeOrganization("owner");
    const target = await makeOrganization("target");
    const email = `invite-fixture-${randomUUID()}@example.com`;
    const owner = await rawDb.user.create({
      data: {
        organizationId: ownerOrganization.id,
        email,
        name: "Existing Tenant Owner",
        passwordHash: await hashPassword("Str0ng-Enough-2026"),
        role: "OWNER",
      },
    });

    const invitation = await createOwnerInvitation({ organizationId: target.id, email, name: "Reused Email" });
    expect(invitation.ok).toBe(false);
    if (!invitation.ok) expect(invitation.error).toMatch(/another workspace|already belongs/i);

    // The existing account is untouched.
    const unchanged = await rawDb.user.findUnique({ where: { id: owner.id } });
    expect(unchanged?.organizationId).toBe(ownerOrganization.id);
    expect(unchanged?.role).toBe("OWNER");
  });

  it("never resets or replaces an existing owner implicitly", async () => {
    const organization = await makeOrganization("existing");
    await rawDb.user.create({
      data: {
        organizationId: organization.id,
        email: `invite-fixture-${randomUUID()}@example.com`,
        name: "Existing Owner",
        passwordHash: await hashPassword("Str0ng-Enough-2026"),
        role: "OWNER",
      },
    });
    const invitation = await createOwnerInvitation({
      organizationId: organization.id,
      email: `invite-fixture-${randomUUID()}@example.com`,
      name: "Second Owner",
    });
    expect(invitation.ok).toBe(false);
    if (!invitation.ok) expect(invitation.error).toMatch(/already exists|never reset/i);
  });

  it("rejects an expired invitation", async () => {
    const organization = await makeOrganization("expired");
    const email = `invite-fixture-${randomUUID()}@example.com`;
    const token = randomUUID();
    await rawDb.ownerInvitation.create({
      data: {
        organizationId: organization.id,
        email,
        name: "Expired Owner",
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const result = await acceptOwnerInvitation({ token, password: "Str0ng-Owner-Pass-2026" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/i);
    expect(await rawDb.user.count({ where: { email } })).toBe(0);
  });
});
