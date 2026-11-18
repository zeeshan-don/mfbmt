import { z } from "zod";
import { normalizeGrade, normalizeMaterial } from "../catalog/normalize";

/**
 * Structured fastener specification.
 *
 * Fasteners are safety-relevant: a different diameter, pitch, length, property
 * class, material, finish or standard is a different part. This module keeps a
 * validated, versioned shape and a deterministic comparison. Missing data is
 * never replaced by a default; similarity never overrides a hard mismatch.
 *
 * Version 1 — stored in `EnquiryItem.fastenerSpecJson`, `Product.fastenerSpecJson`
 * and `SupplierOffer.offeredSpecJson`.
 */
export const FASTENER_SPEC_VERSION = 1;

export const FASTENER_TYPES = [
  "HEX_BOLT",
  "SOCKET_HEAD_CAP_SCREW",
  "MACHINE_SCREW",
  "STUD",
  "THREADED_ROD",
  "HEX_NUT",
  "LOCK_NUT",
  "FLAT_WASHER",
  "SPRING_WASHER",
  "ANCHOR",
  "OTHER",
] as const;
export type FastenerType = (typeof FASTENER_TYPES)[number];

export const THREAD_SERIES = ["METRIC_COARSE", "METRIC_FINE", "UNC", "UNF", "BSP", "NPT", "UNKNOWN"] as const;
export type ThreadSeries = (typeof THREAD_SERIES)[number];

export const FINISHES = [
  "ZINC_PLATED",
  "HOT_DIP_GALVANIZED",
  "BLACK_OXIDE",
  "PLAIN",
  "PASSIVATED",
  "DACROMET",
  "OTHER",
] as const;
export type FastenerFinish = (typeof FINISHES)[number];

export const FASTENER_TYPE_LABELS: Record<FastenerType, string> = {
  HEX_BOLT: "Hex bolt",
  SOCKET_HEAD_CAP_SCREW: "Socket head cap screw",
  MACHINE_SCREW: "Machine screw",
  STUD: "Stud",
  THREADED_ROD: "Threaded rod",
  HEX_NUT: "Hex nut",
  LOCK_NUT: "Lock nut",
  FLAT_WASHER: "Flat washer",
  SPRING_WASHER: "Spring washer",
  ANCHOR: "Anchor",
  OTHER: "Other fastener",
};

export const THREAD_LABELS: Record<ThreadSeries, string> = {
  METRIC_COARSE: "Metric coarse",
  METRIC_FINE: "Metric fine",
  UNC: "UNC (inch coarse)",
  UNF: "UNF (inch fine)",
  BSP: "BSP",
  NPT: "NPT",
  UNKNOWN: "Unknown",
};

export const FINISH_LABELS: Record<FastenerFinish, string> = {
  ZINC_PLATED: "Zinc plated",
  HOT_DIP_GALVANIZED: "Hot-dip galvanized",
  BLACK_OXIDE: "Black oxide",
  PLAIN: "Plain",
  PASSIVATED: "Passivated",
  DACROMET: "Dacromet",
  OTHER: "Other",
};

export type FastenerSpec = {
  version: number;
  type: FastenerType | null;
  diameter: string | null;
  diameterSystem: "METRIC" | "IMPERIAL" | null;
  threadSeries: ThreadSeries | null;
  pitchMm: number | null;
  lengthMm: number | null;
  headType: string | null;
  driveType: string | null;
  material: string | null;
  propertyClass: string | null;
  finish: FastenerFinish | null;
  standard: string | null;
  certification: string | null;
  packMultiple: number | null;
  packagingUnit: string | null;
  rawText: string | null;
};

const numberOrNull = z.number().finite().positive().nullable();

export const FastenerSpecSchema = z.object({
  version: z.number().int().default(FASTENER_SPEC_VERSION),
  type: z.enum(FASTENER_TYPES).nullable().default(null),
  diameter: z.string().max(40).nullable().default(null),
  diameterSystem: z.enum(["METRIC", "IMPERIAL"]).nullable().default(null),
  threadSeries: z.enum(THREAD_SERIES).nullable().default(null),
  pitchMm: numberOrNull.default(null),
  lengthMm: numberOrNull.default(null),
  headType: z.string().max(40).nullable().default(null),
  driveType: z.string().max(40).nullable().default(null),
  material: z.string().max(80).nullable().default(null),
  propertyClass: z.string().max(40).nullable().default(null),
  finish: z.enum(FINISHES).nullable().default(null),
  standard: z.string().max(80).nullable().default(null),
  certification: z.string().max(160).nullable().default(null),
  packMultiple: numberOrNull.default(null),
  packagingUnit: z.string().max(40).nullable().default(null),
  rawText: z.string().max(1000).nullable().default(null),
});

export const FastenerSpecEnvelopeSchema = z.object({
  version: z.number().int().default(FASTENER_SPEC_VERSION),
  spec: FastenerSpecSchema,
});

export const EMPTY_FASTENER_SPEC: FastenerSpec = {
  version: FASTENER_SPEC_VERSION,
  type: null,
  diameter: null,
  diameterSystem: null,
  threadSeries: null,
  pitchMm: null,
  lengthMm: null,
  headType: null,
  driveType: null,
  material: null,
  propertyClass: null,
  finish: null,
  standard: null,
  certification: null,
  packMultiple: null,
  packagingUnit: null,
  rawText: null,
};

/** Coarse metric pitch table (ISO 261). Used only to label an explicitly stated pitch. */
const COARSE_PITCH: Record<number, number> = {
  3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3,
  27: 3, 30: 3.5, 33: 3.5, 36: 4, 42: 4.5, 48: 5,
};

export function parseMetricDiameter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.match(/\bM\s*(\d+(?:\.\d+)?)\b/i);
  return match ? Number(match[1]) : null;
}

/** Canonical diameter token: M10 stays M10, 3/8" becomes 3/8. */
export function normalizeDiameter(raw: string | null | undefined): { diameter: string | null; system: "METRIC" | "IMPERIAL" | null } {
  if (!raw) return { diameter: null, system: null };
  const text = raw.trim().replace(/[“”"]/g, '"');
  const metric = text.match(/\bM\s*(\d+(?:\.\d+)?)\b/i);
  if (metric) return { diameter: `M${Number(metric[1])}`, system: "METRIC" };
  const imperial = text.match(/\b(\d+\s+\d+\/\d+|\d+\/\d+|\d+\.\d+|\d+)\s*(?:in\b|inch(?:es)?\b|")/i);
  if (imperial) return { diameter: imperial[1].replace(/\s+/g, " "), system: "IMPERIAL" };
  const bareFraction = text.match(/^\s*(\d+\/\d+)\s*$/);
  if (bareFraction) return { diameter: bareFraction[1], system: "IMPERIAL" };
  return { diameter: text.toUpperCase(), system: null };
}

export function normalizeFinishValue(value: string | null | undefined): FastenerFinish | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((FINISHES as readonly string[]).includes(upper)) return upper as FastenerFinish;
  return parseFinish(value);
}

export function normalizeThreadSeriesValue(value: string | null | undefined): ThreadSeries | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((THREAD_SERIES as readonly string[]).includes(upper)) return upper as ThreadSeries;
  if (/UNC/.test(upper)) return "UNC";
  if (/UNF/.test(upper)) return "UNF";
  if (/NPT/.test(upper)) return "NPT";
  if (/BSP/.test(upper)) return "BSP";
  if (/FINE/.test(upper)) return "METRIC_FINE";
  if (/METRIC|COARSE/.test(upper)) return "METRIC_COARSE";
  return null;
}

function parseFastenerType(text: string): FastenerType | null {
  const t = text.toLowerCase();
  if (/\bsocket\s*(?:head)?\s*cap\s*screw\b|\bsocket\s*head\s*screw\b/.test(t)) return "SOCKET_HEAD_CAP_SCREW";
  if (/\bhex\s*(?:head)?\s*bolt\b|\bhex\s*head\s*screw\b|\bbolt\b/.test(t)) return "HEX_BOLT";
  if (/\bmachine\s*screw\b/.test(t)) return "MACHINE_SCREW";
  if (/\bthreaded\s*rod\b|\bthread\s*rod\b|\ball\s*thread\b/.test(t)) return "THREADED_ROD";
  if (/\bstud\s*bolt\b|\bstud\b/.test(t)) return "STUD";
  if (/\block\s*nut\b|\bnyloc\b|\bnylon\s*insert\s*nut\b/.test(t)) return "LOCK_NUT";
  if (/\bhex\s*nut\b|\bnut\b/.test(t)) return "HEX_NUT";
  if (/\bspring\s*washer\b|\bwave\s*washer\b/.test(t)) return "SPRING_WASHER";
  if (/\bflat\s*washer\b|\bplain\s*washer\b|\bwasher\b/.test(t)) return "FLAT_WASHER";
  if (/\banchor\b/.test(t)) return "ANCHOR";
  if (/\bfastener\b|\bscrew\b/.test(t)) return "OTHER";
  return null;
}

function parseFinish(text: string): FastenerFinish | null {
  const t = text.toLowerCase();
  if (/hot[\s-]*dip\s*galv|\bhdg\b/.test(t)) return "HOT_DIP_GALVANIZED";
  if (/zinc\s*plat|electro[\s-]*zinc|galvani[sz]ed(?!.*hot)|white\s*zinc|\bzn\b/.test(t)) return "ZINC_PLATED";
  if (/black\s*oxide|blackened/.test(t)) return "BLACK_OXIDE";
  if (/dacromet|geomet/.test(t)) return "DACROMET";
  if (/passivat/.test(t)) return "PASSIVATED";
  if (/\bplain\b|\buncoated\b|\bbare\b/.test(t)) return "PLAIN";
  return null;
}

function parsePropertyClass(text: string): string | null {
  const t = text.toUpperCase();
  const stainless = t.match(/\b(A[24])\s*[- ]?\s*(50|70|80)\b/);
  if (stainless) return `${stainless[1]}-${stainless[2]}`;
  const metric = t.match(/\b(4\.[68]|5\.6|5\.8|8\.8|10\.9|12\.9)\b/);
  if (metric) return metric[1];
  const astm = t.match(/\b(ASTM\s*A(?:193|320|325|490)\s*(?:B\d|GR\s*\d+)?)\b/);
  if (astm) return astm[1].replace(/\s+/g, " ");
  const grade = t.match(/\b(?:GR(?:ADE)?\.?|CLASS)\s*(\d+(?:\.\d+)?)\b/);
  if (grade) return grade[1];
  return null;
}

function parseMaterial(text: string): string | null {
  const t = text.toLowerCase();
  if (/\ba4\b|316/.test(t)) return "SS316";
  if (/\ba2\b|304/.test(t)) return "SS304";
  if (/hot[\s-]*dip\s*galv|\bhdg\b|galvani[sz]ed/.test(t)) return "MS";
  if (/alloy\s*steel/.test(t)) return "Alloy Steel";
  if (/carbon\s*steel|mild\s*steel|\bms\b/.test(t)) return "MS";
  if (/brass/.test(t)) return "Brass";
  // Never turn an arbitrary description into a material value.
  return null;
}

function parseStandard(text: string): string | null {
  const match = text.match(/\b(DIN|ISO|ASTM|BS|ANSI|EN)\s*[- ]?([A-Z]?\s?\d+(?:[\w.-]*\d)?)\b/i);
  if (!match) return null;
  return `${match[1].toUpperCase()} ${match[2].replace(/\s+/g, "").toUpperCase()}`;
}

function parseCertification(text: string): string | null {
  const t = text.toLowerCase();
  const en = text.match(/\bEN\s*10204\s*[- ]?\s*(3\.1|3\.2|2\.2)\b/i);
  if (en) return `EN 10204 ${en[1]}`;
  if (/mill\s*cert|material\s*cert/.test(t)) return "Mill certificate";
  if (/test\s*cert|\bMTC\b|\b3\.1\b/.test(t)) return "Test certificate";
  if (/traceab/.test(t)) return "Traceability";
  if (/inspection/.test(t)) return "Inspection certificate";
  return null;
}

/**
 * Deterministic extraction from a description plus optional structured fields.
 * It only records what the text states; nothing is defaulted.
 */
export function parseFastenerSpec(input: {
  description: string;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  standard?: string | null;
  rawText?: string | null;
  packMultiple?: number | null;
  packagingUnit?: string | null;
}): FastenerSpec {
  const description = input.description ?? "";
  const combined = [description, input.size, input.material, input.grade, input.standard]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const text = combined;

  const type = parseFastenerType(text);

  // Diameter: explicit M-size first, then an inch thread callout (3/8-16 UNC),
  // then a general inch size.
  let { diameter, system } = normalizeDiameter(input.size ?? "");
  if (!diameter) {
    const inchThread = text.match(/\b(\d+\/\d+)\s*-\s*\d+\s*(?:UNC|UNF|UN|BSW|BSF)\b/i);
    if (inchThread) {
      diameter = inchThread[1];
      system = "IMPERIAL";
    }
  }
  if (!diameter) ({ diameter, system } = normalizeDiameter(text));

  // Thread series.
  let threadSeries: ThreadSeries | null = null;
  if (/\bUNC\b/i.test(text)) threadSeries = "UNC";
  else if (/\bUNF\b/i.test(text)) threadSeries = "UNF";
  else if (/\bBSP(?:T|P)?\b/i.test(text)) threadSeries = "BSP";
  else if (/\bNPT\b/i.test(text)) threadSeries = "NPT";
  else if (/\bmetric\s*fine\b|\bfine\s*(?:thread|pitch)\b/i.test(text)) threadSeries = "METRIC_FINE";
  else if (system === "METRIC" || /\bmetric\b/i.test(text)) threadSeries = "METRIC_COARSE";

  // Pitch: "M10 x 1.5 x 30", "M10-1.5", "1.5 mm pitch".
  let pitchMm: number | null = null;
  const explicitPitch = text.match(/\bpitch\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*mm?\b/i);
  if (explicitPitch) pitchMm = Number(explicitPitch[1]);
  if (pitchMm == null) {
    const twoNumber = text.match(/\bM\s*\d+(?:\.\d+)?\s*[x×X-]\s*(\d+(?:\.\d+)?)\s*[x×X-]\s*(\d+(?:\.\d+)?)/);
    if (twoNumber) pitchMm = Number(twoNumber[1]);
  }
  if (pitchMm == null) {
    // M12 x 1.75 states a pitch; M10 x 30 states a length. A metric pitch is
    // never above 4 mm in normal fastener sizes, so the value disambiguates.
    const metricX = text.match(/\bM\s*\d+(?:\.\d+)?\s*[x×]\s*(\d+(?:\.\d+)?)\b/);
    if (metricX && Number(metricX[1]) <= 4) pitchMm = Number(metricX[1]);
  }
  if (pitchMm == null) {
    const dashPitch = text.match(/\bM\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\b/);
    // M10-30 is a length shorthand; only treat it as pitch when the value is a plausible pitch.
    if (dashPitch && Number(dashPitch[2]) <= 4) pitchMm = Number(dashPitch[2]);
  }

  // Length: "x 30", "30 mm", "1 1/2 in", "1 m". Never use the diameter or pitch token.
  let lengthMm: number | null = null;
  // An explicit metre length (threaded rod is commonly sold in 1 m lengths).
  // `m(?!m)` avoids matching the "mm" in a millimetre callout.
  const metreLength = text.match(/\b(\d+(?:\.\d+)?)\s*m(?:eter|etre)?s?(?!m)\b/i);
  if (metreLength) lengthMm = Math.round(Number(metreLength[1]) * 1000 * 100) / 100;
  const xLength = text.match(/\bM\s*\d+(?:\.\d+)?(?:\s*[x×X-]\s*\d+(?:\.\d+)?)?\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(mm)?\b/i);
  if (lengthMm == null && xLength) lengthMm = Number(xLength[1]);
  // "M8 x 1.25" states a pitch, not a length. Only treat a single x-value as
  // length when it is not the pitch ("M10 x 30" is a length).
  const hasThirdDimension = /\bM\s*\d+(?:\.\d+)?\s*[x×X-]\s*\d+(?:\.\d+)?\s*[x×X-]\s*\d+(?:\.\d+)?/.test(text);
  if (
    lengthMm != null &&
    pitchMm != null &&
    Math.abs(lengthMm - pitchMm) < 0.001 &&
    !hasThirdDimension
  ) {
    lengthMm = null;
  }
  if (lengthMm == null) {
    const mmLength = text.match(/\b(?:length|len|l)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*mm\b/i);
    if (mmLength) lengthMm = Number(mmLength[1]);
  }
  if (lengthMm == null && system === "IMPERIAL") {
    const inchLength = text.match(/\bx\s*(\d+(?:\s+\d+\/\d+|\/\d+)?)\s*(?:in\b|inch(?:es)?\b|")/i);
    if (inchLength) {
      const value = inchLength[1].trim();
      const whole = value.match(/^(\d+)\s+(\d+\/\d+)$/);
      if (whole) {
        const [num, den] = whole[2].split("/").map(Number);
        lengthMm = Math.round((Number(whole[1]) + num / den) * 25.4 * 100) / 100;
      } else if (value.includes("/")) {
        const [num, den] = value.split("/").map(Number);
        if (den) lengthMm = Math.round((num / den) * 25.4 * 100) / 100;
      } else {
        lengthMm = Math.round(Number(value) * 25.4 * 100) / 100;
      }
    }
  }
  if (lengthMm == null) {
    const plainX = text.match(/\bx\s*(\d+(?:\.\d+)?)\s*mm\b/i);
    if (plainX) lengthMm = Number(plainX[1]);
  }

  // A stated pitch that equals the coarse pitch for the diameter keeps the coarse label.
  if (threadSeries === "METRIC_COARSE" && pitchMm != null && diameter) {
    const size = Number(diameter.replace(/^M/, ""));
    if (COARSE_PITCH[size] != null && Math.abs(COARSE_PITCH[size] - pitchMm) > 0.001) {
      threadSeries = "METRIC_FINE";
    }
  }

  const headType = /\bsocket\s*head\b/i.test(text)
    ? "Socket head"
    : /\bhex\s*(?:head|bolt)\b/i.test(text)
      ? "Hex head"
      : /\bpan\s*head\b/i.test(text)
        ? "Pan head"
        : /\bcountersunk|flat\s*head\b/i.test(text)
          ? "Countersunk"
          : /\bbutton\s*head\b/i.test(text)
            ? "Button head"
            : /\bflange\s*head\b/i.test(text)
              ? "Flange head"
              : null;
  const driveType = /\bhex\s*socket\b|\ballen\b/i.test(text)
    ? "Hex socket"
    : /\bphillips\b/i.test(text)
      ? "Phillips"
      : /\bpozi\b/i.test(text)
        ? "Pozi"
        : /\btorx\b/i.test(text)
          ? "Torx"
          : /\bslotted\b/i.test(text)
            ? "Slotted"
            : null;

  // Nuts, washers and similar parts have no length. A trailing number after the
  // diameter is the thread pitch, so never present it as a length.
  if (!lengthApplies(type)) lengthMm = null;

  const material = parseMaterial(`${input.material ?? ""} ${input.grade ?? ""} ${text}`);
  const propertyClass = parsePropertyClass(`${input.grade ?? ""} ${text}`) ?? parsePropertyClass(text);

  return {
    version: FASTENER_SPEC_VERSION,
    type,
    diameter,
    diameterSystem: system,
    threadSeries,
    pitchMm,
    lengthMm,
    headType,
    driveType,
    material,
    propertyClass,
    finish: parseFinish(text),
    standard: input.standard ? parseStandard(input.standard) ?? input.standard.toUpperCase() : parseStandard(text),
    certification: parseCertification(text),
    packMultiple: input.packMultiple ?? null,
    packagingUnit: input.packagingUnit ?? null,
    rawText: input.rawText ?? null,
  };
}

export function parseFastenerSpecJson(json: string | null | undefined): FastenerSpec | null {
  if (!json) return null;
  try {
    const parsed = FastenerSpecSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isFastenerCategory(category: string | null | undefined): boolean {
  return (category ?? "").toLowerCase().includes("fastener");
}

const THREADED_TYPES: FastenerType[] = [
  "HEX_BOLT",
  "SOCKET_HEAD_CAP_SCREW",
  "MACHINE_SCREW",
  "STUD",
  "THREADED_ROD",
  "HEX_NUT",
  "LOCK_NUT",
  "ANCHOR",
];
const LENGTH_TYPES: FastenerType[] = [
  "HEX_BOLT",
  "SOCKET_HEAD_CAP_SCREW",
  "MACHINE_SCREW",
  "STUD",
  "THREADED_ROD",
  "ANCHOR",
];

export function threadApplies(type: FastenerType | null): boolean {
  return type != null && THREADED_TYPES.includes(type);
}
export function lengthApplies(type: FastenerType | null): boolean {
  return type != null && LENGTH_TYPES.includes(type);
}

/** Fields required before a fastener line can be priced or sourced. */
export function missingFastenerFields(spec: FastenerSpec): string[] {
  const missing: string[] = [];
  if (!spec.type) missing.push("Fastener type");
  if (!spec.diameter) missing.push("Diameter");
  if (threadApplies(spec.type)) {
    if (!spec.threadSeries) missing.push("Thread system");
    // A metric pitch must be stated. UNC/UNF/BSP/NPT define their thread by the
    // series and nominal size, so a millimetre pitch is not applicable there.
    const needsMetricPitch =
      spec.threadSeries === "METRIC_COARSE" || spec.threadSeries === "METRIC_FINE" || spec.threadSeries == null;
    if (needsMetricPitch && spec.pitchMm == null) missing.push("Thread pitch");
  }
  if (lengthApplies(spec.type) && spec.lengthMm == null) missing.push("Length");
  if (!spec.material) missing.push("Material");
  if (!spec.propertyClass) missing.push("Property class");
  if (!spec.finish) missing.push("Finish");
  return missing;
}

export function fastenerSpecSummary(spec: FastenerSpec | null | undefined): string {
  if (!spec) return "";
  const parts: string[] = [];
  if (spec.type) parts.push(FASTENER_TYPE_LABELS[spec.type]);
  if (spec.diameter) parts.push(spec.diameter);
  if (spec.threadSeries) parts.push(THREAD_LABELS[spec.threadSeries]);
  if (spec.pitchMm != null) parts.push(`pitch ${spec.pitchMm} mm`);
  if (spec.lengthMm != null && lengthApplies(spec.type)) parts.push(`${spec.lengthMm} mm long`);
  if (spec.headType) parts.push(spec.headType.toLowerCase());
  if (spec.material) parts.push(spec.material);
  if (spec.propertyClass) parts.push(`class ${spec.propertyClass}`);
  if (spec.finish) parts.push(FINISH_LABELS[spec.finish]);
  if (spec.standard) parts.push(spec.standard);
  if (spec.certification) parts.push(spec.certification);
  return parts.join(" · ");
}

export type FastenerComparison = {
  status: "EXACT" | "EQUIVALENT" | "POSSIBLE" | "INSUFFICIENT" | "NO_MATCH";
  reasons: string[];
  mismatches: string[];
  missing: string[];
  fieldResults: Array<{ field: string; requested: string | null; offered: string | null; result: "MATCH" | "MISSING" | "MISMATCH" }>;
};

function fieldResult(
  field: string,
  requested: string | null,
  offered: string | null,
  equal: boolean,
  out: FastenerComparison,
) {
  if (!requested) {
    out.fieldResults.push({ field, requested: null, offered, result: offered ? "MATCH" : "MISSING" });
    return;
  }
  if (!offered) {
    out.missing.push(field);
    out.fieldResults.push({ field, requested, offered: null, result: "MISSING" });
    return;
  }
  if (equal) {
    out.reasons.push(`${field} matches (${offered}).`);
    out.fieldResults.push({ field, requested, offered, result: "MATCH" });
  } else {
    out.mismatches.push(`${field} differs: requested ${requested}, offered ${offered}.`);
    out.fieldResults.push({ field, requested, offered, result: "MISMATCH" });
  }
}

function sameStandard(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v ?? "").toUpperCase().replace(/[\s_-]+/g, "");
  return norm(a) === norm(b);
}

/**
 * Deterministic comparison of two fastener specifications.
 *
 * - a conflict in any requested critical attribute → NO_MATCH (never eligible)
 * - a requested attribute absent from the offer → INSUFFICIENT (needs confirmation)
 * - no requested attribute absent and no conflict → EXACT
 *
 * Substitutions are never accepted here; an owner-approved equivalence is applied
 * by the caller, not by this function.
 */
export function compareFastenerSpecs(requested: FastenerSpec, offered: FastenerSpec): FastenerComparison {
  const out: FastenerComparison = {
    status: "EXACT",
    reasons: [],
    mismatches: [],
    missing: [],
    fieldResults: [],
  };

  fieldResult(
    "Fastener type",
    requested.type ? FASTENER_TYPE_LABELS[requested.type] : null,
    offered.type ? FASTENER_TYPE_LABELS[offered.type] : null,
    requested.type === offered.type,
    out,
  );

  fieldResult("Diameter", requested.diameter, offered.diameter, requested.diameter === offered.diameter, out);

  if (threadApplies(requested.type)) {
    fieldResult(
      "Thread system",
      requested.threadSeries ? THREAD_LABELS[requested.threadSeries] : null,
      offered.threadSeries ? THREAD_LABELS[offered.threadSeries] : null,
      requested.threadSeries === offered.threadSeries,
      out,
    );
    if (requested.pitchMm != null || offered.pitchMm != null) {
      fieldResult(
        "Thread pitch",
        requested.pitchMm != null ? `${requested.pitchMm} mm` : null,
        offered.pitchMm != null ? `${offered.pitchMm} mm` : null,
        requested.pitchMm != null &&
          offered.pitchMm != null &&
          Math.abs(requested.pitchMm - offered.pitchMm) < 0.001,
        out,
      );
    }
  }

  if (lengthApplies(requested.type)) {
    fieldResult(
      "Length",
      requested.lengthMm != null ? `${requested.lengthMm} mm` : null,
      offered.lengthMm != null ? `${offered.lengthMm} mm` : null,
      requested.lengthMm != null &&
        offered.lengthMm != null &&
        Math.abs(requested.lengthMm - offered.lengthMm) < 0.001,
      out,
    );
  }

  const normMat = (v: string | null) => (v ? normalizeMaterial(v) : null);
  fieldResult("Material", requested.material, offered.material, normMat(requested.material) === normMat(offered.material), out);

  fieldResult(
    "Property class",
    requested.propertyClass ? normalizeGrade(requested.propertyClass) : null,
    offered.propertyClass ? normalizeGrade(offered.propertyClass) : null,
    Boolean(requested.propertyClass) &&
      Boolean(offered.propertyClass) &&
      normalizeGrade(requested.propertyClass) === normalizeGrade(offered.propertyClass),
    out,
  );

  fieldResult(
    "Finish",
    requested.finish ? FINISH_LABELS[requested.finish] : null,
    offered.finish ? FINISH_LABELS[offered.finish] : null,
    requested.finish === offered.finish,
    out,
  );

  // A standard matters only when the customer stated one.
  if (requested.standard) {
    fieldResult(
      "Standard",
      requested.standard,
      offered.standard,
      sameStandard(requested.standard, offered.standard),
      out,
    );
  }
  if (requested.headType) {
    fieldResult("Head type", requested.headType, offered.headType, sameStandard(requested.headType, offered.headType), out);
  }
  if (requested.driveType) {
    fieldResult("Drive", requested.driveType, offered.driveType, sameStandard(requested.driveType, offered.driveType), out);
  }
  if (requested.certification) {
    fieldResult(
      "Certification",
      requested.certification,
      offered.certification,
      offered.certification != null && requested.certification.toLowerCase() === offered.certification.toLowerCase(),
      out,
    );
  }

  // Requested specification incomplete: a verification cannot be claimed.
  const requestMissing = missingFastenerFields(requested);
  if (requestMissing.length > 0) {
    out.missing.push(...requestMissing.filter((field) => !out.missing.includes(field)));
    out.status = "INSUFFICIENT";
  } else if (out.mismatches.length > 0) {
    out.status = "NO_MATCH";
  } else if (out.missing.length > 0) {
    out.status = "INSUFFICIENT";
  } else {
    out.status = "EXACT";
  }

  return out;
}

/** True when every critical requested attribute is present on the request. */
export function isFastenerSpecComplete(spec: FastenerSpec | null | undefined): boolean {
  return Boolean(spec && missingFastenerFields(spec).length === 0);
}
