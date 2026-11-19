import { db } from "./db";
import { parseJson, stringifyJson } from "./json";
import { requireTenantId } from "./tenant";

export async function setSettingJson(key: string, value: unknown): Promise<void> {
  const organizationId = await requireTenantId();
  await db.appSetting.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { value: stringifyJson(value) },
    create: { key, value: stringifyJson(value) },
  });
}

export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const setting = await db.appSetting.findFirst({ where: { key } });
  return parseJson<T>(setting?.value ?? null, fallback);
}

export async function deleteSetting(key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key } });
}
