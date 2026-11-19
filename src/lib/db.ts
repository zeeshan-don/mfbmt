import "./load-env";
import type { Prisma, PrismaClient } from "@prisma/client";
import { rawDb } from "./db-base";
import { TENANT_MODELS, TenantContextError, currentTenant, scopeTenantArgs } from "./tenant";

/**
 * Tenant-safe Prisma client.
 *
 * Scoping happens in the caller's async context, immediately before a query is
 * dispatched — not inside a Prisma query extension. Prisma executes extension
 * callbacks outside the caller's AsyncLocalStorage, so an extension-based guard
 * silently falls back to the default tenant (and leaks data) when an explicit
 * context, webhook or background job sets the tenant.
 *
 * Behaviour:
 *   * every tenant model's reads/aggregates/updates/deletes are filtered by
 *     organizationId;
 *   * creates (including nested relation creates) are stamped with it;
 *   * no context means TenantContextError, never an unscoped query;
 *   * `$transaction` wraps the callback's `tx` with the same rules;
 *   * global models (Organization, WorkerHeartbeat) and raw SQL pass through.
 *
 * Use `rawDb` from ./db-base only for pre-tenant/system operations.
 */

type AnyClient = PrismaClient | Prisma.TransactionClient;
type AnyRecord = Record<string, unknown>;

/**
 * TENANT_MODELS is keyed by Prisma model name ("Product"); client delegates are
 * camelCase ("product"). Mapping explicitly keeps the guard from silently
 * missing every delegate.
 */
function canonicalModel(delegate: string): string {
  return delegate.charAt(0).toUpperCase() + delegate.slice(1);
}

const scopedClients = new Map<string, AnyClient>();

/** A client whose tenant is fixed at construction (safe for transaction callbacks). */
function scopedClient(base: AnyClient, organizationId: string): AnyClient {
  return new Proxy(base as unknown as AnyRecord, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property, target);
      const value = Reflect.get(target, property, target);
      if (property.startsWith("$") || !TENANT_MODELS.has(canonicalModel(property)) || !value || typeof value !== "object") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return new Proxy(value as AnyRecord, {
        get(model, operation) {
          if (typeof operation !== "string") return Reflect.get(model, operation, model);
          const method = Reflect.get(model, operation, model);
          if (typeof method !== "function") return method;
          return (...args: unknown[]) => {
            const input = (args[0] ?? {}) as AnyRecord;
            const scoped = scopeTenantArgs(operation, input, organizationId);
            return method.apply(model, [scoped, ...args.slice(1)]);
          };
        },
      });
    },
  }) as unknown as AnyClient;
}

function cachedScopedClient(organizationId: string): AnyClient {
  const existing = scopedClients.get(organizationId);
  if (existing) return existing;
  const client = scopedClient(rawDb, organizationId);
  if (scopedClients.size > 100) scopedClients.clear();
  scopedClients.set(organizationId, client);
  return client;
}

async function tenantId(operation: string): Promise<string> {
  const context = await currentTenant();
  if (!context) throw new TenantContextError("database", operation);
  return context.organizationId;
}

/** Model facade that resolves the tenant per operation (session or explicit context). */
function tenantModel(model: string): AnyRecord {
  return new Proxy(
    {},
    {
      get(_target, operation) {
        if (typeof operation !== "string") return undefined;
        if (operation === "then") return undefined;
        return async (...args: unknown[]) => {
          const client = cachedScopedClient(await tenantId(`${model}.${operation}`));
          const delegate = (client as unknown as AnyRecord)[model] as AnyRecord;
          const method = delegate[operation] as (...params: unknown[]) => Promise<unknown>;
          return method.apply(delegate, args);
        };
      },
    },
  );
}

const modelFacades = new Map<string, AnyRecord>();

function dbProxy(): PrismaClient {
  return new Proxy(rawDb as unknown as AnyRecord, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property, target);

      if (property === "$transaction") {
        return async (
          input: unknown,
          options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
        ) => {
          const organizationId = await tenantId("$transaction");
          const transaction = (target.$transaction as unknown as (
            fn: unknown,
            options?: unknown,
          ) => Promise<unknown>).bind(target);
          if (typeof input === "function") {
            return transaction(
              async (tx: Prisma.TransactionClient) =>
                (input as (client: Prisma.TransactionClient) => Promise<unknown>)(scopedClient(tx, organizationId)),
              options,
            );
          }
          return transaction(input, options);
        };
      }

      if (
        property === "$queryRaw" ||
        property === "$queryRawUnsafe" ||
        property === "$executeRaw" ||
        property === "$executeRawUnsafe"
      ) {
        const method = Reflect.get(target, property, target);
        return (method as (...params: unknown[]) => unknown).bind(target);
      }

      if (property.startsWith("$")) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }

      if (TENANT_MODELS.has(canonicalModel(property))) {
        let facade = modelFacades.get(property);
        if (!facade) {
          facade = tenantModel(property);
          modelFacades.set(property, facade);
        }
        return facade;
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as PrismaClient;
}

export const db = dbProxy();

export type TenantDb = typeof db;
