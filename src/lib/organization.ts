import { db } from "./db";
import { requireTenantId } from "./tenant";

/**
 * The organization for the current request.
 *
 * Organization is the tenant registry itself, so the Prisma guard does not
 * scope it automatically. Always load it through this helper (or by the
 * authenticated user's organizationId); never use `findFirst()`, which can
 * return another company now that more than one tenant exists.
 */
export async function getCurrentOrganization() {
  const organizationId = await requireTenantId();
  return db.organization.findUnique({ where: { id: organizationId } });
}
