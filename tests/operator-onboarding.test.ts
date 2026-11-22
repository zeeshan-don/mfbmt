import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { provisionOrganizationAndOwner } from "../src/lib/onboarding/provision";
import { acceptOwnerInvitation } from "../src/lib/onboarding/invite";
import { sha256 } from "../src/lib/crypto";

const createdOrganizations: string[] = [];

afterEach(async () => {
  for (const organizationId of createdOrganizations.splice(0)) {
    await rawDb.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  }
});

function unique(prefix: string) {
  const token = randomUUID().slice(0, 8);
  return {
    slug: `${prefix}-${token}`,
    email: `${prefix}-${token}@example.com`,
  };
}

describe("operator create-org onboarding", () => {
  it("creates the organization and a single-use invitation, not a password account", async () => {
    const { slug, email } = unique("provision");
    const result = await provisionOrganizationAndOwner({
      name: "Provisioned Company",
      slug,
      ownerEmail: email,
      ownerName: "Provisioned Owner",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdOrganizations.push(result.organizationId);

    const organization = await rawDb.organization.findUnique({ where: { id: result.organizationId } });
    expect(organization?.slug).toBe(slug);
    expect(await rawDb.user.count({ where: { organizationId: result.organizationId } })).toBe(0);

    const invitation = await rawDb.ownerInvitation.findUnique({ where: { id: result.invitationId } });
    expect(invitation?.email).toBe(email);
    expect(invitation?.tokenHash).toBe(sha256(new URL(result.inviteUrl).searchParams.get("token")!));
    expect(invitation?.usedAt).toBeNull();

    const accepted = await acceptOwnerInvitation({
      token: new URL(result.inviteUrl).searchParams.get("token")!,
      password: "Str0ng-Owner-Pass-2026",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      const user = await rawDb.user.findUnique({ where: { id: accepted.userId } });
      expect(user?.organizationId).toBe(result.organizationId);
      expect(user?.role).toBe("OWNER");
    }
    // The invitation cannot be accepted twice.
    const replay = await acceptOwnerInvitation({
      token: new URL(result.inviteUrl).searchParams.get("token")!,
      password: "Another-Str0ng-Pass-2026",
    });
    expect(replay.ok).toBe(false);
  });

  it("refuses a duplicate slug without creating a second organization", async () => {
    const { slug, email } = unique("dupeslug");
    const first = await provisionOrganizationAndOwner({
      name: "First Company",
      slug,
      ownerEmail: email,
      ownerName: "First Owner",
    });
    expect(first.ok).toBe(true);
    if (first.ok) createdOrganizations.push(first.organizationId);

    const second = await provisionOrganizationAndOwner({
      name: "Second Company",
      slug,
      ownerEmail: unique("second").email,
      ownerName: "Second Owner",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already exists/i);
    expect(await rawDb.organization.count({ where: { slug } })).toBe(1);
  });

  it("refuses an owner email that belongs to another workspace and keeps no partial organization", async () => {
    const first = unique("ownerone");
    const provisioned = await provisionOrganizationAndOwner({
      name: "Existing Workspace",
      slug: first.slug,
      ownerEmail: first.email,
      ownerName: "Existing Owner",
    });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    createdOrganizations.push(provisioned.organizationId);

    const accepted = await acceptOwnerInvitation({
      token: new URL(provisioned.inviteUrl).searchParams.get("token")!,
      password: "Str0ng-Owner-Pass-2026",
    });
    expect(accepted.ok).toBe(true);

    const secondSlug = unique("ownertwo").slug;
    const blocked = await provisionOrganizationAndOwner({
      name: "Should Roll Back",
      slug: secondSlug,
      ownerEmail: first.email,
      ownerName: "Reused Owner",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/already belongs/i);
    // The transaction rolled back: the second organization does not exist.
    expect(await rawDb.organization.count({ where: { slug: secondSlug } })).toBe(0);
  });

  it("validates input before writing anything", async () => {
    const invalid = await provisionOrganizationAndOwner({
      name: "X",
      slug: "Not A Slug",
      ownerEmail: "not-an-email",
      ownerName: "Y",
    });
    expect(invalid.ok).toBe(false);
    expect(await rawDb.organization.count({ where: { name: "X" } })).toBe(0);
  });
});
