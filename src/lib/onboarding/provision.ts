import { rawDb } from "../db-base";
import { randomToken, sha256 } from "../crypto";
import { env } from "../env";
import { INVITATION_TTL_HOURS } from "./invite";

/**
 * Operator-only provisioning of a new organization and its first owner.
 *
 * The organization and the one-time owner invitation are created in one
 * transaction. No password is accepted, generated or logged: the owner receives
 * an invitation and sets their own password through the existing
 * acceptOwnerInvitation flow. Duplicate slugs and emails are refused before any
 * write, and a failure rolls the organization back.
 */

export type ProvisionResult =
  | {
      ok: true;
      organizationId: string;
      slug: string;
      invitationId: string;
      inviteUrl: string;
      expiresAt: Date;
      email: string;
    }
  | { ok: false; error: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function provisionOrganizationAndOwner(input: {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  country?: string;
  timezone?: string;
  defaultCurrency?: string;
}): Promise<ProvisionResult> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const ownerEmail = normalizeEmail(input.ownerEmail);
  const ownerName = input.ownerName.trim();

  if (name.length < 2) return { ok: false, error: "An organization name is required." };
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return {
      ok: false,
      error: "The organization slug must be 2-63 lowercase letters, digits or hyphens and must start with a letter or digit.",
    };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return { ok: false, error: "A valid owner email is required." };
  if (ownerName.length < 2) return { ok: false, error: "The owner name is required." };

  try {
    return await rawDb.$transaction(async (tx) => {
      const duplicateOrg = await tx.organization.findUnique({ where: { slug }, select: { id: true } });
      if (duplicateOrg) {
        return { ok: false as const, error: `An organization with slug "${slug}" already exists. Nothing was created.` };
      }
      // The user email is unique per tenant, but an address that already belongs
      // to another workspace must not be reused or moved implicitly.
      const existingUser = await tx.user.findFirst({
        where: { email: ownerEmail },
        select: { organizationId: true, organization: { select: { slug: true } } },
      });
      if (existingUser) {
        return {
          ok: false as const,
          error: `This email already belongs to workspace "${existingUser.organization.slug}". Use a different owner address.`,
        };
      }

      const organization = await tx.organization.create({
        data: {
          name,
          slug,
          country: input.country ?? "AE",
          timezone: input.timezone ?? "Asia/Dubai",
          defaultCurrency: input.defaultCurrency ?? "AED",
          status: "ACTIVE",
        },
      });

      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
      const invitation = await tx.ownerInvitation.create({
        data: {
          organizationId: organization.id,
          email: ownerEmail,
          name: ownerName,
          role: "OWNER",
          tokenHash: sha256(token),
          expiresAt,
          createdByLabel: "operator:create-org",
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          actorLabel: "operator:create-org",
          action: "organization.provisioned",
          entityType: "Organization",
          entityId: organization.id,
          metaJson: JSON.stringify({ slug, ownerEmail, invitationId: invitation.id, expiresAt: expiresAt.toISOString() }),
        },
      });

      return {
        ok: true as const,
        organizationId: organization.id,
        slug,
        invitationId: invitation.id,
        inviteUrl: `${env.APP_URL.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`,
        expiresAt,
        email: ownerEmail,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provisioning failed.";
    return { ok: false, error: `${message} No partial organization was kept.` };
  }
}
