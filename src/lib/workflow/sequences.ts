import { db } from "../db";

/**
 * Gap-free document numbering under concurrency.
 *
 * `COUNT(*) + 1` produced duplicate references when two requests arrived
 * together. A single locked counter row cannot.
 */
export async function nextNumber(prefix: string, pad = 4): Promise<string> {
  const year = new Date().getFullYear();
  const scope = `${prefix}-${year}`;
  const value = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "NumberSequence" ("scope", "value") VALUES (${scope}, 1)
      ON CONFLICT ("scope") DO UPDATE SET "value" = "NumberSequence"."value" + 1
    `;
    const rows = await tx.$queryRaw<Array<{ value: number }>>`
      SELECT "value" FROM "NumberSequence" WHERE "scope" = ${scope}
    `;
    return Number(rows[0]?.value ?? 1);
  });
  return `${prefix}-${year}-${String(value).padStart(pad, "0")}`;
}

export async function nextEnquiryRef(): Promise<string> {
  return nextNumber("ENQ");
}

export async function nextQuoteNumber(): Promise<string> {
  return nextNumber("QT");
}
