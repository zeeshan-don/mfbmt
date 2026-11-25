import { expandAbbreviations, sizeToMm } from "../catalog/normalize";

export type QueryInput = {
  description: string;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
  brand?: string | null;
  category?: string | null;
  location?: string | null;
};

/**
 * Product-family synonyms. They make a search specific enough to reach real
 * suppliers without dropping the size, material, grade, schedule, pressure
 * class or standard the customer actually requested.
 */
const FAMILY_SYNONYMS: Array<{ match: RegExp; terms: string[] }> = [
  { match: /\belbows?\b/i, terms: ["elbow", "long radius elbow", "butt weld elbow"] },
  { match: /\btees?\b/i, terms: ["tee", "equal tee", "butt weld tee"] },
  { match: /\breducers?\b/i, terms: ["reducer", "concentric reducer"] },
  { match: /\bcouplings?\b/i, terms: ["coupling", "socket weld coupling"] },
  { match: /\bflanges?\b/i, terms: ["flange", "weld neck flange", "raised face flange"] },
  { match: /\bvalves?\b/i, terms: ["valve", "industrial valve"] },
  { match: /\bpipes?\b/i, terms: ["pipe", "seamless pipe"] },
  { match: /\bgaskets?\b/i, terms: ["gasket", "spiral wound gasket"] },
  { match: /\bbolts?\b/i, terms: ["bolt", "hex bolt"] },
  { match: /\bnuts?\b/i, terms: ["nut", "hex nut"] },
  { match: /\bwashers?\b/i, terms: ["washer", "flat washer"] },
  { match: /\bbearings?\b/i, terms: ["bearing", "industrial bearing"] },
  { match: /\bseals?\b/i, terms: ["mechanical seal", "seal kit"] },
  { match: /\bpumps?\b/i, terms: ["pump", "industrial pump"] },
  { match: /\bchemicals?\b/i, terms: ["chemical", "industrial chemical"] },
  { match: /\bcaustic\b/i, terms: ["caustic soda"] },
];

function dedupeWords(value: string): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of value.replace(/\s+/g, " ").trim().split(" ")) {
    const key = word.toLowerCase();
    if (!word) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.join(" ");
}

function specWords(item: QueryInput): string {
  return [
    item.size,
    item.material,
    item.grade,
    item.schedule,
    item.pressureRating,
    item.standard,
    item.brand,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ");
}

function synonymQuery(item: QueryInput): string | null {
  const text = `${item.description} ${item.category ?? ""}`;
  const family = FAMILY_SYNONYMS.find((entry) => entry.match.test(text));
  if (!family) return null;
  return dedupeWords([family.terms[0], specWords(item)].join(" "));
}

/**
 * Builds focused search phrases from the required specification. Synonyms are
 * added, but no required attribute is ever dropped from the stored requirement
 * — the match engine re-checks every candidate against the original spec.
 */
export function buildSearchQueries(item: QueryInput, limit = 4): string[] {
  const core = dedupeWords(`${item.description} ${specWords(item)}`);
  const queries: string[] = [core];

  const expanded = expandAbbreviations(core);
  if (expanded !== core) queries.push(dedupeWords(expanded));

  const focused = synonymQuery(item);
  if (focused) queries.push(focused);

  // A unit conversion gives suppliers that list either inch or metric sizes a
  // chance to match, while the deterministic matcher still compares the value.
  const mm = sizeToMm(item.size ?? null);
  if (mm != null && item.size) {
    const converted = dedupeWords(core.replace(item.size, `${mm}mm`));
    if (converted !== core) queries.push(converted);
  }

  // Critical technical detail stays in every focused variant.
  if (item.standard && !core.toUpperCase().includes(item.standard.toUpperCase())) {
    queries.push(dedupeWords(`${core} ${item.standard}`));
  }

  const location = (item.location ?? "").trim();
  queries.push(dedupeWords(`${core} supplier${location ? ` ${location}` : ""}`));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const cleaned = query.replace(/\s+/g, " ").trim();
    const key = cleaned.toLowerCase();
    if (cleaned.length <= 2 || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique.slice(0, Math.max(1, limit));
}
