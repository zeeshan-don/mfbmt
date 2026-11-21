import { AsyncLocalStorage } from "node:async_hooks";
import { rawDb } from "./db-base";
import { sha256 } from "./crypto";

/**
 * Tenant context and the Prisma isolation guard.
 *
 * The organization is derived from the authenticated server-side session
 * (a hashed cookie token looked up in the Session table) or explicitly set by
 * trusted server code for webhooks, supplier response links, OAuth callbacks
 * and background jobs. A browser-supplied organization id is never trusted.
 *
 * For every tenant model the guard:
 *   * adds `organizationId` to reads, aggregates, updates and deletes;
 *   * stamps `organizationId` on creates (including nested relation creates).
 * If no context can be established, production queries fail closed instead of
 * silently running unscoped.
 */

export const SESSION_COOKIE = "mfbmt_session";

export type TenantSource = "session" | "explicit" | "job" | "webhook" | "test" | "internal";

export type TenantContext = {
  organizationId: string;
  userId?: string | null;
  source: TenantSource;
};

type TenantStore = {
  ctx: TenantContext | null;
  unscoped: boolean;
  resolving?: Promise<TenantContext | null>;
};

const storage = new AsyncLocalStorage<TenantStore>();

/** Every model that holds tenant business data. */
export const TENANT_MODELS = new Set([
  "User",
  "Session",
  "Contact",
  "ExcludedContact",
  "Conversation",
  "Message",
  "Attachment",
  "Enquiry",
  "EnquiryItem",
  "Product",
  "ProductSpecification",
  "InventoryLocation",
  "InventoryStock",
  "InventoryMovement",
  "Supplier",
  "SupplierContact",
  "SupplierProduct",
  "SearchSession",
  "SearchQuery",
  "SearchResult",
  "SupplierOffer",
  "SupplierQuote",
  "SupplierQuoteItem",
  "SupplierEmailReply",
  "OwnerInvitation",
  "MfaChallenge",
  "Approval",
  "CustomerQuotation",
  "CustomerQuotationItem",
  "PricingRule",
  "MaterialEquivalence",
  "Integration",
  "BackgroundJob",
  "WebhookEvent",
  "NumberSequence",
  "AuditLog",
  "Notification",
  "ExchangeRate",
  "AiUsage",
  "SearchCache",
  "AppSetting",
]);

export class TenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Tenant context is required for ${model}.${operation}. ` +
        "Authenticate the request or run the operation inside runWithTenant().",
    );
    this.name = "TenantContextError";
  }
}

export function getTenantContext(): TenantContext | null {
  return storage.getStore()?.ctx ?? null;
}

export function getTenantId(): string | null {
  const context = getTenantContext()?.organizationId;
  if (context) return context;
  // Synchronous helpers called from tests see the same default tenant the
  // Prisma guard uses. Production never takes this branch.
  if (process.env.NODE_ENV === "test") return process.env.TEST_ORGANIZATION_ID ?? "org_mfbmt";
  return null;
}

/**
 * Resolves the organization from an explicit context or the authenticated
 * session cookie, then throws if neither exists. Use this in async server code
 * that needs the tenant id outside a Prisma query.
 */
export async function requireTenantId(): Promise<string> {
  const context = await currentTenant();
  if (!context) throw new TenantContextError("tenant", "requireTenantId");
  return context.organizationId;
}

export function isUnscoped(): boolean {
  return storage.getStore()?.unscoped === true;
}

/** Runs work with an explicit, server-derived tenant context. */
export function runWithTenant<T>(context: Omit<TenantContext, "source"> & { source?: TenantSource }, fn: () => T): T {
  const current = storage.getStore();
  return storage.run(
    {
      ctx: { ...context, source: context.source ?? "explicit" },
      unscoped: current?.unscoped ?? false,
    },
    fn,
  );
}

/**
 * Explicit escape hatch for provisioning, migrations and the worker's own
 * queue bookkeeping. Never call this from a tenant-facing request path.
 */
export function runUnscoped<T>(fn: () => T): T {
  const current = storage.getStore();
  return storage.run({ ctx: current?.ctx ?? null, unscoped: true }, fn);
}

// ── Session-derived context ─────────────────────────────────────────────────

type CachedTenant = { organizationId: string; userId: string; expiresAt: number };
const sessionTenantCache = new Map<string, CachedTenant>();
const CACHE_MS = 3_000;

function cacheGet(tokenHash: string): CachedTenant | null {
  const hit = sessionTenantCache.get(tokenHash);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    sessionTenantCache.delete(tokenHash);
    return null;
  }
  return hit;
}

function cacheSet(tokenHash: string, value: CachedTenant) {
  if (sessionTenantCache.size > 500) sessionTenantCache.clear();
  sessionTenantCache.set(tokenHash, value);
}

export function clearTenantSessionCache() {
  sessionTenantCache.clear();
}

/**
 * Resolves the tenant from the httpOnly session cookie. The organisation comes
 * from the Session row, which was written by the server at sign-in; a changed
 * cookie value simply matches no session.
 */
async function resolveFromSessionCookie(): Promise<TenantContext | null> {
  let token: string | undefined;
  try {
    const { cookies } = await import("next/headers");
    token = (await cookies()).get(SESSION_COOKIE)?.value;
  } catch {
    return null; // Not inside a request (worker, CLI, build-time import).
  }
  if (!token) return null;

  const tokenHash = sha256(token);
  const cached = cacheGet(tokenHash);
  if (cached) {
    return { organizationId: cached.organizationId, userId: cached.userId, source: "session" };
  }

  const session = await rawDb.session.findUnique({
    where: { tokenHash },
    select: {
      expiresAt: true,
      organizationId: true,
      user: { select: { id: true, isActive: true, organizationId: true } },
      organization: { select: { status: true } },
    },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  if (session.organization.status !== "ACTIVE") return null;
  // A session can never point at a user from another organization.
  if (session.user.organizationId !== session.organizationId) return null;

  cacheSet(tokenHash, {
    organizationId: session.organizationId,
    userId: session.user.id,
    expiresAt: Date.now() + CACHE_MS,
  });
  return { organizationId: session.organizationId, userId: session.user.id, source: "session" };
}

async function resolveContext(): Promise<TenantContext | null> {
  const store = storage.getStore();
  if (store?.ctx) return store.ctx;

  // Tests use a dedicated PostgreSQL database with two seeded tenants. Default
  // to MFBMT unless a test deliberately enters OGS; isolation tests do exactly
  // that. This keeps the guard active in tests instead of bypassing it.
  if (process.env.NODE_ENV === "test") {
    return { organizationId: process.env.TEST_ORGANIZATION_ID ?? "org_mfbmt", source: "test" };
  }

  const sessionContext = await resolveFromSessionCookie();
  if (sessionContext && store) store.ctx = sessionContext;
  return sessionContext;
}

/** Resolves the tenant once per request even when several queries run. */
export async function currentTenant(): Promise<TenantContext | null> {
  const store = storage.getStore();
  if (!store) return resolveContext();
  if (store.ctx) return store.ctx;
  if (!store.resolving) {
    store.resolving = resolveContext().finally(() => {
      store.resolving = undefined;
    });
  }
  return store.resolving;
}

// ── Prisma guard ────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Adds organizationId to a create payload and to any nested relation creates.
 * Nested writes must carry the tenant explicitly because Prisma does not inherit
 * a scalar from the parent row.
 */
function stampCreate(payload: unknown, organizationId: string): unknown {
  if (Array.isArray(payload)) return payload.map((entry) => stampCreate(entry, organizationId));
  if (!isPlainObject(payload)) return payload;

  const out: Record<string, unknown> = { ...payload, organizationId };
  for (const [key, value] of Object.entries(payload)) {
    if (!isPlainObject(value)) {
      if (Array.isArray(value) && value.some((entry) => isPlainObject(entry) && ("create" in entry || "createMany" in entry))) {
        out[key] = value.map((entry) => stampNested(entry, organizationId));
      }
      continue;
    }
    if ("create" in value || "createMany" in value || "connectOrCreate" in value || "upsert" in value) {
      out[key] = stampNested(value, organizationId);
    }
  }
  return out;
}

function stampNested(payload: unknown, organizationId: string): unknown {
  if (Array.isArray(payload)) return payload.map((entry) => stampNested(entry, organizationId));
  if (!isPlainObject(payload)) return payload;
  const out: Record<string, unknown> = { ...payload };
  if ("create" in out) {
    if (Array.isArray(out.create)) out.create = out.create.map((entry) => stampCreate(entry, organizationId));
    else out.create = stampCreate(out.create, organizationId);
  }
  if ("createMany" in out && isPlainObject(out.createMany)) {
    const createMany = { ...out.createMany };
    createMany.data = stampCreate(createMany.data, organizationId);
    out.createMany = createMany;
  }
  if ("connectOrCreate" in out) out.connectOrCreate = stampNested(out.connectOrCreate, organizationId);
  if ("upsert" in out && isPlainObject(out.upsert)) {
    out.upsert = { ...out.upsert, create: stampCreate((out.upsert as Record<string, unknown>).create, organizationId) };
  }
  // Recurse into relation keys that contain nested writes.
  for (const [key, value] of Object.entries(out)) {
    if (isPlainObject(value) && ("create" in value || "createMany" in value || "connectOrCreate" in value || "upsert" in value) && key !== "upsert") {
      out[key] = stampNested(value, organizationId);
    }
  }
  return out;
}

function scopeWhere(where: unknown, organizationId: string): Record<string, unknown> {
  return { ...(isPlainObject(where) ? where : {}), organizationId };
}

const WRITE_WHERE_OPS = new Set(["update", "updateMany", "delete", "deleteMany", "upsert"]);
const READ_WHERE_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Applies organization ownership to one Prisma operation.
 *
 * This runs in the caller's async context, immediately before the query is
 * dispatched. It must not run inside a Prisma query extension: Prisma resolves
 * extension callbacks outside the caller's AsyncLocalStorage, which would
 * silently lose the explicit tenant (the bug this function exists to avoid).
 */
export function scopeTenantArgs(
  operation: string,
  args: Record<string, unknown>,
  organizationId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args };
  if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
    next.data = stampCreate(next.data, organizationId);
  } else if (operation === "upsert") {
    next.where = scopeWhere(next.where, organizationId);
    next.create = stampCreate(next.create, organizationId);
  } else if (WRITE_WHERE_OPS.has(operation) || READ_WHERE_OPS.has(operation)) {
    next.where = scopeWhere(next.where, organizationId);
  }
  return next;
}

/**
 * Asserts that a record fetched unscoped (for example by an unguessable public
 * token) belongs to the tenant that is about to render it.
 */
export function assertSameTenant(record: { organizationId: string } | null, organizationId: string): boolean {
  return Boolean(record && record.organizationId === organizationId);
}
