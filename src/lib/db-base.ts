import "./load-env";
import { PrismaClient } from "@prisma/client";

/**
 * Unscoped Prisma client.
 *
 * Use this only where the tenant is not yet known or where a system operation
 * legitimately spans tenants: sign-in/session lookup, webhook routing by
 * provider phone-number id, OAuth state resolution, the worker claiming a job,
 * and provisioning scripts. Tenant-facing code must use `db` from ./db so the
 * organization filter is applied automatically.
 */
const globalForPrisma = globalThis as unknown as { prismaRaw?: PrismaClient };

export const rawDb =
  globalForPrisma.prismaRaw ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaRaw = rawDb;
