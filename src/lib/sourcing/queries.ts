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
};

/**
 * Builds search phrases from the required specification. Synonyms are added,
 * but no required attribute is ever dropped from the stored requirement — the
 * match engine re-checks every candidate against the original specification.
 */
export function buildSearchQueries(item: QueryInput, limit = 4): string[] {
  const core = [item.description, item.size, item.material, item.grade, item.schedule, item.pressureRating, item.brand]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const queries: string[] = [core];

  const expanded = expandAbbreviations(core);
  if (expanded !== core) queries.push(expanded);

  const mm = sizeToMm(item.size ?? null);
  if (mm != null && item.size) {
    const inchReplaced = core.replace(item.size, `${mm}mm`);
    if (inchReplaced !== core) queries.push(inchReplaced);
  }

  if (item.standard) queries.push(`${core} ${item.standard}`);
  queries.push(`${core} supplier UAE`);

  return [...new Set(queries.filter((q) => q.trim().length > 2))].slice(0, limit);
}
