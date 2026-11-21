import { rawDb } from "../db-base";
import { db } from "../db";
import { hashPassword } from "../auth";
import { passwordProblem } from "../account";
import { sha256, randomToken } from "../crypto";
import { writeAudit } from "../audit";
import { env } from "../env";
import { runWithTenant } from "../tenant";

/**
 * One-time owner invitation.
 *
 * Only the SHA-256 hash of a high-entropy token is stored. The token is shown
 * once by the provisioning command, expires, is single-use, and is never
 * emailed automatically. The invitee sets their own password; no initial
 * permanent password is generated, printed or logged.
 *
 * Provisioning is per organization and refuses to reuse an account that already
 * exists in another tenant. An existing owner is never reset implicitly.
 */

export const INVITATION_TTL_HOURS = 72;

export type InvitationResult =
  | {
      ok: true;
      invitationId: string;
      token: string;
      inviteUrl: string;
      expiresAt: Date;
      organizationSlug: string;
      email: string;
    }
  | { ok: false; error: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createOwnerInvitation(input: {
  organizationId?: string;
  organizationSlug?: string;
  email: string;
  name: string;
  createdByLabel?: string;
}): Promise<InvitationResult> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "A valid owner email is required." };
  if (name.length < 2) return { ok: false, error: "A name is required." };

  const organization = input.organizationId
    ? await rawDb.organization.findUnique({ where: { id: input.organizationId } })
    : input.organizationSlug
      ? await rawDb.organization.findUnique({ where: { slug: input.organizationSlug.trim().toLowerCase() } })
      : null;
  if (!organization) return { ok: false, error: "The organization was not found. Pass an explicit organization slug." };
  if (organization.status !== "ACTIVE") {
    return { ok: false, error: `Organization ${organization.slug} is ${organization.status}, not active.` };
  }

  // The email is unique per organization, not globally. An address that belongs
  // to another tenant must never be silently reused or moved.
  const existingUsers = await rawDb.user.findMany({
    where: { email },
    select: { id: true, organizationId: true, role: true, organization: { select: { slug: true } } },
  });
  const inThisOrganization = existingUsers.find((user) => user.organizationId === organization.id);
  if (inThisOrganization) {
    return {
      ok: false,
      error: `This email already has an account in ${organization.slug}. Use the password-reset flow instead of an owner invitation.`,
    };
  }
  const inAnotherOrganization = existingUsers.find((user) => user.organizationId !== organization.id);
  if (inAnotherOrganization) {
    return {
      ok: false,
      error:
        `This email already belongs to another workspace (${inAnotherOrganization.organization.slug}). ` +
        "Do not reuse an existing account across tenants; use a different address.",
    };
  }

  const existingOwner = await rawDb.user.findFirst({
    where: { organizationId: organization.id, role: "OWNER" },
    select: { email: true },
  });
  if (existingOwner) {
    return {
      ok: false,
      error: `An owner already exists in ${organization.slug} (${existingOwner.email}). Invitations never reset an existing owner.`,
    };
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);

  return runWithTenant({ organizationId: organization.id, source: "internal" }, async () => {
    // Remove only unused, expired invitations for the same address in this tenant.
    await db.ownerInvitation.deleteMany({
      where: { email, usedAt: null, expiresAt: { lt: new Date() } },
    });
    const invitation = await db.ownerInvitation.create({
      data: {
        organizationId: organization.id,
        email,
        name,
        role: "OWNER",
        tokenHash: sha256(token),
        expiresAt,
        createdByLabel: input.createdByLabel ?? "provisioning",
      },
    });
    await writeAudit({
      action: "auth.owner_invitation_created",
      entityType: "OwnerInvitation",
      entityId: invitation.id,
      actorLabel: input.createdByLabel ?? "provisioning",
      meta: { email, organizationSlug: organization.slug, expiresAt: expiresAt.toISOString() },
    });
    return {
      ok: true as const,
      invitationId: invitation.id,
      token,
      inviteUrl: `${env.APP_URL.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`,
      expiresAt,
      organizationSlug: organization.slug,
      email,
    };
  });
}

export type AcceptInvitationResult = { ok: true; userId: string } | { ok: false; error: string };

export async function acceptOwnerInvitation(input: {
  token: string;
  password: string;
  name?: string;
}): Promise<AcceptInvitationResult> {
  if (!input.token) return { ok: false, error: "This invitation link is not valid." };
  const problem = passwordProblem(input.password);
  if (problem) return { ok: false, error: problem };

  const invitation = await rawDb.ownerInvitation.findUnique({
    where: { tokenHash: sha256(input.token) },
  });
  if (!invitation) return { ok: false, error: "This invitation link is not valid." };
  if (invitation.usedAt) return { ok: false, error: "This invitation was already used. Ask for a new invitation." };
  if (invitation.expiresAt.getTime() < Date.now()) return { ok: false, error: "This invitation has expired. Ask for a new one." };

  const organization = await rawDb.organization.findUnique({ where: { id: invitation.organizationId } });
  if (!organization || organization.status !== "ACTIVE") {
    return { ok: false, error: "This workspace is not active. Contact the platform administrator." };
  }

  const conflicting = await rawDb.user.findFirst({ where: { email: invitation.email } });
  if (conflicting) {
    return {
      ok: false,
      error:
        conflicting.organizationId === invitation.organizationId
          ? "An account already exists for this invitation. Use the password-reset flow instead."
          : "This email already belongs to another workspace. The invitation cannot be accepted.",
    };
  }

  return runWithTenant({ organizationId: invitation.organizationId, source: "internal" }, async () => {
    const passwordHash = await hashPassword(input.password);
    const user = await db.$transaction(async (tx) => {
      const claimed = await tx.ownerInvitation.updateMany({
        where: { id: invitation.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw new Error("This invitation was already used or has expired.");
      return tx.user.create({
        data: {
          organizationId: invitation.organizationId,
          email: invitation.email,
          name: (input.name ?? invitation.name).trim(),
          passwordHash,
          role: invitation.role === "OWNER" ? "OWNER" : "STAFF",
          isActive: true,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
    });

    await writeAudit({
      action: "auth.owner_invitation_accepted",
      entityType: "User",
      entityId: user.id,
      actorId: user.id,
      actorLabel: user.email,
      meta: { invitationId: invitation.id, organizationSlug: organization.slug },
    });
    return { ok: true as const, userId: user.id };
  }).catch((error) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "The invitation could not be accepted.",
  }));
}

export async function invitationPreview(token: string) {
  if (!token) return null;
  const invitation = await rawDb.ownerInvitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { organization: { select: { name: true, slug: true, status: true } } },
  });
  if (!invitation) return null;
  return {
    email: invitation.email,
    name: invitation.name,
    expiresAt: invitation.expiresAt,
    used: Boolean(invitation.usedAt),
    organizationName: invitation.organization.name,
    organizationSlug: invitation.organization.slug,
  };
}
