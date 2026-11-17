import { db } from "./db";
import { parseJson, stringifyJson } from "./json";

export async function setSettingJson(key: string, value: unknown): Promise<void> {
  await db.appSetting.upsert({
    where: { key },
    update: { value: stringifyJson(value) },
    create: { key, value: stringifyJson(value) },
  });
}

export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const setting = await db.appSetting.findUnique({ where: { key } });
  return parseJson<T>(setting?.value ?? null, fallback);
}

export async function deleteSetting(key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key } });
}
