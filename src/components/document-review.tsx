import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { parseJson } from "@/lib/json";
import { DOCUMENT_FORMATS, type DocumentFormatId } from "@/lib/intake/formats";
import type { DocumentPackageSummary, DocumentQuality } from "@/lib/intake/documentIntelligence";
import type { ExtractedTable } from "@/lib/intake/documents-core";
import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";

export type ReviewAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  detectedFormat: string | null;
  processingStatus: string;
  extractionStatus: string;
  extractionNote: string | null;
  qualityJson: string | null;
  tablesJson: string | null;
  textExtract: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  PROCESSING: "Reading",
  COMPLETED: "Read",
  PARTIAL: "Partly read",
  NEEDS_REVIEW: "Needs review",
  FAILED: "Could not read",
  UNSUPPORTED: "Unsupported",
  PASSWORD_PROTECTED: "Password-protected",
};

function statusTone(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "COMPLETED") return "ok";
  if (["PARTIAL", "NEEDS_REVIEW", "PASSWORD_PROTECTED", "RECEIVED", "PROCESSING"].includes(status)) return "warn";
  if (["FAILED", "UNSUPPORTED"].includes(status)) return "danger";
  return "neutral";
}

function safeNote(note: string | null): string | null {
  if (!note) return null;
  if (/\n\s+at\s+\w|Cannot read properties|Unexpected token|ExcelJS|stack/i.test(note)) {
    return "The file could not be read automatically. The original is stored; compare it manually or retry.";
  }
  return note.slice(0, 600);
}

function formatLabel(format: string | null, mime: string): string {
  if (format && format in DOCUMENT_FORMATS) return DOCUMENT_FORMATS[format as DocumentFormatId].label;
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("image")) return "Image";
  if (mime.includes("sheet") || mime.includes("csv")) return "Spreadsheet";
  return "Document";
}

function qualityFor(attachment: ReviewAttachment): DocumentQuality | null {
  return parseJson<DocumentQuality | null>(attachment.qualityJson ?? "null", null);
}

function tablesFor(attachment: ReviewAttachment): ExtractedTable[] {
  return parseJson<ExtractedTable[]>(attachment.tablesJson ?? "[]", []);
}

export function DocumentReviewCard({
  attachments,
  summary,
  productCount,
  action,
  pageFlagAction,
  idField,
  idValue,
  title = "Documents received",
}: {
  attachments: ReviewAttachment[];
  summary: DocumentPackageSummary | null;
  productCount?: number;
  action?: (formData: FormData) => void | Promise<void>;
  pageFlagAction?: (formData: FormData) => void | Promise<void>;
  idField?: "enquiryId" | "replyId";
  idValue?: string;
  title?: string;
}) {
  if (attachments.length === 0) return null;
  const issues = summary?.missingInformation ?? [];
  const tables = summary?.tablesExtracted ?? attachments.reduce((sum, attachment) => sum + tablesFor(attachment).length, 0);

  return (
    <Card>
      <CardHeader
        title={title}
        description="Every original file is kept. Reading failures are shown here; they are not hidden."
        action={
          summary ? (
            <Badge tone={statusTone(summary.status)}>{STATUS_LABELS[summary.status] ?? summary.status}</Badge>
          ) : null
        }
      />
      <div className="space-y-3 px-4 py-3">
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          {[
            ["Files", String(summary?.attachmentCount ?? attachments.length)],
            ["Formats", summary?.formats.map((entry) => `${entry.format}×${entry.count}`).join(", ") || "detecting"],
            ["Pages / slides", String((summary?.pagesProcessed ?? 0) + (summary?.slidesProcessed ?? 0))],
            ["Worksheets", String(summary?.worksheetsProcessed ?? 0)],
            ["OCR pages", String(summary?.ocrPages ?? 0)],
            ["Vision-ready pages", String(summary?.visionPages ?? 0)],
            ["Tables", `${tables}${summary?.tableRows ? ` · ${summary.tableRows} rows` : ""}`],
            ["Products", productCount != null ? String(productCount) : "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-control border border-line px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
              <p className="truncate text-xs text-ink">{value}</p>
            </div>
          ))}
        </div>

        {summary && (summary.failedCount > 0 || summary.partialCount > 0 || summary.unsupportedCount > 0) ? (
          <div className="rounded-control border border-warn/40 bg-warn/5 px-2 py-1.5 text-[11px] text-soft">
            {summary.failedCount > 0
              ? `${summary.failedCount} file(s) could not be read. `
              : ""}
            {summary.partialCount > 0 ? `${summary.partialCount} file(s) were only partly read. ` : ""}
            {summary.unsupportedCount > 0 ? `${summary.unsupportedCount} file(s) are unsupported. ` : ""}
            The original files are still attached.
          </div>
        ) : null}

        {issues.length > 0 ? (
          <details className="rounded-control border border-line px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] font-medium text-soft">
              Missing information and caveats ({issues.length})
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted">
              {issues.slice(0, 12).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="space-y-2">
          {attachments.map((attachment) => {
            const quality = qualityFor(attachment);
            const attachmentTables = tablesFor(attachment);
            const note = safeNote(attachment.extractionNote);
            return (
              <div key={attachment.id} className="rounded-card border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  {attachment.mimeType.startsWith("image/") ? (
                    <ImageIcon size={14} className="text-muted" aria-hidden />
                  ) : (
                    <FileText size={14} className="text-muted" aria-hidden />
                  )}
                  <a
                    href={`/api/files/${attachment.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-xs text-accent hover:underline"
                  >
                    {attachment.filename}
                  </a>
                  <Badge tone={statusTone(attachment.processingStatus)}>
                    {STATUS_LABELS[attachment.processingStatus] ?? attachment.processingStatus}
                  </Badge>
                </div>
                <p className="mt-1 text-[10px] text-muted">
                  {formatLabel(attachment.detectedFormat, attachment.mimeType)} ·{" "}
                  {Math.round(attachment.sizeBytes / 1024)} KB
                  {attachment.pageCount ? ` · ${attachment.pageCount} page(s)` : ""}
                  {quality?.tables ? ` · ${quality.tables} table(s)` : ""}
                  {quality ? ` · quality ${quality.score}%` : ""}
                </p>
                {note ? <p className="mt-1 text-[11px] text-soft">{note}</p> : null}
                {quality?.pages.some((page) => page.status !== "READABLE") ? (
                  <p className="mt-1 text-[10px] text-warn">
                    Pages needing a visual check:{" "}
                    {quality.pages
                      .filter((page) => page.status !== "READABLE")
                      .map((page) => page.page)
                      .slice(0, 12)
                      .join(", ")}
                  </p>
                ) : null}
                {quality?.issues.length ? (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-muted">
                    {quality.issues
                      .filter((issue) => issue.severity !== "INFO")
                      .slice(0, 4)
                      .map((issue) => (
                        <li key={`${attachment.id}-${issue.code}-${issue.page ?? ""}`}>{issue.message}</li>
                      ))}
                  </ul>
                ) : null}

                {attachment.textExtract ? (
                  <details className="mt-2 rounded-control border border-line px-2 py-1">
                    <summary className="cursor-pointer text-[11px] font-medium text-soft">View extracted text</summary>
                    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted">
                      {attachment.textExtract.slice(0, 12_000)}
                    </pre>
                  </details>
                ) : null}

                {attachmentTables.length > 0 ? (
                  <details className="mt-2 rounded-control border border-line px-2 py-1">
                    <summary className="cursor-pointer text-[11px] font-medium text-soft">
                      View extracted tables ({attachmentTables.length})
                    </summary>
                    <div className="mt-1 space-y-2">
                      {attachmentTables.slice(0, 4).map((table) => (
                        <div key={table.id} className="overflow-auto rounded border border-line">
                          <p className="bg-elevated/60 px-2 py-1 text-[10px] text-muted">
                            {table.sheet ? `Sheet ${table.sheet}` : table.slide ? `Slide ${table.slide}` : "Table"}
                            {table.page ? ` · page ${table.page}` : ""} · {table.rows.length} row(s)
                          </p>
                          <table className="min-w-full text-left text-[10px]">
                            {table.header.length > 0 ? (
                              <thead className="bg-elevated/40 text-soft">
                                <tr>
                                  {table.header.map((heading, index) => (
                                    <th key={`${table.id}-h-${index}`} className="whitespace-nowrap px-2 py-1 font-medium">
                                      {heading || "—"}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                            ) : null}
                            <tbody>
                              {table.rows.slice(0, 6).map((row) => (
                                <tr key={`${table.id}-r-${row.rowNumber}`} className="border-t border-line">
                                  {row.cells.map((cell, index) => (
                                    <td key={`${table.id}-r-${row.rowNumber}-${index}`} className="whitespace-nowrap px-2 py-1 text-muted">
                                      {cell || "—"}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {pageFlagAction ? (
                  <form action={pageFlagAction} className="mt-2 flex flex-wrap items-end gap-1.5">
                    <input type="hidden" name="attachmentId" value={attachment.id} />
                    {idField && idValue ? <input type="hidden" name={idField} value={idValue} /> : null}
                    <label className="text-[10px] text-muted">
                      Page unreadable
                      <input
                        name="page"
                        type="number"
                        min={1}
                        max={10000}
                        placeholder="No."
                        className="ml-1 h-7 w-16 rounded-control border border-line bg-surface px-1.5 text-[11px] text-ink"
                      />
                    </label>
                    <Button size="sm" variant="ghost">
                      Flag page
                    </Button>
                  </form>
                ) : null}

                {action && idField && idValue ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <form action={action}>
                      <input type="hidden" name={idField} value={idValue} />
                      <input type="hidden" name="mode" value="retry" />
                      <Button size="sm" variant="ghost">
                        Retry this file
                      </Button>
                    </form>
                    <form action={action}>
                      <input type="hidden" name={idField} value={idValue} />
                      <input type="hidden" name="mode" value="vision" />
                      <Button size="sm" variant="ghost">
                        Re-read with vision
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {summary?.duplicates.length ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <Paperclip size={12} aria-hidden /> {summary.duplicates.length} duplicate file(s) were read once and kept.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
