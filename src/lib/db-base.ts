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
    // Commercial lifecycle writes (receipt, dispatch, invoice, payment, closure)
    // recompute order status inside one interactive transaction. Over a pooled
    // remote database that reads/writes can exceed Prisma's 5s default, which
    // surfaced as P2028 and a 500 on goods receipt.
    transactionOptions: { maxWait: 10_000, timeout: 20_000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaRaw = rawDb;
