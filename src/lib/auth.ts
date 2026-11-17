import bcrypt from "bcryptjs";
import { writeAudit } from "./audit";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import { db } from "./db";
import { PERMISSIONS, type Permission, type Role } from "./constants";
import { parseStringArray } from "./json";

const COOKIE_NAME = "mfbmt_session";
const SESSION_DAYS = 7;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: Permission[];
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

export async function createSession(userId: string, meta?: { ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      ip: meta?.ip?.slice(0, 60),
      userAgent: meta?.userAgent?.slice(0, 240),
    },
  });
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
    await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  store.delete(COOKIE_NAME);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  const role = session.user.role as Role;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role,
    permissions: role === "OWNER" ? [...PERMISSIONS] : (parseStringArray(session.user.permissions) as Permission[]),
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

export function can(user: SessionUser, permission: Permission): boolean {
  return user.role === "OWNER" || user.permissions.includes(permission);
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
 * limit survives restarts and works across processes. Returns true when the caller is locked out.
 */
async function isLoginLocked(emailKey: string, ip?: string): Promise<boolean> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const emailFailures = await db.auditLog.count({
    where: { action: "auth.login_failed", entityId: emailKey, createdAt: { gte: since } },
  });
  if (emailFailures >= MAX_FAILURES_PER_EMAIL) return true;
  if (ip) {
    const ipFailures = await db.auditLog.count({
      where: { action: "auth.login_failed", ip, createdAt: { gte: since } },
    });
    if (ipFailures >= MAX_FAILURES_PER_IP) return true;
  }
  return false;
}

export async function login(email: string, password: string, meta?: { ip?: string; userAgent?: string }) {
  const emailKey = email.trim().toLowerCase();
  if (await isLoginLocked(emailKey, meta?.ip)) {
    return {
      ok: false as const,
      error: "Too many sign-in attempts. Wait 15 minutes or ask the owner to reset the password.",
    };
  }

  const user = await db.user.findUnique({ where: { email: emailKey } });
  const valid = Boolean(user && password && (await verifyPassword(password, user.passwordHash)));
  if (!user || !user.isActive || !valid) {
    await writeAudit({
      actorLabel: emailKey || "unknown",
      action: "auth.login_failed",
      entityType: "User",
      entityId: emailKey,
      ip: meta?.ip ?? null,
    });
    return { ok: false as const, error: "Email or password is incorrect." };
  }
  await createSession(user.id, meta);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { ok: true as const, user };
}
