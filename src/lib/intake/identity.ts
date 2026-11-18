import { db } from "../db";
import { PRIVATE_CATEGORIES } from "../constants";

/**
 * Contact identity normalization.
 *
 * WhatsApp sends a bare international number ("971501234567"); email senders
 * arrive as `"Name" <addr@example.com>`. Matching an exclusion list against the
 * raw provider string is how personal messages previously slipped through, so
 * every comparison happens on these canonical forms only.
 */

const DEFAULT_COUNTRY_CODE = "971"; // UAE

/** Canonical E.164 phone ("+971501234567"), or "" when there are no digits. */
export function canonicalPhone(raw: string | null | undefined, defaultCountry = DEFAULT_COUNTRY_CODE): string {
  if (!raw) return "";
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(defaultCountry)) return `+${digits}`;

  // Local UAE format: 0501234567 / 501234567
  if (digits.startsWith("0") && digits.length >= 9 && digits.length <= 11) {
    return `+${defaultCountry}${digits.slice(1)}`;
  }
  if (digits.length === 9 && digits.startsWith("5")) return `+${defaultCountry}${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

/** Extracts and validates the address part of a header like `Name <a@b.com>`. */
export function parseEmailAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = raw.match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/);
  const candidate = (angle?.[1] ?? bare?.[0] ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

/** Display name from an email From header, if one is present. */
export function parseEmailDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>/);
  const name = match?.[1]?.trim();
  return name ? name.slice(0, 120) : null;
}

export type Identifiers = {
  phone: string;
  email: string;
  /** Every canonical value an exclusion row may have been stored under. */
  candidates: string[];
};

export function identify(input: { channel: string; from: string; fromName?: string | null }): Identifiers {
  const isEmail = input.channel === "EMAIL" || input.from.includes("@");
  const phone = isEmail ? "" : canonicalPhone(input.from);
  const email = isEmail ? parseEmailAddress(input.from) : "";
  const candidates = [phone, email].filter(Boolean);
  return { phone, email, candidates };
}

export type ExclusionMatch = {
  id: string;
  identifier: string;
  category: string;
  label: string | null;
} | null;

/**
 * Looks up the exclusion list using canonical identifiers. Legacy rows that were
 * saved in a looser format still match through the canonical form of their
 * stored value, so an existing exclusion cannot silently stop working.
 */
export async function findExclusion(candidates: string[]): Promise<ExclusionMatch> {
  const clean = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
  if (clean.length === 0) return null;

  const direct = await db.excludedContact.findFirst({ where: { identifier: { in: clean } } });
  if (direct) return direct;

  const all = await db.excludedContact.findMany({
    select: { id: true, identifier: true, category: true, label: true },
  });
  const keys = new Set(
    clean.map((value) => (value.includes("@") ? value.toLowerCase() : canonicalPhone(value) || value)),
  );
  for (const row of all) {
    const rowKey = row.identifier.includes("@")
      ? row.identifier.trim().toLowerCase()
      : canonicalPhone(row.identifier) || row.identifier.trim();
    if (keys.has(rowKey)) return row;
  }
  return null;
}

export function isPrivateCategory(category: string | null | undefined): boolean {
  return Boolean(category && (PRIVATE_CATEGORIES as readonly string[]).includes(category));
}

/** True when the sender has no established business relationship yet. */
export async function isUnknownSender(input: {
  phone: string;
  email: string;
  contactKind?: string | null;
}): Promise<boolean> {
  if (input.contactKind && input.contactKind !== "UNKNOWN") return false;
  const priorEnquiry = await db.enquiry.findFirst({
    where: {
      OR: [
        ...(input.phone ? [{ customerPhone: input.phone }] : []),
        ...(input.email ? [{ customerEmail: input.email }] : []),
      ],
    },
    select: { id: true },
  });
  return !priorEnquiry;
}
