import { z } from "zod";
import { completeJson, aiStatus, DATA_ONLY_RULE } from "../ai/provider";
import {
  containsInternalWording,
  containsMalformedUnit,
  hasProductEvidence,
  normalizeDescriptionForComparison,
  stripInternalWording,
} from "../ai/segmentation";
import {
  normalizeMaterial,
  normalizePressure,
  normalizeSchedule,
  normalizeSize,
  normalizeUnit,
  sizeToMm,
} from "../catalog/normalize";

/**
 * Supplier-facing RFQ composition.
 *
 * Internal procurement data (catalogue matches, confidence scores, source refs,
 * review notes) and supplier-facing content are separate representations. Only
 * validated customer/technical fields are rendered; unknown values are omitted
 * or turned into an explicit clarification request, never invented.
 */

export type SupplierRfqItem = {
  description: string;
  quantity: number | null;
  unit?: string | null;
  size?: string | null;
  material?: string | null;
  grade?: string | null;
  pressureRating?: string | null;
  schedule?: string | null;
  standard?: string | null;
  brand?: string | null;
  missingFields?: string[] | null;
  /** Internal sourcing notes. Never rendered. */
  internalNotes?: string | null;
  /** Provenance such as "page 2" or "Sheet1 row 14". Never rendered. */
  sourceRef?: string | null;
  /** A catalogue URL may be shown only when it was explicitly marked public. */
  publicReferenceUrl?: string | null;
};

export type SupplierRfqRequest = {
  supplierName: string;
  companyName: string;
  enquiryRef: string;
  items: SupplierRfqItem[];
  link: string;
  correlationToken?: string | null;
  requiredDelivery?: string | null;
};

export type SupplierRfqFinding = {
  code: string;
  severity: "error" | "warning";
  message: string;
  itemIndex?: number;
};

export type SupplierRfqDraft = {
  subject: string;
  body: string;
  items: Array<{
    description: string;
    quantity: number;
    unit: string;
    specification: string | null;
    clarifications: string[];
  }>;
  findings: SupplierRfqFinding[];
  ok: boolean;
};

const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const EMPTY_SPEC_LABEL =
  /\b(?:size|dimensions?|material|grade|standard|class|schedule|pressure(?:\s+rating)?|thickness|diameter)[ \t]*[:=][ \t]*(?=[,;)\]–—\n]|$)/i;

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeQuantity(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

function normalizedSpecValue(field: string, value: string | null): string | null {
  if (!value) return null;
  if (field === "material") return normalizeMaterial(value)?.toUpperCase() ?? value;
  if (field === "size") return normalizeSize(value) ?? value;
  if (field === "grade") return value.toUpperCase().replace(/\s+/g, " ");
  if (field === "standard") return value.toUpperCase().replace(/\s+/g, " ");
  if (field === "schedule") return value.toUpperCase().replace(/\s+/g, "");
  if (field === "pressureRating") return value.toUpperCase().replace(/\s+/g, " ");
  return value;
}

/** Strips duplicate spec tokens and internal fragments from a description. */
export function cleanSupplierDescription(description: string, _fields: Partial<SupplierRfqItem> = {}): string {
  const stripped = stripInternalWording(description);

  // Split into clauses and drop a clause that is already part of what came
  // before. This removes catalogue-style repetition ("... carbon steel —
  // carbon steel — ASTM A234") without deleting a distinct 90° or LR detail.
  const clauses = stripped
    .split(/\s*[,;·|]\s*|\s+[–—-]\s+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const clause of clauses) {
    const normalized = normalizeDescriptionForComparison(clause);
    if (!normalized) continue;
    const accumulated = normalizeDescriptionForComparison(kept.join(" "));
    if (accumulated && (` ${accumulated} `).includes(` ${normalized} `)) continue;
    kept.push(clause);
  }

  let value = kept
    .join(", ")
    .replace(/\s*[,;·|/]\s*(?=$|[,;·|/])/g, " ")
    .replace(/[\s,;·|/–—-]+$/g, "")
    .replace(/^[\s,;·|/–—-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Keep the line readable. Cut at a word boundary, never mid-token.
  if (value.length > 220) {
    const cut = value.slice(0, 220);
    value = cut.slice(0, Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","))) || cut;
  }
  return value;
}

function descriptionCovers(field: string, value: string, description: string): boolean {
  if (field === "size") {
    const target = sizeToMm(value);
    if (target == null) return false;
    const sizes = description.match(/\b(?:dn\s*\d+|\d+(?:\.\d+)?\s*(?:in|inch|mm)|"|\d+\/\d+\s*(?:in|inch)?)/gi) ?? [];
    return sizes.some((entry) => {
      const mm = sizeToMm(entry.replace(/"/g, " in "));
      return mm != null && Math.abs(mm - target) < 0.01;
    });
  }
  if (field === "pressureRating") {
    return normalizePressure(description) === normalizePressure(value);
  }
  if (field === "schedule") {
    return normalizeSchedule(description) === normalizeSchedule(value);
  }
  if (field === "material") {
    const material = normalizeMaterial(value);
    return material != null && normalizeMaterial(description) === material;
  }
  return false;
}

function specParts(item: SupplierRfqItem, description: string): string[] {
  const normalizedDescription = ` ${normalizeDescriptionForComparison(description)} `;
  const descriptionTokens = new Set(normalizedDescription.trim().split(/\s+/).filter(Boolean));
  const candidates: Array<{ field: string; value: string | null; label?: string }> = [
    { field: "size", value: clean(item.size) },
    { field: "material", value: clean(item.material) },
    { field: "grade", value: clean(item.grade) },
    { field: "schedule", value: clean(item.schedule) },
    { field: "pressureRating", value: clean(item.pressureRating) },
    { field: "standard", value: clean(item.standard) },
    { field: "brand", value: clean(item.brand) },
  ];

  const parts: string[] = [];
  for (const candidate of candidates) {
    const value = normalizedSpecValue(candidate.field, candidate.value);
    if (!value) continue;
    if (descriptionCovers(candidate.field, value, description)) continue;
    const normalizedValue = normalizeDescriptionForComparison(value);
    if (normalizedValue && normalizedDescription.includes(` ${normalizedValue} `)) continue;
    const valueTokens = normalizedValue.split(/\s+/).filter(Boolean);
    // A multi-word specification is already present when every token is present,
    // even if the wording order differs (e.g. "ASTM A234 WPB" vs "A234 WPB").
    if (valueTokens.length > 1 && valueTokens.every((token) => descriptionTokens.has(token))) continue;
    // Grade written as "Gr X" in the description is already present.
    if (candidate.field === "grade" && normalizedDescription.includes(` gr ${normalizedValue} `)) continue;
    parts.push(value);
  }
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
}

function clarificationLabels(item: SupplierRfqItem): string[] {
  const labels = (item.missingFields ?? [])
    .map((label) => label.trim())
    .filter((label) => label.length > 0 && !/^quantity$/i.test(label));
  return [...new Set(labels.map((label) => label.toLowerCase()))];
}

function itemKey(item: SupplierRfqItem, description: string, parts: string[]): string {
  return [
    normalizeDescriptionForComparison(description),
    normalizeQuantity(item.quantity) ?? "",
    normalizeUnit(item.unit ?? null),
    ...parts.map((part) => normalizeDescriptionForComparison(part)),
  ].join("|");
}

/**
 * Builds the clean supplier-facing lines. Repeated products and catalogue
 * references are collapsed; genuinely separate quantities/specifications stay.
 */
export function buildSupplierRfqLines(items: SupplierRfqItem[]): SupplierRfqDraft["items"] {
  const kept: Array<SupplierRfqDraft["items"][number] & { key: string }> = [];
  for (const item of items) {
    const description = cleanSupplierDescription(item.description, item);
    const quantity = normalizeQuantity(item.quantity) ?? 0;
    const unit = normalizeUnit(item.unit ?? null);
    const parts = specParts(item, description);
    const key = itemKey(item, description, parts);
    const existing = kept.find((entry) => entry.key === key);
    if (existing) {
      existing.clarifications = [
        ...new Set([...existing.clarifications, ...clarificationLabels(item).map((label) => `Please confirm the ${label}.`)]),
      ];
      continue;
    }
    kept.push({
      key,
      description,
      quantity,
      unit,
      specification: parts.length > 0 ? parts.join(", ") : null,
      clarifications: clarificationLabels(item).map((label) => `Please confirm the ${label}.`),
    });
  }
  return kept.map(({ key: _key, ...entry }) => entry);
}

function supplierGreeting(supplierName: string): string {
  const name = supplierName.trim();
  if (!name || /^www\./i.test(name) || /\.[a-z]{2,}$/i.test(name) || !/[a-z]/i.test(name)) {
    return "Sales Team";
  }
  return name;
}

function subjectHeadline(items: SupplierRfqDraft["items"]): string | null {
  if (items.length === 0) return null;
  const first = items[0].description;
  if (!first) return null;
  const headline = first.split(/[,;–—]/)[0].trim();
  if (items.length === 1) return headline.slice(0, 80);
  return `${headline.slice(0, 60)} and ${items.length - 1} other item${items.length === 2 ? "" : "s"}`;
}

export function composeSupplierRfq(input: SupplierRfqRequest): SupplierRfqDraft {
  const items = buildSupplierRfqLines(input.items);
  const headline = subjectHeadline(items);
  const subject = [
    "Quotation request",
    input.enquiryRef,
    headline ? `— ${headline}` : null,
    input.correlationToken ? `[RFQ-${input.correlationToken}]` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const lines: string[] = [`Dear ${supplierGreeting(input.supplierName)},`, ""];
  if (items.length === 0) {
    lines.push("Please provide your quotation for the requested item.", "");
  } else if (items.length === 1) {
    lines.push("Please provide your quotation for the following item:", "");
  } else {
    lines.push("Please provide your quotation for the following items:", "");
  }

  items.forEach((item, index) => {
    const quantity = item.quantity > 0 ? `${item.quantity} ${item.unit}` : "quantity to be confirmed";
    const spec = item.specification ? `, ${item.specification}` : "";
    lines.push(`${index + 1}. ${item.description}${spec} — ${quantity}`);
  });

  const clarifications = [...new Set(items.flatMap((item) => item.clarifications))];
  if (clarifications.length > 0) {
    lines.push("", "Please confirm before quoting:");
    for (const clarification of clarifications.slice(0, 8)) lines.push(`- ${clarification}`);
  }

  lines.push(
    "",
    "Please confirm:",
    "- Unit price and currency",
    "- Minimum order quantity",
    "- Availability",
    "- Lead time",
    "- Quotation validity",
    "- Payment terms",
    "- Delivery terms",
    "",
    "Please identify any deviations from the requested specifications.",
  );

  if (input.requiredDelivery) {
    lines.push("", `Customer's requested delivery: ${input.requiredDelivery}.`);
  }
  if (input.correlationToken) lines.push("", `Reference: RFQ-${input.correlationToken}`);
  lines.push("", `You can submit your quotation securely here: ${input.link}`, "");
  lines.push("Best regards,", "Procurement", input.companyName);

  const draft = {
    subject: subject.replace(/\s{2,}/g, " ").slice(0, 180),
    body: lines.join("\n"),
    items,
    findings: [] as SupplierRfqFinding[],
    ok: true,
  };
  // The lines are already deduplicated, so the duplicate check is applied to the
  // composed output rather than re-flagging the raw request.
  const findings = validateSupplierRfqDraft(
    { subject: draft.subject, body: draft.body, items: input.items },
    { alreadyDeduplicated: true },
  );
  return { ...draft, findings, ok: findings.every((finding) => finding.severity !== "error") };
}

/**
 * Deterministic validation for objective defects. It never fills a gap: an
 * unknown specification stays unknown and is reported to the owner.
 */
export function validateSupplierRfqDraft(
  input: {
    subject: string;
    body: string;
    items: SupplierRfqItem[];
  },
  options: { alreadyDeduplicated?: boolean } = {},
): SupplierRfqFinding[] {
  const findings: SupplierRfqFinding[] = [];
  const body = input.body ?? "";
  const subject = input.subject ?? "";
  const text = `${subject}\n${body}`;

  if (containsInternalWording(text)) {
    findings.push({
      code: "INTERNAL_WORDING",
      severity: "error",
      message: "The supplier-facing draft contains internal catalogue, sourcing or review wording.",
    });
  }

  if (EMPTY_SPEC_LABEL.test(text)) {
    findings.push({
      code: "EMPTY_SPEC_LABEL",
      severity: "error",
      message: "A specification label has no value (for example 'Size:' with nothing after it).",
    });
  }

  if (containsMalformedUnit(text)) {
    findings.push({
      code: "MALFORMED_UNIT",
      severity: "error",
      message: "A quantity unit is missing or malformed.",
    });
  }

  const urls = text.match(URL_PATTERN) ?? [];
  const urlCounts = new Map<string, number>();
  for (const url of urls) {
    const key = url.replace(/[.,;)]+$/, "").toLowerCase();
    urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1);
  }
  for (const [url, count] of urlCounts) {
    if (count > 1) {
      findings.push({
        code: "REPEATED_URL",
        severity: "error",
        message: `The same link appears ${count} times in the supplier message.`,
      });
    }
    if (/catalog|catalogue|ogs/i.test(url)) {
      findings.push({
        code: "INTERNAL_URL",
        severity: "error",
        message: "An internal catalogue link must not be sent to a supplier.",
      });
    }
  }

  const ids = text.match(/\b(?:c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi) ?? [];
  if (ids.length > 0) {
    findings.push({
      code: "INTERNAL_IDENTIFIER",
      severity: "error",
      message: "An internal database identifier appears in the supplier-facing draft.",
    });
  }

  const seen = new Map<string, number>();
  input.items.forEach((item, index) => {
    const description = cleanSupplierDescription(item.description, item);
    if (!description) {
      findings.push({
        code: "MISSING_DESCRIPTION",
        severity: "error",
        message: `Item ${index + 1} has no usable product description.`,
        itemIndex: index,
      });
    }
    if (!hasProductEvidence(description)) {
      findings.push({
        code: "NOT_A_PRODUCT",
        severity: "error",
        message: `Item ${index + 1} does not name a requested product and must not be quoted as one.`,
        itemIndex: index,
      });
    }
    if (normalizeQuantity(item.quantity) == null) {
      findings.push({
        code: "MISSING_QUANTITY",
        severity: "error",
        message: `Item ${index + 1} has no valid quantity. Ask the customer before sending an RFQ.`,
        itemIndex: index,
      });
    }

    const parts = specParts(item, description);
    const key = itemKey(item, description, parts);
    if (!options.alreadyDeduplicated && seen.has(key)) {
      findings.push({
        code: "DUPLICATE_ITEM",
        severity: "error",
        message: `Item ${index + 1} repeats an earlier product line with the same quantity and specification.`,
        itemIndex: index,
      });
    } else if (!seen.has(key)) {
      seen.set(key, index);
    }

    // A known field must not contradict the original description.
    if (item.material && /ss\s*316|stainless\s*316/i.test(description) && normalizeMaterial(item.material) !== "SS316") {
      findings.push({
        code: "CONTRADICTORY_SPECIFICATION",
        severity: "error",
        message: `Item ${index + 1} describes stainless steel 316 but records ${item.material}.`,
        itemIndex: index,
      });
    }
    const describedSize = description.match(/\b\d+(?:\.\d+)?\s*(?:in|inch|mm)\b/i)?.[0];
    if (item.size && describedSize && normalizeSize(item.size) !== normalizeSize(describedSize)) {
      findings.push({
        code: "CONTRADICTORY_SPECIFICATION",
        severity: "error",
        message: `Item ${index + 1} describes size ${describedSize} but records ${item.size}.`,
        itemIndex: index,
      });
    }

    if (description.split(/\s+/).length > 45) {
      findings.push({
        code: "VERBOSE_DESCRIPTION",
        severity: "warning",
        message: `Item ${index + 1} is unusually long; consider keeping only the requested product and confirmed specifications.`,
        itemIndex: index,
      });
    }
  });

  // A supplier-facing body line that is only a specification is a dangling
  // fragment, even when it is not attached to an item record.
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*\d+[.)]\s*/, "").replace(/\s*—\s*\d[\d,.]*\s*\w+\s*$/, "").trim();
    if (!cleaned) continue;
    if (cleaned.length <= 24 && !hasProductEvidence(cleaned) && /\d/.test(cleaned) && /(?:in|mm|ms|ss|class|sch)/i.test(cleaned)) {
      findings.push({
        code: "DANGLING_SPECIFICATION",
        severity: "error",
        message: "A line contains only a specification and no product description.",
      });
    }
  }

  if (body.length > 8000) {
    findings.push({
      code: "VERBOSE_MESSAGE",
      severity: "warning",
      message: "The supplier message is unusually long. Check that only requested products and relevant questions are included.",
    });
  }

  // De-duplicate identical findings (the same defect can be detected twice).
  const unique = new Map<string, SupplierRfqFinding>();
  for (const finding of findings) {
    const key = `${finding.code}|${finding.itemIndex ?? ""}|${finding.message}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

const AiRfqReviewSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(["error", "warning"]),
        code: z.string().min(1).max(60),
        message: z.string().min(1).max(300),
        itemIndex: z.number().int().nonnegative().optional(),
      }),
    )
    .max(20)
    .default([]),
  summary: z.string().max(500).optional(),
});

/**
 * Semantic quality review. The model may only judge the supplied draft; it must
 * not add specifications, prices or product claims. A failure simply leaves the
 * deterministic validation in force.
 */
export async function reviewSupplierRfqWithAi(input: {
  subject: string;
  body: string;
  items: SupplierRfqItem[];
}): Promise<SupplierRfqFinding[]> {
  if (!aiStatus().configured) return [];
  const result = await completeJson(
    {
      system:
        "You review a supplier-facing request for quotation from a procurement company. Judge only the text supplied. " +
        "Flag, as errors: internal catalogue or sourcing wording, duplicated product lines, repeated links, dangling specification fragments, empty specification labels, malformed units, missing quantities, contradictory specifications, internal identifiers and unsupported technical claims. " +
        "Flag as warnings: unprofessional or excessively verbose wording and missing clarification questions. " +
        "Never add, infer or request a specification value, price, grade or standard that is not already in the draft. Do not rewrite the draft. " +
        'Reply with JSON only: {"findings":[{"severity":"error"|"warning","code":string,"message":string,"itemIndex":number?}],"summary":string}. ' +
        DATA_ONLY_RULE,
      user:
        `<subject>${input.subject.slice(0, 300)}</subject>\n` +
        `<body>\n${input.body.slice(0, 6000)}\n</body>\n` +
        `<structured_items>\n${JSON.stringify(
          input.items.slice(0, 12).map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            size: item.size,
            material: item.material,
            grade: item.grade,
            pressureRating: item.pressureRating,
            schedule: item.schedule,
            standard: item.standard,
          })),
        ).slice(0, 4000)}\n</structured_items>`,
      maxTokens: 800,
      jobType: "supplier_rfq.quality_review",
    },
    AiRfqReviewSchema,
  );
  if (!result.ok) return [];
  return result.data.findings.map((finding) => ({
    code: finding.code.toUpperCase().slice(0, 60),
    severity: finding.severity,
    message: finding.message,
    itemIndex: finding.itemIndex,
  }));
}

/** Combines deterministic and semantic findings without weakening either. */
export function mergeRfqFindings(
  deterministic: SupplierRfqFinding[],
  semantic: SupplierRfqFinding[],
): SupplierRfqFinding[] {
  const unique = new Map<string, SupplierRfqFinding>();
  for (const finding of [...deterministic, ...semantic]) {
    const key = `${finding.code}|${finding.itemIndex ?? ""}|${finding.message.toLowerCase().slice(0, 120)}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

export function supplierRfqProblems(findings: SupplierRfqFinding[]): string[] {
  return findings
    .filter((finding) => finding.severity === "error")
    .map((finding) => finding.message)
    .slice(0, 5);
}
