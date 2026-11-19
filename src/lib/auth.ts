import bcrypt from "bcryptjs";
import { writeAudit } from "./audit";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import { rawDb } from "./db-base";
import { PERMISSIONS, type Permission, type Role } from "./constants";
import { parseStringArray } from "./json";
import { env } from "./env";
import { SESSION_COOKIE, clearTenantSessionCache } from "./tenant";

const COOKIE_NAME = SESSION_COOKIE;
/** One validated setting drives both the cookie and the database expiry. */
const SESSION_DAYS = Math.max(1, Math.min(90, env.AUTH_SESSION_DAYS));

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: Permission[];
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  organizationStatus: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  user: { id: string; organizationId: string },
  meta?: { ip?: string; userAgent?: string },
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await rawDb.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      organizationId: user.organizationId,
      expiresAt,
      ip: meta?.ip?.slice(0, 60),
      userAgent: meta?.userAgent?.slice(0, 240),
    },
  });
  clearTenantSessionCache();
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    await rawDb.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  clearTenantSessionCache();
  store.delete(COOKIE_NAME);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await rawDb.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { organization: true } } },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  if (session.user.organizationId !== session.organizationId) return null;
  const organization = session.user.organization;
  if (!organization || organization.status !== "ACTIVE") return null;
  const role = session.user.role as Role;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role,
    permissions: role === "OWNER" ? [...PERMISSIONS] : (parseStringArray(session.user.permissions) as Permission[]),
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organizationName: organization.name,
    organizationStatus: organization.status,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "OWNER") redirect("/?denied=1");
  return user;
}

/** Page guard: the navigation hiding an item is not the authorization boundary. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) redirect("/?denied=1");
  return user;
}

export function can(user: SessionUser, permission: Permission): boolean {
  return user.role === "OWNER" || user.permissions.includes(permission);
}

/** Only the owner may see supplier cost, margin and decision controls. */
export function canSeeSupplierCosts(user: SessionUser): boolean {
  return user.role === "OWNER";
}

/** For API routes / server actions: returns null instead of redirecting. */
export async function authorize(permission?: Permission): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  if (permission && !can(user, permission)) return null;
  return user;
}

export async function authorizeOwner(): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (!user || user.role !== "OWNER") return null;
  return user;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 8;
const MAX_FAILURES_PER_IP = 30;

/**
 * Counts recent failures in the audit log instead of keeping counters in memory, so the
 * limit survives restarts and works across processes. The email key includes the
 * workspace slug when one is supplied, so one company's failures cannot lock the
 * same address out in another company.
 */
async function isLoginLocked(emailKey: string, ip?: string): Promise<boolean> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const emailFailures = await rawDb.auditLog.count({
    where: { action: "auth.login_failed", entityId: emailKey, createdAt: { gte: since } },
  });
  if (emailFailures >= MAX_FAILURES_PER_EMAIL) return true;
  if (ip) {
    const ipFailures = await rawDb.auditLog.count({
      where: { action: "auth.login_failed", ip, createdAt: { gte: since } },
    });
    if (ipFailures >= MAX_FAILURES_PER_IP) return true;
  }
  return false;
}

type LoginMeta = { ip?: string; userAgent?: string; workspace?: string };

/**
 * Signs a user in.
 *
 * The workspace slug is optional when an address exists in exactly one active
 * company. If the same address exists in several companies, the slug is
 * required and the sign-in is never guessed, so a person can never be logged
 * into the wrong tenant.
 */
export async function login(email: string, password: string, meta?: LoginMeta) {
  const emailKey = email.trim().toLowerCase();
  const workspace = meta?.workspace?.trim().toLowerCase() || null;
  const auditKey = workspace ? `${workspace}:${emailKey}` : emailKey;

  if (await isLoginLocked(auditKey, meta?.ip)) {
    return {
      ok: false as const,
      error: "Too many sign-in attempts. Wait 15 minutes or ask the owner to reset the password.",
    };
  }

  const organization = workspace
    ? await rawDb.organization.findUnique({ where: { slug: workspace } })
    : null;

  const candidates = workspace
    ? organization
      ? await rawDb.user.findMany({
          where: { email: emailKey, organizationId: organization.id },
          include: { organization: true },
        })
      : []
    : await rawDb.user.findMany({
        where: { email: emailKey },
        include: { organization: true },
      });

  const usable = candidates.filter((candidate) => candidate.isActive && candidate.organization.status === "ACTIVE");
  const distinctOrganizations = new Set(usable.map((candidate) => candidate.organizationId));

  if (!workspace && distinctOrganizations.size > 1) {
    return {
      ok: false as const,
      error:
        "This email address is used by more than one company. Sign in with your workspace name, or use the link your company gave you.",
    };
  }

  const user = usable.length === 1 ? usable[0] : null;
  const valid = Boolean(user && password && (await verifyPassword(password, user.passwordHash)));
  if (!user || !valid) {
    await writeAudit({
      organizationId: user?.organizationId ?? organization?.id ?? null,
      actorLabel: emailKey || "unknown",
      action: "auth.login_failed",
      entityType: "User",
      entityId: auditKey,
      ip: meta?.ip ?? null,
    });
    return { ok: false as const, error: "Email or password is incorrect." };
  }

  await createSession({ id: user.id, organizationId: user.organizationId }, meta);
  await rawDb.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { ok: true as const, user };
}
