import { db } from "../db";
import { stringifyJson, parseJson } from "../json";
import { readAttachment } from "../storage";
import { requireTenantId } from "../tenant";
import { writeAudit } from "../audit";
import {
  DOCUMENT_FORMATS,
  type DocumentFormatId,
  type FormatDetection,
} from "./formats";
import {
  analyzeDocument,
  friendlyDocumentError,
  summarizeDocumentPackage,
  type AnalyzedDocument,
  type DocumentPackageSummary,
  type DocumentQuality,
  type DocumentProcessingStage,
  type DocumentProcessingStatus,
} from "./documentIntelligence";
import type { ExtractedTable } from "./documents-core";

export type { DocumentPackageSummary } from "./documentIntelligence";

/**
 * Persists the unified document-processing result and the package-level review
 * summary. A single unreadable attachment never prevents the other attachments
 * from being processed or the original files from being retained.
 */

export const DOCUMENT_PARSER_VERSION = "2026-11-25.document-intelligence.1";

export type PackageAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  sha256: string;
  sizeBytes?: number;
};

export type ProcessDocumentPackageInput = {
  key: string;
  enquiryId?: string | null;
  messageId?: string | null;
  supplierReplyId?: string | null;
  attachments?: PackageAttachment[];
  /** Explicit owner request: re-read files even when a prior result exists. */
  force?: boolean;
};

export type ProcessedPackageDocument = {
  attachmentId: string;
  filename: string;
  analysis: AnalyzedDocument;
};

export type ProcessDocumentPackageResult = {
  packageId: string;
  summary: DocumentPackageSummary;
  documents: ProcessedPackageDocument[];
};

function detectionFromStored(
  format: DocumentFormatId,
  metadata: Record<string, unknown>,
): FormatDetection {
  const info = DOCUMENT_FORMATS[format] ?? DOCUMENT_FORMATS.UNKNOWN;
  return {
    format: info.id,
    info,
    mime: info.mime,
    extension: typeof metadata.extension === "string" ? metadata.extension : "",
    extensionMismatch: metadata.extensionMismatch === true,
    declaredMimeMismatch: metadata.declaredMimeMismatch === true,
    encrypted: metadata.encrypted === true,
    note: typeof metadata.detectionNote === "string" ? metadata.detectionNote : null,
  };
}

function storedAnalysis(attachment: {
  id: string;
  filename: string;
  detectedFormat: string | null;
  detectedMime: string | null;
  textExtract: string | null;
  pageCount: number | null;
  extractionStatus: string;
  extractionNote: string | null;
  processingStatus: string;
  processingStage: string | null;
  qualityJson: string | null;
  tablesJson: string | null;
  metadataJson: string | null;
}): AnalyzedDocument | null {
  if (!attachment.textExtract && !attachment.tablesJson && !attachment.qualityJson) return null;
  const format = (attachment.detectedFormat ?? "UNKNOWN") as DocumentFormatId;
  const metadata = parseJson<Record<string, unknown>>(attachment.metadataJson ?? "{}", {});
  const detection = detectionFromStored(format, metadata);
  const quality = parseJson<DocumentQuality>(attachment.qualityJson ?? "null", {
    status: "FAILED",
    score: 0,
    textDensity: null,
    issues: [],
    pages: [],
    tables: 0,
    tableRows: 0,
  });
  const tables = parseJson<ExtractedTable[]>(attachment.tablesJson ?? "[]", []);
  const status = attachment.extractionStatus as AnalyzedDocument["status"];
  return {
    text: attachment.textExtract ?? "",
    pageCount: attachment.pageCount,
    status,
    note: attachment.extractionNote,
    unreadable: status === "FAILED" || attachment.processingStatus === "NEEDS_REVIEW",
    format,
    detectedMime: attachment.detectedMime ?? detection.mime,
    encrypted: attachment.processingStatus === "PASSWORD_PROTECTED",
    tables,
    metadata: metadata as AnalyzedDocument["metadata"],
    quality,
    detection,
    processingStatus: attachment.processingStatus as DocumentProcessingStatus,
    processingStage: (attachment.processingStage ?? "VALIDATED") as DocumentProcessingStage,
  };
}

function failedAnalysis(filename: string, message: string): AnalyzedDocument {
  const info = DOCUMENT_FORMATS.UNKNOWN;
  return {
    text: "",
    pageCount: null,
    status: "FAILED",
    note: message,
    unreadable: true,
    format: "UNKNOWN",
    detectedMime: info.mime,
    quality: {
      status: "FAILED",
      score: 0,
      textDensity: null,
      issues: [{ code: "PARSER_CAVEAT", severity: "ERROR", message }],
      pages: [],
      tables: 0,
      tableRows: 0,
    },
    detection: {
      format: "UNKNOWN",
      info,
      mime: info.mime,
      extension: "",
      extensionMismatch: false,
      declaredMimeMismatch: false,
      encrypted: false,
      note: message,
    },
    processingStatus: "FAILED",
    processingStage: "VALIDATED",
  };
}

async function ensurePackage(input: ProcessDocumentPackageInput): Promise<{ id: string }> {
  const organizationId = await requireTenantId();
  const existing = await db.documentPackage.findFirst({ where: { key: input.key } });
  if (existing) {
    return db.documentPackage.update({
      where: { id: existing.id },
      data: {
        enquiryId: input.enquiryId ?? existing.enquiryId,
        messageId: input.messageId ?? existing.messageId,
        supplierReplyId: input.supplierReplyId ?? existing.supplierReplyId,
      },
      select: { id: true },
    });
  }
  try {
    return await db.documentPackage.create({
      data: {
        organizationId,
        key: input.key,
        enquiryId: input.enquiryId ?? null,
        messageId: input.messageId ?? null,
        supplierReplyId: input.supplierReplyId ?? null,
        status: "PROCESSING",
      },
      select: { id: true },
    });
  } catch (error) {
    // A concurrent intake can create the same package key. Resolve the winner.
    if ((error as { code?: string } | null)?.code !== "P2002") throw error;
    return db.documentPackage.findFirstOrThrow({ where: { key: input.key }, select: { id: true } });
  }
}

async function attachmentsFor(input: ProcessDocumentPackageInput): Promise<PackageAttachment[]> {
  if (input.attachments) return input.attachments;
  const where = input.enquiryId
    ? { enquiryId: input.enquiryId }
    : input.supplierReplyId
      ? { supplierReplyId: input.supplierReplyId }
      : input.messageId
        ? { messageId: input.messageId }
        : null;
  if (!where) return [];
  const rows = await db.attachment.findMany({
    where,
    select: {
      id: true,
      filename: true,
      mimeType: true,
      storagePath: true,
      sha256: true,
      sizeBytes: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

/**
 * Processes every attachment in one related document package.
 *
 * Content hashes identify duplicates within the package; duplicate files are
 * retained but read once. Each attachment is isolated in its own try/catch so a
 * corrupt PDF cannot hide a spreadsheet or image beside it.
 */
export async function processDocumentPackage(
  input: ProcessDocumentPackageInput,
): Promise<ProcessDocumentPackageResult> {
  const pkg = await ensurePackage(input);
  const attachments = await attachmentsFor(input);
  if (attachments.length > 0) {
    await db.attachment.updateMany({
      where: { id: { in: attachments.map((attachment) => attachment.id) } },
      data: { packageId: pkg.id },
    });
  }

  const documents: ProcessedPackageDocument[] = [];
  const duplicates: Array<{ attachmentId: string; filename: string; duplicateOf: string }> = [];
  const seenHashes = new Map<string, string>();

  for (const attachment of attachments) {
    const hash = attachment.sha256 || attachment.id;
    const duplicateOf = seenHashes.get(hash);
    if (duplicateOf) {
      duplicates.push({ attachmentId: attachment.id, filename: attachment.filename, duplicateOf });
      await db.attachment.update({
        where: { id: attachment.id },
        data: {
          packageId: pkg.id,
          processingStatus: "COMPLETED",
          processingStage: "VALIDATED",
          failureCode: null,
          failureMessage: null,
          metadataJson: stringifyJson({ duplicateOf, duplicate: true }),
        },
      });
      continue;
    }
    seenHashes.set(hash, attachment.id);

    const existing = await db.attachment.findUnique({
      where: { id: attachment.id },
      select: {
        id: true,
        filename: true,
        detectedFormat: true,
        detectedMime: true,
        textExtract: true,
        pageCount: true,
        extractionStatus: true,
        extractionNote: true,
        processingStatus: true,
        processingStage: true,
        qualityJson: true,
        tablesJson: true,
        metadataJson: true,
        parserVersion: true,
      },
    });
    const cached =
      existing && !input.force && existing.parserVersion === DOCUMENT_PARSER_VERSION
        ? storedAnalysis(existing)
        : null;

    let analysis: AnalyzedDocument;
    if (cached) {
      analysis = cached;
    } else {
      try {
        const buffer = await readAttachment(attachment.storagePath);
        analysis = await analyzeDocument(buffer, attachment.filename, {
          declaredMime: attachment.mimeType,
        });
      } catch (error) {
        const safe = friendlyDocumentError(error);
        analysis = failedAnalysis(attachment.filename, safe.message);
        console.error("[document-processing]", {
          traceId: pkg.id,
          attachmentId: attachment.id,
          filename: attachment.filename,
          stage: "storage-read",
          code: safe.code,
        });
      }
    }

    documents.push({ attachmentId: attachment.id, filename: attachment.filename, analysis });

    const failureStatus = ["FAILED", "UNSUPPORTED", "PASSWORD_PROTECTED"].includes(
      analysis.processingStatus,
    );
    try {
      await db.attachment.update({
        where: { id: attachment.id },
        data: {
          packageId: pkg.id,
          detectedMime: analysis.detectedMime ?? attachment.mimeType,
          detectedFormat: analysis.format,
          textExtract: analysis.text.slice(0, 80_000),
          pageCount: analysis.pageCount,
          extractionStatus: analysis.status,
          extractionNote: analysis.note,
          processingStatus: analysis.processingStatus,
          processingStage: analysis.processingStage,
          qualityJson: stringifyJson(analysis.quality),
          tablesJson: stringifyJson(analysis.tables ?? []),
          metadataJson: stringifyJson({
            ...(analysis.metadata ?? {}),
            extension: analysis.detection.extension,
            extensionMismatch: analysis.detection.extensionMismatch,
            declaredMimeMismatch: analysis.detection.declaredMimeMismatch,
            encrypted: analysis.detection.encrypted,
            detectionNote: analysis.detection.note,
          }),
          parserVersion: DOCUMENT_PARSER_VERSION,
          processedAt: new Date(),
          failureCode: failureStatus
            ? analysis.processingStatus === "UNSUPPORTED"
              ? "UNSUPPORTED_FORMAT"
              : analysis.processingStatus === "PASSWORD_PROTECTED"
                ? "PASSWORD_PROTECTED"
                : "EXTRACTION_FAILED"
            : null,
          failureMessage: failureStatus
            ? analysis.note?.slice(0, 300) ?? "The file could not be read."
            : null,
        },
      });
    } catch (error) {
      // The original attachment must never disappear because its derived state
      // could not be written. Keep going with the rest of the package.
      console.error("[document-processing] failed to persist attachment state", {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }

  const summary = summarizeDocumentPackage(documents, duplicates);
  await db.documentPackage.update({
    where: { id: pkg.id },
    data: {
      status: summary.status,
      summaryJson: stringifyJson(summary),
    },
  });

  await writeAudit({
    action: "documents.processed",
    entityType: "DocumentPackage",
    entityId: pkg.id,
    actorLabel: "system",
    meta: {
      attachments: summary.attachmentCount,
      completed: documents.filter((document) => document.analysis.processingStatus === "COMPLETED").length,
      partial: summary.partialCount,
      failed: summary.failedCount,
      unsupported: summary.unsupportedCount,
      tables: summary.tablesExtracted,
      ocrPages: summary.ocrPages,
      visionPages: summary.visionPages,
    },
  }).catch(() => undefined);

  return { packageId: pkg.id, summary, documents };
}
