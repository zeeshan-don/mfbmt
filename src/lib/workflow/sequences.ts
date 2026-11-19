import { db } from "../db";
import { requireTenantId } from "../tenant";

/**
 * Gap-free document numbering under concurrency, per organization.
 *
 * `COUNT(*) + 1` produced duplicate references when two requests arrived
 * together. A single locked counter row cannot. The counter is keyed by
 * (organizationId, scope), so two companies can both issue ENQ-2026-0001.
 */
export async function nextNumber(prefix: string, pad = 4): Promise<string> {
  const organizationId = await requireTenantId();
  const year = new Date().getFullYear();
  const scope = `${prefix}-${year}`;
  const value = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "NumberSequence" ("organizationId", "scope", "value")
      VALUES (${organizationId}, ${scope}, 1)
      ON CONFLICT ("organizationId", "scope")
      DO UPDATE SET "value" = "NumberSequence"."value" + 1
    `;
    const rows = await tx.$queryRaw<Array<{ value: number }>>`
      SELECT "value" FROM "NumberSequence"
       WHERE "organizationId" = ${organizationId} AND "scope" = ${scope}
    `;
    return Number(rows[0]?.value ?? 1);
  });
  return `${prefix}-${year}-${String(value).padStart(pad, "0")}`;
}

export async function nextEnquiryRef(): Promise<string> {
  return nextNumber("ENQ");
}

export async function nextQuoteNumber(prefix = "QT"): Promise<string> {
  return nextNumber(prefix);
}
