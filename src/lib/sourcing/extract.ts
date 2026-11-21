import { SupplierEvidenceSchema, type SupplierEvidence } from "../validation/extraction";

const CURRENCY_SYMBOLS: Record<string, string> = {
  "د.إ": "AED", "AED": "AED", "$": "USD", "US$": "USD", "USD": "USD", "€": "EUR", "EUR": "EUR",
  "£": "GBP", "GBP": "GBP", "₹": "INR", "INR": "INR", "SAR": "SAR", "SR": "SAR",
  "CNY": "CNY", "RMB": "CNY", "¥": "CNY", "KRW": "KRW", "₩": "KRW",
};

const PRICE_PATTERNS = [
  /(?:AED|USD|EUR|GBP|INR|SAR|CNY|RMB|KRW|US\$)\s*([0-9][0-9.,]*)/i,
  /([0-9][0-9.,]*)\s*(?:AED|USD|EUR|GBP|INR|SAR|CNY|KRW)\b/i,
  /(?:price|rate|unit price)\s*(?:of|:)?\s*(?:AED|USD|EUR|GBP|INR|SAR|CNY|KRW)?\s*([0-9][0-9.,]*)/i,
  /([0-9][0-9.,]*)\s*(?:\/|per)\s*(?:pc|pcs|piece|unit|nos?)/i,
];

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function detectCurrency(text: string): string | null {
  const upper = text.toUpperCase();
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (upper.includes(symbol.toUpperCase())) return code;
  }
  return null;
}

/**
 * Reads only what the page visibly states. Missing prices stay missing: the
 * system never guesses a cost from a snippet or from model knowledge.
 */
export function extractPriceFromText(text: string): {
  unitPrice: number | null;
  currency: string | null;
  priceText: string | null;
} {
  for (const pattern of PRICE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const currency = detectCurrency(match[0]) ?? detectCurrency(text);
    const value = parseNumber(match[1]);
    if (value != null) {
      return { unitPrice: value, currency, priceText: match[0].trim().slice(0, 80) };
    }
  }
  return { unitPrice: null, currency: null, priceText: null };
}

export function extractMoq(text: string): number | null {
  const match =
    text.match(/(?:moq|minimum(?:\s*order)?(?:\s*quantity)?)\s*(?:of|:)?\s*([0-9][0-9,]*)/i) ??
    text.match(/([0-9][0-9,]*)\s*(?:pcs|pieces|units)\s*(?:minimum|min\b)/i);
  if (!match) return null;
  const value = parseNumber(match[1]);
  return value;
}

export function extractLeadTimeDays(text: string): number | null {
  const days = text.match(/(?:lead\s*time|delivery|dispatch)[^.\n]{0,40}?(\d{1,3})\s*(?:-|to)?\s*(\d{1,3})?\s*(?:working\s*)?days?/i);
  if (days) return Number(days[2] ?? days[1]);
  if (/\bin\s*stock\b|\bready\s*stock\b/i.test(text)) return 0;
  if (/\b(\d{1,2})\s*weeks?\b/i.test(text)) {
    const weeks = text.match(/\b(\d{1,2})\s*weeks?\b/i);
    return weeks ? Number(weeks[1]) * 7 : null;
  }
  return null;
}

export function extractAvailability(text: string): string | null {
  if (/\bin\s*stock\b/i.test(text)) return "In stock (as stated on page)";
  if (/\bout\s*of\s*stock\b/i.test(text)) return "Out of stock (as stated on page)";
  if (/on\s*request|to\s*order/i.test(text)) return "Available on request";
  return null;
}

/** Deterministic specification scraping from a listing title/snippet. */
export function extractSpecsFromText(text: string): SupplierEvidence {
  const candidate = {
    productTitle: text.slice(0, 240),
    material: text.match(/\b(?:ss\s*-?\s*(?:316l?|304l?)|stainless\s*steel\s*(?:316l?|304l?)|mild\s*steel|carbon\s*steel|pvc|upvc|ppr|hdpe|brass|cast\s*iron|ductile\s*iron)\b/i)?.[0] ?? null,
    grade: text.match(/\b(?:gr\.?\s*[0-9.]+|8\.8|10\.9|a2-70|a4-70)\b/i)?.[0] ?? null,
    size: text.match(/\b(?:dn\s*\d+|\d+(?:\.\d+)?\s*(?:inch|in|mm|")|\d+\/\d+\s*(?:inch|in|")?)\b/i)?.[0] ?? null,
    pressureRating: text.match(/\b(?:class\s*\d+|pn\s*\d+|\d+\s*(?:bar|psi))\b/i)?.[0] ?? null,
    standard: text.match(/\b(?:asme\s*b16\.\d+|ansi\s*b16\.\d+|astm\s*a\d+|din\s*\d+|bs\s*\d+)\b/i)?.[0] ?? null,
    availability: extractAvailability(text),
  };
  const parsed = SupplierEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}
