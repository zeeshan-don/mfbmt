/**
 * Deterministic normalization. Search and comparison may be fuzzy, but the
 * stored specification keeps both the original wording and the canonical form.
 */

const UNIT_MAP: Record<string, string> = {
  pcs: "pcs", pc: "pcs", piece: "pcs", pieces: "pcs", nos: "pcs", no: "pcs", ea: "pcs",
  each: "pcs", unit: "pcs", units: "pcs", qty: "pcs",
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg",
  m: "m", mtr: "m", mtrs: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  box: "box", boxes: "box", set: "set", sets: "set", pair: "pair", pairs: "pair",
  roll: "roll", rolls: "roll", coil: "coil", ltr: "l", l: "l", litre: "l", liter: "l",
  bundle: "bundle", carton: "carton", drum: "drum", bag: "bag", bags: "bag",
  m2: "m2", sqm: "m2", ft: "ft", feet: "ft", inch: "in", in: "in",
};

export function normalizeUnit(raw: string | null | undefined): string {
  if (!raw) return "pcs";
  const key = raw.trim().toLowerCase().replace(/[.\s]+$/g, "");
  return UNIT_MAP[key] ?? (key.replace(/[^a-z0-9/]/g, "").slice(0, 12) || "pcs");
}

const NUMERIC = /(\d+(?:[.,]\d+)?)/;

/** Parses "20 pcs", "10", "5 nos" and returns a positive quantity when explicit. */
export function parseQuantity(raw: string | null | undefined): { quantity: number | null; unit: string | null } {
  if (!raw) return { quantity: null, unit: null };
  const text = raw.toLowerCase();
  const match = text.match(NUMERIC);
  const quantity = match ? Number(match[1].replace(",", "")) : null;
  const unitMatch = text.match(
    /\b(pcs|pc|pieces?|nos?|ea|each|units?|kgs?|mtrs?|met(?:er|re)s?|box(?:es)?|sets?|rolls?|litres?|liters?|bundles?|cartons?)\b/,
  );
  return {
    quantity: quantity != null && Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    unit: unitMatch ? normalizeUnit(unitMatch[1]) : null,
  };
}

const FRACTIONS: Record<string, number> = {
  "1/2": 0.5, "1/4": 0.25, "3/4": 0.75, "3/8": 0.375, "5/8": 0.625, "7/8": 0.875,
  "1/8": 0.125, "3/16": 0.1875, "5/16": 0.3125, "7/16": 0.4375, "9/16": 0.5625,
  "11/16": 0.6875, "13/16": 0.8125, "15/16": 0.9375, "1/3": 0.3333, "2/3": 0.6667,
};

/**
 * Converts a size string into millimetres for comparison only.
 * Returns null when the size is not a recognizable length.
 */
export function sizeToMm(size: string | null | undefined): number | null {
  if (!size) return null;
  const text = size.toLowerCase().replace(/["”]/g, " in ").replace(/['’]/g, " ft ").trim();
  const mmMatch = text.match(/(\d+(?:[.,]\d+)?)\s*mm\b/);
  if (mmMatch) return Number(mmMatch[1].replace(",", ""));
  const dnMatch = text.match(/\bdn\s*(\d+(?:\.\d+)?)/);
  if (dnMatch) return Number(dnMatch[1]);
  const inchMatch = text.match(/(\d+)?\s*(\d\/\d+)?\s*(?:in\b|inch(?:es)?\b|")/);
  if (inchMatch) {
    const whole = inchMatch[1] ? Number(inchMatch[1]) : 0;
    const frac = inchMatch[2] ? FRACTIONS[inchMatch[2]] ?? null : 0;
    if (frac === null) return null;
    const inches = whole + frac;
    if (inches > 0) return Math.round(inches * 25.4 * 100) / 100;
  }
  const bareFraction = text.match(/^\s*(\d\/\d+)\s*$/);
  if (bareFraction && FRACTIONS[bareFraction[1]] != null) {
    return Math.round(FRACTIONS[bareFraction[1]] * 25.4 * 100) / 100;
  }
  return null;
}

export function normalizeSize(size: string | null | undefined): string | null {
  if (!size) return null;
  const trimmed = size.trim().replace(/\s+/g, " ");
  const mm = sizeToMm(trimmed);
  if (mm == null) return trimmed;
  const inches = Math.round((mm / 25.4) * 1000) / 1000;
  return `${inches}in`;
}

export function normalizeMaterial(material: string | null | undefined): string | null {
  if (!material) return null;
  const text = material.toLowerCase().replace(/[\s_-]+/g, "");
  if (/(ss|stainless)(316l?|a4)/.test(text) || /316/.test(text)) {
    return /316l/.test(text) ? "SS316L" : "SS316";
  }
  if (/(ss|stainless)(304l?|a2)/.test(text) || /304/.test(text)) {
    return /304l/.test(text) ? "SS304L" : "SS304";
  }
  if (/(ms|mildsteel|carbonsteel|cs)\b/.test(text) || /carbon/.test(text)) return "MS";
  if (/gi|galvan/.test(text)) return "GI";
  if (/pvc|upvc/.test(text)) return "PVC";
  if (/ppr/.test(text)) return "PPR";
  if (/hdpe/.test(text)) return "HDPE";
  if (/brass/.test(text)) return "Brass";
  if (/castiron|ci\b/.test(text)) return "CI";
  if (/ductile/.test(text)) return "Ductile Iron";
  if (/copper/.test(text)) return "Copper";
  if (/alloy/.test(text)) return "Alloy Steel";
  return material.trim().toUpperCase();
}

export function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  return grade.trim().toUpperCase().replace(/\s+/g, "");
}

export function normalizePressure(pressure: string | null | undefined): string | null {
  if (!pressure) return null;
  const text = pressure.toUpperCase().replace(/\s+/g, "");
  const classMatch = text.match(/(150|300|400|600|900|1500|2500)#?/);
  if (classMatch) return `CLASS${classMatch[1]}`;
  const pnMatch = text.match(/PN\s?(\d+)/);
  if (pnMatch) return `PN${pnMatch[1]}`;
  const barMatch = text.match(/(\d+(?:\.\d+)?)\s?BAR/);
  if (barMatch) return `PN${Math.round(Number(barMatch[1]) * 10)}`;
  return pressure.trim().toUpperCase();
}

export function normalizeSchedule(schedule: string | null | undefined): string | null {
  if (!schedule) return null;
  const text = schedule.toUpperCase().replace(/\s+/g, "");
  const sch = text.match(/SCH(?:EDULE)?-?(\d{1,3}|[X]{1,2}S)/);
  return sch ? `SCH${sch[1]}` : schedule.trim().toUpperCase();
}

const ABBREVIATIONS: Record<string, string> = {
  ss: "stainless steel",
  ms: "mild steel",
  cs: "carbon steel",
  gi: "galvanized iron",
  bw: "butt weld",
  sw: "socket weld",
  thd: "threaded",
  npt: "NPT threaded",
  wn: "weld neck",
  so: "slip on",
  rf: "raised face",
  ff: "flat face",
  moq: "minimum order quantity",
  pn: "pressure nominal",
};

export function expandAbbreviations(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => {
      const key = word.toLowerCase().replace(/[^a-z]/g, "");
      const replacement = ABBREVIATIONS[key];
      return replacement && word.length <= 4 ? replacement : word;
    })
    .join(" ");
}

/** Human readable specification line used across the UI and outbound documents. */
export function buildSpecSummary(item: {
  description: string;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
  brand?: string | null;
}): string {
  const parts = [item.description.trim()];
  if (item.size) parts.push(item.size);
  if (item.material) parts.push(item.material);
  if (item.grade) parts.push(`Gr ${item.grade}`);
  if (item.schedule) parts.push(item.schedule);
  if (item.pressureRating) parts.push(item.pressureRating);
  if (item.standard) parts.push(item.standard);
  if (item.brand) parts.push(item.brand);
  return parts.filter(Boolean).join(" · ");
}

export function formatQuantity(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, "");
  return `${rounded} ${unit}`;
}
