import { db } from "../db";
import { env } from "../env";

export type SupplierSendGuard = {
  ok: boolean;
  error: string | null;
  sentToday: number;
  dailyLimit: number;
  supplier: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    status: string;
    doNotContact: boolean;
  } | null;
};

function dayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function identifiers(supplier: {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  contacts?: Array<{ email: string | null; phone: string | null; whatsapp: string | null }>;
}): string[] {
  const values = [
    supplier.email,
    supplier.phone,
    supplier.whatsapp,
    ...(supplier.contacts ?? []).flatMap((contact) => [contact.email, contact.phone, contact.whatsapp]),
  ];
  return [...new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
}

/**
 * Hard commercial guard for every supplier message. It runs server-side even
 * when an approval exists, so a stale approval cannot bypass a later bounce,
 * do-not-contact instruction or the organization's daily cap.
 */
export async function supplierSendGuard(supplierId: string): Promise<SupplierSendGuard> {
  const supplier = await db.supplier.findUnique({
    where: { id: supplierId },
    include: { contacts: { select: { email: true, phone: true, whatsapp: true } } },
  });
  if (!supplier) {
    return { ok: false, error: "Supplier not found.", sentToday: 0, dailyLimit: env.SUPPLIER_DAILY_SEND_LIMIT, supplier: null };
  }

  const sentToday = await db.supplierQuote.count({
    where: { sentAt: { gte: dayStart() }, status: { in: ["SENT", "RESPONDED"] } },
  });
  const base = {
    sentToday,
    dailyLimit: env.SUPPLIER_DAILY_SEND_LIMIT,
    supplier: {
      id: supplier.id,
      name: supplier.name,
      email: supplier.email,
      phone: supplier.phone,
      whatsapp: supplier.whatsapp,
      status: supplier.status,
      doNotContact: supplier.doNotContact,
    },
  };

  if (supplier.doNotContact || supplier.status === "BLOCKED" || supplier.bouncedAt) {
    return { ...base, ok: false, error: `${supplier.name} is marked do not contact.` };
  }

  const excluded = await db.excludedContact.findFirst({
    where: { identifier: { in: identifiers(supplier) } },
    select: { label: true, category: true },
  });
  if (excluded) {
    return {
      ...base,
      ok: false,
      error: `${supplier.name} matches a contact exclusion${excluded.label ? ` (${excluded.label})` : ""}. Remove it in Settings only if you intend to contact them.`,
    };
  }

  if (sentToday >= env.SUPPLIER_DAILY_SEND_LIMIT) {
    return {
      ...base,
      ok: false,
      error: `The daily supplier send limit (${env.SUPPLIER_DAILY_SEND_LIMIT}) has been reached. Nothing was sent.`,
    };
  }

  return { ...base, ok: true, error: null };
}

export async function supplierDailyUsage(): Promise<{ sentToday: number; dailyLimit: number }> {
  const sentToday = await db.supplierQuote.count({
    where: { sentAt: { gte: dayStart() }, status: { in: ["SENT", "RESPONDED"] } },
  });
  return { sentToday, dailyLimit: env.SUPPLIER_DAILY_SEND_LIMIT };
}
