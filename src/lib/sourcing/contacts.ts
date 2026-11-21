/**
 * Deterministic extraction of public business contacts from a fetched public
 * page. Nothing is inferred: an address or phone is recorded only if visible.
 * The caller must already have applied robots.txt, SSRF and size checks.
 */
export type PublicContacts = {
  emails: string[];
  phones: string[];
  contactLinks: string[];
  sourceUrl: string;
  retrievedAt: Date;
};

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function isUsefulEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".svg")) return false;
  if (lower.includes("example.com") || lower.includes("sentry.") || lower.includes("wixpress.")) return false;
  return true;
}

export function extractPublicContacts(text: string, pageUrl: string, links: string[] = []): PublicContacts {
  const emails = [...new Set((text.match(EMAIL) ?? []).map((value) => value.toLowerCase()).filter(isUsefulEmail))].slice(0, 8);
  const phones = [...new Set((text.match(PHONE) ?? []).map((value) => value.replace(/\s+/g, " ").trim()))]
    .filter((value) => value.replace(/\D/g, "").length >= 8)
    .slice(0, 8);
  const contactLinks = [...new Set(
    links.filter((link) => /contact|about|enquir|sales|rfq/i.test(link)).map((link) => {
      try {
        return new URL(link, pageUrl).toString();
      } catch {
        return "";
      }
    }).filter(Boolean),
  )].slice(0, 5);
  return { emails, phones, contactLinks, sourceUrl: pageUrl, retrievedAt: new Date() };
}
