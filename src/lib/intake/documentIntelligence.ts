import { randomUUID } from "node:crypto";
import { env } from "../env";
import {
  detectDocumentFormat,
  type DocumentFormatId,
  type FormatDetection,
} from "./formats";
import {
  extractDocumentNative,
  type DocumentText,
  type ExtractedTable,
} from "./documents-core";

/**
 * Unified document analysis around the existing parsers.
 *
 * This layer does not replace the PDF/Excel/DOCX/OCR code. It identifies the
 * real format, runs the matching native parser, measures whether the result is
 * actually usable, retains structured tables, and returns a processing state the
 * worker and review screen can persist.
 */

export type DocumentProcessingStatus =
  | "RECEIVED"
  | "VALIDATING"
  | "EXTRACTING"
  | "OCR_PROCESSING"
  | "VISION_PROCESSING"
  | "SEMANTIC_ANALYSIS"
  | "VALIDATING_RESULTS"
  | "COMPLETED"
  | "PARTIAL"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "UNSUPPORTED"
  | "PASSWORD_PROTECTED";

export type DocumentProcessingStage = "DETECTED" | "NATIVE" | "OCR" | "VISION_READY" | "VALIDATED";

export type DocumentQualityIssue = {
  code:
    | "EMPTY_TEXT"
    | "LOW_TEXT_DENSITY"
    | "GARBLED_TEXT"
    | "PAGE_LOW_TEXT"
    | "PASSWORD_PROTECTED"
    | "UNSUPPORTED_FORMAT"
    | "TABLE_SHAPE"
    | "SKIPPED_PAGES"
    | "OCR_CAVEAT"
    | "PARSER_CAVEAT";
  severity: "INFO" | "WARNING" | "ERROR";
  message: string;
  page?: number;
};

export type DocumentPageQuality = {
  page: number;
  chars: number;
  ocr: boolean;
  status: "READABLE" | "LOW_TEXT" | "UNREADABLE";
};

export type DocumentQuality = {
  status: "GOOD" | "PARTIAL" | "POOR" | "FAILED";
  score: number;
  textDensity: number | null;
  issues: DocumentQualityIssue[];
  pages: DocumentPageQuality[];
  tables: number;
  tableRows: number;
};

export type AnalyzedDocument = DocumentText & {
  format: DocumentFormatId;
  detection: FormatDetection;
  quality: DocumentQuality;
  processingStatus: DocumentProcessingStatus;
  processingStage: DocumentProcessingStage;
};

const MIN_PAGE_TEXT_CHARS = 20;
const MAX_TABLES_IN_QUALITY = 100;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("DOCUMENT_PARSER_TIMEOUT"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Converts parser/provider failures into a safe owner-facing explanation. */
export function friendlyDocumentError(
  error: unknown,
  format?: DocumentFormatId | null,
): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw === "DOCUMENT_PARSER_TIMEOUT" || /timed?\s*out|timeout/i.test(raw)) {
    return {
      code: "PARSER_TIMEOUT",
      message: "This file took too long to read. The original is stored; try again or ask for a simpler PDF copy.",
    };
  }
  if (/password|encrypt/i.test(raw)) {
    return {
      code: "PASSWORD_PROTECTED",
      message: "This file is password-protected. Provide an unlocked copy so it can be read.",
    };
  }
  if (/unsupported|not supported/i.test(raw)) {
    return {
      code: "UNSUPPORTED_FORMAT",
      message: "This file type is not supported by the reader. The original is kept for review; ask for a PDF copy.",
    };
  }
  if (/zip|decompress|archive|central directory/i.test(raw)) {
    return {
      code: "ARCHIVE_ERROR",
      message: "The archive could not be opened safely. The original is kept; ask the sender to re-send the individual files.",
    };
  }
  if (/memory|heap|allocation|buffer/i.test(raw)) {
    return {
      code: "FILE_TOO_COMPLEX",
      message: "This file is too large or complex to read safely. The original is kept; try a smaller or flattened copy.",
    };
  }
  if (/ocr|tesseract|language data/i.test(raw)) {
    return {
      code: "OCR_UNAVAILABLE",
      message: "Text recognition is temporarily unavailable. The file is stored and can be retried.",
    };
  }
  return {
    code: "EXTRACTION_FAILED",
    message: `${format ? `${format} file` : "The file"} could not be read automatically. The original is stored; compare it manually or retry.`,
  };
}

function qualityFor(
  parsed: DocumentText,
  detection: FormatDetection,
): DocumentQuality {
  const issues: DocumentQualityIssue[] = [];
  const text = parsed.text ?? "";
  const normalized = text.replace(/\[page \d+\]/gi, "").trim();
  const pageCount = parsed.pageCount && parsed.pageCount > 0 ? parsed.pageCount : null;
  const textDensity = pageCount ? normalized.length / pageCount : null;
  const pages: DocumentPageQuality[] = (parsed.pages ?? []).map((page) => {
    const chars = page.text.trim().length;
    return {
      page: page.page,
      chars,
      ocr: page.ocr,
      status: chars === 0 ? "UNREADABLE" : chars < MIN_PAGE_TEXT_CHARS ? "LOW_TEXT" : "READABLE",
    };
  });

  if (detection.encrypted) {
    issues.push({
      code: "PASSWORD_PROTECTED",
      severity: "ERROR",
      message: "The file is password-protected, so its contents were not read.",
    });
  } else if (!detection.info.supported) {
    issues.push({
      code: "UNSUPPORTED_FORMAT",
      severity: "ERROR",
      message: detection.note ?? "This format is not supported by the document reader.",
    });
  }

  if (!normalized) {
    issues.push({
      code: "EMPTY_TEXT",
      severity: "ERROR",
      message: "No readable text was found in this document.",
    });
  } else {
    if (textDensity != null && textDensity < MIN_PAGE_TEXT_CHARS) {
      issues.push({
        code: "LOW_TEXT_DENSITY",
        severity: "WARNING",
        message: "Very little text was read for the number of pages. Some pages may be scans or images.",
      });
    }
    const garbled =
      normalized.match(/\uFFFD|Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|\u0000/g)?.length ?? 0;
    const control =
      normalized.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g)?.length ?? 0;
    if ((garbled + control) / Math.max(1, normalized.length) > 0.01 && garbled + control > 3) {
      issues.push({
        code: "GARBLED_TEXT",
        severity: "WARNING",
        message: "Some characters look garbled. Compare the extracted text with the original document.",
      });
    }
    for (const page of pages) {
      if (page.status === "UNREADABLE") {
        issues.push({
          code: "PAGE_LOW_TEXT",
          severity: "ERROR",
          message: `Page ${page.page} has no readable text.`,
          page: page.page,
        });
      } else if (page.status === "LOW_TEXT") {
        issues.push({
          code: "PAGE_LOW_TEXT",
          severity: "WARNING",
          message: `Page ${page.page} has very little readable text.`,
          page: page.page,
        });
      }
    }
  }

  const tables = (parsed.tables ?? []).slice(0, MAX_TABLES_IN_QUALITY);
  for (const table of tables) {
    const expected = Math.max(table.header.length, ...table.rows.map((row) => row.cells.length), 0);
    const irregular = table.rows.filter((row) => row.cells.length !== expected).length;
    if (expected > 1 && irregular > Math.max(1, table.rows.length * 0.2)) {
      issues.push({
        code: "TABLE_SHAPE",
        severity: "WARNING",
        message: `A table${table.sheet ? ` in ${table.sheet}` : table.page ? ` on page ${table.page}` : ""} has rows with different column counts. Check its columns.`,
      });
    }
  }

  const skippedPages = Number(parsed.metadata?.skippedPages ?? 0);
  if (Number.isFinite(skippedPages) && skippedPages > 0) {
    issues.push({
      code: "SKIPPED_PAGES",
      severity: "WARNING",
      message: `${skippedPages} page(s) were beyond the safe processing limit and were not read.`,
    });
  }
  if (parsed.ocrUsed && parsed.note) {
    issues.push({
      code: "OCR_CAVEAT",
      severity: "INFO",
      message: parsed.note,
    });
  } else if (parsed.note && parsed.status === "NEEDS_REVIEW" && parsed.note !== detection.note) {
    issues.push({
      code: "PARSER_CAVEAT",
      severity: "WARNING",
      message: parsed.note,
    });
  }

  const errors = issues.filter((issue) => issue.severity === "ERROR").length;
  const warnings = issues.filter((issue) => issue.severity === "WARNING").length;
  let score = 100;
  score -= errors * 30;
  score -= warnings * 8;
  if (parsed.status === "FAILED") score = 0;
  score = Math.max(0, Math.min(100, score));

  const status: DocumentQuality["status"] =
    parsed.status === "FAILED" || score === 0
      ? "FAILED"
      : !normalized && !parsed.images?.length
        ? "FAILED"
        : errors > 0 || score < 50
          ? "POOR"
          : warnings > 0 || parsed.status === "NEEDS_REVIEW" || parsed.status === "OCR_USED"
            ? "PARTIAL"
            : "GOOD";

  return {
    status,
    score,
    textDensity,
    issues,
    pages,
    tables: tables.length,
    tableRows: tables.reduce((sum, table) => sum + table.rows.length, 0),
  };
}

function processingState(
  parsed: DocumentText,
  detection: FormatDetection,
  quality: DocumentQuality,
): { status: DocumentProcessingStatus; stage: DocumentProcessingStage } {
  if (detection.encrypted) return { status: "PASSWORD_PROTECTED", stage: "VALIDATED" };
  if (!detection.info.supported) return { status: "UNSUPPORTED", stage: "VALIDATED" };
  if (parsed.status === "FAILED" || quality.status === "FAILED") return { status: "FAILED", stage: "VALIDATED" };
  const stage: DocumentProcessingStage = parsed.ocrUsed
    ? "OCR"
    : (parsed.images?.length ?? 0) > 0
      ? "VISION_READY"
      : "NATIVE";
  if (parsed.status === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", stage };
  if (quality.status === "PARTIAL" || quality.status === "POOR") return { status: "PARTIAL", stage };
  return { status: "COMPLETED", stage };
}

function combineNotes(parsed: DocumentText, detection: FormatDetection): string | null {
  const notes = [detection.note, parsed.note].filter((note): note is string => Boolean(note && note.trim()));
  const unique = [...new Set(notes)];
  return unique.length > 0 ? unique.join(" ") : null;
}

export type AnalyzeDocumentOptions = {
  declaredMime?: string | null;
  timeoutMs?: number;
};

/**
 * Analyzes one uploaded file without side effects. It never writes text or
 * images to disk, and never executes embedded content.
 */
export async function analyzeDocument(
  buffer: Buffer,
  filename: string,
  options: AnalyzeDocumentOptions = {},
): Promise<AnalyzedDocument> {
  const detection = detectDocumentFormat(buffer, filename, options.declaredMime);
  const timeoutMs = options.timeoutMs ?? env.DOCUMENT_PARSER_TIMEOUT_MS;

  if (detection.encrypted || !detection.info.supported) {
    const parsed: DocumentText = {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: detection.note,
      unreadable: true,
      encrypted: detection.encrypted,
      format: detection.format,
    };
    const quality = qualityFor(parsed, detection);
    const state = processingState(parsed, detection, quality);
    return {
      ...parsed,
      format: detection.format,
      detectedMime: detection.mime,
      extensionMismatch: detection.extensionMismatch,
      declaredMimeMismatch: detection.declaredMimeMismatch,
      encrypted: detection.encrypted,
      quality,
      processingStatus: state.status,
      processingStage: state.stage,
      detection,
    };
  }

  let parsed: DocumentText;
  try {
    parsed = await withTimeout(extractDocumentNative(buffer, filename), timeoutMs);
  } catch (error) {
    const safe = friendlyDocumentError(error, detection.format);
    // Structured log only; never log document content. The attachment id is
    // added by the persistence layer when it has one.
    console.error("[document-processing]", {
      traceId: randomUUID(),
      format: detection.format,
      stage: "native",
      code: safe.code,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
    parsed = {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: safe.message,
      unreadable: true,
      format: detection.format,
    };
  }

  parsed = {
    ...parsed,
    text: parsed.text ?? "",
    format: detection.format,
    detectedMime: detection.mime,
    extensionMismatch: detection.extensionMismatch,
    declaredMimeMismatch: detection.declaredMimeMismatch,
    encrypted: detection.encrypted,
    metadata: {
      ...(parsed.metadata ?? {}),
      sizeBytes: buffer.length,
      encrypted: detection.encrypted,
    },
  };
  const quality = qualityFor(parsed, detection);
  const state = processingState(parsed, detection, quality);
  const note = combineNotes(parsed, detection);

  return {
    ...parsed,
    note,
    unreadable: parsed.unreadable || (quality.status === "FAILED" && !parsed.images?.length),
    format: detection.format,
    detection,
    quality,
    processingStatus: state.status,
    processingStage: state.stage,
  };
}

export type DocumentPackageSummary = {
  version: string;
  status:
    | "RECEIVED"
    | "PROCESSING"
    | "COMPLETED"
    | "PARTIAL"
    | "NEEDS_REVIEW"
    | "FAILED"
    | "UNSUPPORTED"
    | "PASSWORD_PROTECTED";
  attachmentCount: number;
  supportedCount: number;
  unsupportedCount: number;
  partialCount: number;
  failedCount: number;
  formats: Array<{ format: DocumentFormatId; count: number }>;
  pagesProcessed: number;
  worksheetsProcessed: number;
  slidesProcessed: number;
  ocrPages: number;
  visionPages: number;
  tablesExtracted: number;
  tableRows: number;
  missingInformation: string[];
  failures: Array<{ attachmentId: string; filename: string; reason: string }>;
  partial: Array<{ attachmentId: string; filename: string; reason: string }>;
  unsupported: Array<{ attachmentId: string; filename: string; reason: string }>;
  duplicates: Array<{ attachmentId: string; filename: string; duplicateOf: string }>;
  notes: string[];
  processedAt: string;
};

/** Builds the package-level view shown to the owner. It never claims success for skipped content. */
export function summarizeDocumentPackage(
  documents: Array<{ attachmentId: string; filename: string; analysis: AnalyzedDocument }>,
  duplicates: Array<{ attachmentId: string; filename: string; duplicateOf: string }> = [],
): DocumentPackageSummary {
  const formatCounts = new Map<DocumentFormatId, number>();
  let pagesProcessed = 0;
  let worksheetsProcessed = 0;
  let slidesProcessed = 0;
  let ocrPages = 0;
  let visionPages = 0;
  let tablesExtracted = 0;
  let tableRows = 0;
  const failures: DocumentPackageSummary["failures"] = [];
  const partial: DocumentPackageSummary["partial"] = [];
  const unsupported: DocumentPackageSummary["unsupported"] = [];
  const missingInformation = new Set<string>();
  const notes: string[] = [];

  for (const document of documents) {
    const { analysis } = document;
    formatCounts.set(analysis.format, (formatCounts.get(analysis.format) ?? 0) + 1);
    pagesProcessed += analysis.pageCount ?? analysis.pages?.length ?? 0;
    worksheetsProcessed += Number(analysis.metadata?.worksheets ?? 0);
    slidesProcessed += Number(analysis.metadata?.slides ?? 0);
    ocrPages += analysis.pages?.filter((page) => page.ocr).length ?? 0;
    visionPages += analysis.images?.length ?? 0;
    tablesExtracted += analysis.tables?.length ?? 0;
    tableRows += analysis.tables?.reduce((sum, table) => sum + table.rows.length, 0) ?? 0;

    if (analysis.processingStatus === "UNSUPPORTED") {
      unsupported.push({
        attachmentId: document.attachmentId,
        filename: document.filename,
        reason: analysis.note ?? "This format is not supported.",
      });
      missingInformation.add(`${document.filename}: unsupported format`);
      continue;
    }
    if (analysis.processingStatus === "FAILED") {
      failures.push({
        attachmentId: document.attachmentId,
        filename: document.filename,
        reason: analysis.note ?? "The file could not be read.",
      });
      missingInformation.add(`${document.filename}: unreadable`);
      continue;
    }
    if (["PARTIAL", "NEEDS_REVIEW", "PASSWORD_PROTECTED"].includes(analysis.processingStatus)) {
      partial.push({
        attachmentId: document.attachmentId,
        filename: document.filename,
        reason: analysis.note ?? "Part of this file needs review.",
      });
    }
    for (const issue of analysis.quality.issues) {
      if (issue.severity !== "INFO") missingInformation.add(`${document.filename}: ${issue.message}`);
    }
    if (!analysis.text.trim() && (analysis.images?.length ?? 0) > 0) {
      notes.push(`${document.filename}: pages are kept as images for visual reading; no text was assumed.`);
    }
  }

  const supportedCount = documents.filter((entry) => entry.analysis.detection.info.supported).length;
  const readableCount = documents.filter(
    (entry) =>
      entry.analysis.text.trim().length > 0 &&
      !["FAILED", "UNSUPPORTED", "PASSWORD_PROTECTED"].includes(entry.analysis.processingStatus),
  ).length;
  const passwordProtected = documents.some(
    (entry) => entry.analysis.processingStatus === "PASSWORD_PROTECTED",
  );

  let status: DocumentPackageSummary["status"];
  if (documents.length === 0) status = "COMPLETED";
  else if (readableCount === 0 && passwordProtected) status = "PASSWORD_PROTECTED";
  else if (readableCount === 0 && unsupported.length === documents.length) status = "UNSUPPORTED";
  else if (readableCount === 0) status = "FAILED";
  else if (partial.length > 0 || failures.length > 0 || unsupported.length > 0) status = "PARTIAL";
  else status = "COMPLETED";

  if (duplicates.length > 0) {
    notes.push(`${duplicates.length} duplicate attachment(s) were detected by content hash and read once.`);
  }

  return {
    version: "2026-11-25.document-intelligence.1",
    status,
    attachmentCount: documents.length + duplicates.length,
    supportedCount,
    unsupportedCount: unsupported.length,
    partialCount: partial.length,
    failedCount: failures.length,
    formats: [...formatCounts.entries()]
      .map(([format, count]) => ({ format, count }))
      .sort((a, b) => b.count - a.count),
    pagesProcessed,
    worksheetsProcessed,
    slidesProcessed,
    ocrPages,
    visionPages,
    tablesExtracted,
    tableRows,
    missingInformation: [...missingInformation].slice(0, 30),
    failures,
    partial,
    unsupported,
    duplicates,
    notes: [...new Set(notes)].slice(0, 20),
    processedAt: new Date().toISOString(),
  };
}

/** Exported for tests and for the review UI. */
export type { ExtractedTable };
