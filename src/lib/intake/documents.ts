export * from "./documents-core";
export {
  analyzeDocument,
  friendlyDocumentError,
  summarizeDocumentPackage,
  type AnalyzedDocument,
  type AnalyzeDocumentOptions,
  type DocumentPackageSummary,
  type DocumentProcessingStage,
  type DocumentProcessingStatus,
  type DocumentQuality,
  type DocumentQualityIssue,
  type DocumentPageQuality,
} from "./documentIntelligence";

import { analyzeDocument } from "./documentIntelligence";
import type { DocumentText } from "./documents-core";

/**
 * Public document entry point used by intake, supplier replies and research.
 *
 * The low-level parsers live in documents-core.ts and are unchanged in
 * behaviour. This wrapper adds content-first detection, quality assessment and
 * a persisted processing state around each of them.
 */
export async function extractDocument(buffer: Buffer, filename: string): Promise<DocumentText> {
  // The richer AnalyzedDocument is structurally a DocumentText. Keeping this
  // return type stable means existing callers and test doubles do not need to
  // know about quality internals; documentPackage.ts uses analyzeDocument when
  // it needs the extra fields.
  return analyzeDocument(buffer, filename);
}
