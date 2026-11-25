import { env } from "../env";
import { loadExcelWorkbook } from "../exceljs";
import {
  detectDocumentFormat,
  unsupportedFormatNote,
  type DocumentFormatId,
} from "./formats";

export type ExtractedTable = {
  id: string;
  source: string;
  page: number | null;
  sheet: string | null;
  slide: number | null;
  header: string[];
  rows: Array<{ rowNumber: number; cells: string[]; merged?: boolean }>;
  units: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

export type DocumentText = {
  text: string;
  pageCount: number | null;
  status: "TEXT_OK" | "OCR_USED" | "NEEDS_REVIEW" | "FAILED";
  note: string | null;
  unreadable: boolean;
  /** Per-page text, so extraction can cite "page 3". */
  pages?: Array<{ page: number; text: string; ocr: boolean }>;
  languages?: string;
  ocrUsed?: boolean;
  /**
   * Rendered pages or the photo itself, as data URLs, for the vision model.
   * Built on demand and never written to the database or logs.
   */
  images?: string[];
  /** Content-first format detection; never derived from the filename alone. */
  format?: DocumentFormatId;
  detectedMime?: string;
  extensionMismatch?: boolean;
  declaredMimeMismatch?: boolean;
  encrypted?: boolean;
  /** Structured tables preserve page/sheet/slide and row provenance. */
  tables?: ExtractedTable[];
  metadata?: Record<string, string | number | boolean | null>;
};

const MIN_MEANINGFUL_CHARS = 25;
const MIN_CHARS_PER_PAGE = 20;
const MAX_PDF_PAGES = 300;
const MAX_XLSX_SHEETS = 50;
const MAX_XLSX_ROWS = 5_000;
const MAX_XLSX_CELLS = 200_000;

/** OCR languages that are actually loaded, e.g. "eng" or "eng+ara". */
function ocrLanguages(): string {
  return (env.OCR_LANGUAGES || "eng")
    .split(/[+,\s]+/)
    .map((lang) => lang.trim())
    .filter(Boolean)
    .join("+") || "eng";
}

function ocrEnabled(): boolean {
  return env.OCR_PROVIDER !== "none";
}

function ocrOptions(): { langPath?: string } {
  return env.OCR_LANG_PATH ? { langPath: env.OCR_LANG_PATH } : {};
}

/** Pages/photos handed to the vision model per document. */
const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 1_500_000;

/**
 * Re-encodes a page render or a photo as a JPEG data URL for the vision model.
 * Downscaling keeps the request small. When sharp is unavailable the original
 * bytes are used only if they are already a web-safe image under the cap.
 */
async function toVisionImage(buffer: Buffer, mime = "image/jpeg"): Promise<string | null> {
  try {
    const sharpModule = (await import("sharp")) as unknown as {
      default?: (input: Buffer, options?: Record<string, unknown>) => {
        rotate: () => {
          resize: (options: Record<string, unknown>) => {
            jpeg: (options: Record<string, unknown>) => { toBuffer: () => Promise<Buffer> };
          };
        };
      };
    };
    const sharp = sharpModule.default;
    if (sharp) {
      const jpeg = await sharp(buffer, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true, fit: "inside" })
        .jpeg({ quality: 82 })
        .toBuffer();
      if (jpeg.length > 0 && jpeg.length <= MAX_VISION_IMAGE_BYTES) {
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      }
      return null;
    }
  } catch {
    // Fall through to the original bytes.
  }
  if (buffer.length <= MAX_VISION_IMAGE_BYTES && /^image\/(jpeg|png|webp)$/.test(mime)) {
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }
  return null;
}

/**
 * Normalizes phone photos, scans, TIFF faxes and GIF frames before OCR:
 * orientation is applied, a high-resolution page is kept, and contrast is
 * improved without replacing the original bytes.
 */
async function prepareImageForOcr(buffer: Buffer): Promise<{ buffer: Buffer; note: string | null; width: number | null; height: number | null }> {
  try {
    const sharpModule = (await import("sharp")) as unknown as {
      default?: (input: Buffer, options?: Record<string, unknown>) => {
        metadata: () => Promise<{ width?: number; height?: number; pages?: number; format?: string }>;
        rotate: () => {
          resize: (options: Record<string, unknown>) => {
            grayscale: () => {
              normalize: () => {
                png: () => { toBuffer: () => Promise<Buffer> };
              };
            };
          };
        };
      };
    };
    const sharp = sharpModule.default;
    if (!sharp) return { buffer, note: null, width: null, height: null };
    const image = sharp(buffer, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const png = await image
      .rotate()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    return {
      buffer: png,
      note: metadata.pages && metadata.pages > 1 ? `Only the first frame of this ${metadata.pages}-frame image was read.` : null,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    };
  } catch {
    return { buffer, note: null, width: null, height: null };
  }
}

async function loadPdfParse() {
  const mod = (await import("pdf-parse")) as unknown as {
    default?: (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
  };
  return mod.default ?? (mod as unknown as (buffer: Buffer) => Promise<{ text: string; numpages: number }>);
}

type MupdfTasks = {
  loadPDF: (data: Uint8Array) => { countPages: () => number };
  getPageText: (document: unknown, pageNumber: number) => string;
  drawPageAsPNG: (document: unknown, pageNumber: number, dpi: number) => Uint8Array;
};

/**
 * Reads a PDF with MuPDF: text per page first, then OCR of the rendered page
 * when the document has no text layer (a scan or a photo saved as PDF).
 *
 * Page numbers survive, so an extracted line can cite "page 2" even when OCR
 * was required.
 */
export async function extractPdf(buffer: Buffer): Promise<DocumentText> {
  const detection = detectDocumentFormat(buffer, "document.pdf");
  if (detection.encrypted) {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: "This PDF is password-protected. Nothing was guessed. Ask the sender for an unlocked copy, or unlock it and upload it again.",
      unreadable: true,
      encrypted: true,
    };
  }

  let tasks: MupdfTasks | null = null;
  try {
    tasks = (await import("mupdf/tasks")) as unknown as MupdfTasks;
  } catch {
    tasks = null;
  }

  if (tasks) {
    try {
      const document = tasks.loadPDF(new Uint8Array(buffer));
      const declaredPageCount = document.countPages();
      const pageCount = Math.min(declaredPageCount, MAX_PDF_PAGES);
      const pageCapNote =
        declaredPageCount > pageCount
          ? ` Only the first ${pageCount} of ${declaredPageCount} pages were read; the remaining pages are kept in the original file and need review.`
          : "";
      const textPages: Array<{ page: number; text: string }> = [];
      // MuPDF page indexes are zero-based. Passing a 1-based number silently
      // skipped page 1 and shifted every page reference, so the index is
      // converted explicitly and the human page number is kept for citations.
      for (let index = 0; index < pageCount; index += 1) {
        const page = index + 1;
        let pageText = "";
        try {
          pageText = (tasks.getPageText(document, index) ?? "").replace(/\u0000/g, "").trim();
        } catch {
          pageText = "";
        }
        textPages.push({ page, text: pageText });
      }

      const totalTextLength = textPages.reduce((sum, page) => sum + page.text.length, 0);
      const meaningful = totalTextLength >= MIN_MEANINGFUL_CHARS && totalTextLength / pageCount >= MIN_CHARS_PER_PAGE;
      const lowTextPages = textPages.filter((page) => page.text.length < MIN_CHARS_PER_PAGE);

      if (meaningful && lowTextPages.length === 0) {
        return {
          text: textPages.map((page) => `[page ${page.page}]\n${page.text}`).join("\n\n"),
          pageCount,
          status: "TEXT_OK",
          note: pageCapNote.trim() || null,
          unreadable: false,
          pages: textPages.map((page) => ({ page: page.page, text: page.text, ocr: false })),
          metadata: { skippedPages: declaredPageCount - pageCount },
        };
      }

      // Mixed digital/scanned PDFs are common. Do not OCR a whole readable
      // document, and do not silently leave a scanned page empty: escalate only
      // the low-text pages, within the configured page cap.
      if (meaningful && lowTextPages.length > 0) {
        const languages = ocrLanguages();
        const workingPages = textPages.map((page) => ({ page: page.page, text: page.text, ocr: false }));
        const visionImages: string[] = [];
        let ocrUsed = false;
        let ocrAttempts = 0;

        if (ocrEnabled()) {
          const Tesseract = (await import("tesseract.js")).default;
          const limit = Math.min(lowTextPages.length, Math.max(1, env.OCR_PDF_MAX_PAGES));
          for (const lowPage of lowTextPages.slice(0, limit)) {
            try {
              const png = tasks.drawPageAsPNG(document, lowPage.page - 1, 200);
              if (visionImages.length < MAX_VISION_IMAGES) {
                const image = await toVisionImage(Buffer.from(png));
                if (image) visionImages.push(image);
              }
              const result = await Tesseract.recognize(Buffer.from(png), languages, ocrOptions());
              const ocrText = (result.data.text ?? "").trim();
              ocrAttempts += 1;
              if (ocrText.length > 10) {
                const target = workingPages.find((page) => page.page === lowPage.page);
                if (target) {
                  target.text = ocrText;
                  target.ocr = true;
                }
                ocrUsed = true;
              }
            } catch {
              // The digital pages remain usable; this page is reported below.
            }
          }
        } else if (env.AI_VISION_MODEL.trim()) {
          for (const lowPage of lowTextPages.slice(0, MAX_VISION_IMAGES)) {
            try {
              const png = tasks.drawPageAsPNG(document, lowPage.page - 1, 200);
              const image = await toVisionImage(Buffer.from(png));
              if (image) visionImages.push(image);
            } catch {
              // Leave the page for manual review.
            }
          }
        }

        const stillLow = workingPages.filter((page) => page.text.trim().length < MIN_CHARS_PER_PAGE);
        const noteParts = [
          ocrUsed
            ? `This PDF mixes digital and scanned pages. ${ocrAttempts} low-text page(s) were read with OCR (${languages}); check those pages against the original.`
            : stillLow.length > 0
              ? `This PDF mixes digital and scanned pages. Page(s) ${stillLow.map((page) => page.page).join(", ")} have little or no readable text and need a visual check.`
              : null,
          pageCapNote.trim() || null,
        ].filter(Boolean);

        return {
          text: workingPages.map((page) => `[page ${page.page}]\n${page.text}`).join("\n\n"),
          pageCount,
          status: ocrUsed ? "OCR_USED" : "NEEDS_REVIEW",
          note: noteParts.join(" ") || null,
          unreadable: workingPages.every((page) => page.text.trim().length < 10),
          pages: workingPages,
          languages: ocrUsed ? languages : undefined,
          ocrUsed,
          images: visionImages.length > 0 ? visionImages : undefined,
          metadata: {
            skippedPages: declaredPageCount - pageCount,
            lowTextPages: stillLow.map((page) => page.page).join(", ") || null,
          },
        };
      }

      if (!ocrEnabled()) {
        // If a vision model is configured, send the rendered pages to it rather
        // than rejecting a valid scan because local OCR is off.
        const visionImages: string[] = [];
        if (env.AI_VISION_MODEL.trim()) {
          const limit = Math.min(pageCount, MAX_VISION_IMAGES);
          for (let index = 0; index < limit; index += 1) {
            try {
              const png = tasks.drawPageAsPNG(document, index, 200);
              const image = await toVisionImage(Buffer.from(png));
              if (image) visionImages.push(image);
            } catch {
              // Leave unrendered pages to the text path.
            }
          }
        }
        return {
          text: textPages.map((page) => page.text).join("\n").trim(),
          pageCount,
          status: "NEEDS_REVIEW",
          note: `${visionImages.length > 0
            ? "This PDF has no text layer. The page images were sent to the AI to read."
            : "This PDF has no readable text layer (it is a scan or a photo). Photo and scan reading is turned off, so nothing was assumed. Turn on OCR in Settings or enter the items manually."}${pageCapNote}`,
          unreadable: visionImages.length === 0,
          pages: textPages.map((page) => ({ page: page.page, text: page.text, ocr: false })),
          images: visionImages.length > 0 ? visionImages : undefined,
          metadata: { skippedPages: declaredPageCount - pageCount },
        };
      }

      const languages = ocrLanguages();
      const Tesseract = (await import("tesseract.js")).default;
      const ocrPages: Array<{ page: number; text: string; ocr: boolean }> = [];
      const limit = Math.min(pageCount, Math.max(1, env.OCR_PDF_MAX_PAGES));
      const visionImages: string[] = [];

      for (const page of textPages.slice(0, limit)) {
        try {
          const png = tasks.drawPageAsPNG(document, page.page - 1, 200);
          if (visionImages.length < MAX_VISION_IMAGES) {
            const image = await toVisionImage(Buffer.from(png));
            if (image) visionImages.push(image);
          }
          const result = await Tesseract.recognize(Buffer.from(png), languages, ocrOptions());
          ocrPages.push({ page: page.page, text: (result.data.text ?? "").trim(), ocr: true });
        } catch (error) {
          ocrPages.push({
            page: page.page,
            text: page.text,
            ocr: false,
          });
          ocrPages[ocrPages.length - 1].text +=
            `\n[page ${page.page} could not be read automatically: ${
              error instanceof Error ? error.message.slice(0, 100) : "OCR unavailable"
            }]`;
        }
      }

      const ocrText = ocrPages.map((page) => `[page ${page.page}]\n${page.text}`).join("\n\n");
      const readable = ocrPages.some((page) => page.text.replace(/\[page .*?\]/g, "").trim().length > 10);

      return {
        text: ocrText,
        pageCount,
        status: readable ? "OCR_USED" : "NEEDS_REVIEW",
        note: `${readable
          ? `This PDF had no text layer, so ${ocrPages.length} page(s) were read with OCR (${languages}). Check quantities and technical details against the original scan.`
          : "The PDF pages could not be read even with OCR. Nothing was assumed; please enter the items manually."}${pageCapNote}`,
        unreadable: !readable,
        pages: ocrPages,
        languages,
        ocrUsed: true,
        images: visionImages.length > 0 ? visionImages : undefined,
      };
    } catch (error) {
      // Fall through to pdf-parse before giving up.
      const fallbackNote = error instanceof Error ? error.message.slice(0, 140) : "unknown error";
      try {
        const pdfParse = await loadPdfParse();
        const parsed = await pdfParse(buffer);
        const text = (parsed.text ?? "").replace(/\u0000/g, "").trim();
        if (text.length >= MIN_MEANINGFUL_CHARS) {
          return { text, pageCount: parsed.numpages || 1, status: "TEXT_OK", note: null, unreadable: false };
        }
        return {
          text,
          pageCount: parsed.numpages || 1,
          status: "NEEDS_REVIEW",
          note: `The PDF has no readable text layer and could not be rendered for OCR (${fallbackNote}). Please review or enter the items manually.`,
          unreadable: true,
        };
      } catch (fallbackError) {
        return {
          text: "",
          pageCount: null,
          status: "FAILED",
          note: `The PDF could not be opened (${
            fallbackError instanceof Error ? fallbackError.message.slice(0, 140) : "unknown error"
          }).`,
          unreadable: true,
        };
      }
    }
  }

  try {
    const pdfParse = await loadPdfParse();
    const parsed = await pdfParse(buffer);
    const text = (parsed.text ?? "").replace(/\u0000/g, "").trim();
    const pages = parsed.numpages || 1;
    if (text.length >= MIN_MEANINGFUL_CHARS && text.length / pages >= MIN_CHARS_PER_PAGE) {
      return { text, pageCount: pages, status: "TEXT_OK", note: null, unreadable: false };
    }
    return {
      text,
      pageCount: pages,
      status: "NEEDS_REVIEW",
      note: "This PDF has no readable text layer and the PDF renderer needed for OCR is unavailable. Please review the document or enter the items manually.",
      unreadable: true,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The PDF could not be opened (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("text" in obj && typeof obj.text === "string") return obj.text;
    if ("result" in obj && obj.result != null) return String(obj.result);
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return obj.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    }
    if ("formula" in obj) return obj.result != null ? String(obj.result) : "";
    if ("error" in obj) return "";
    return "";
  }
  return String(value);
}

const HEADER_HINTS: Record<string, string[]> = {
  description: ["description", "product", "particular", "material description", "goods", "item description", "description of goods", "part name", "product name", "item name", "article"],
  quantity: ["qty", "quantity", "required qty", "order qty", "req qty", "required quantity"],
  unit: ["unit", "uom", "u/m", "units"],
  size: ["size", "dimension", "dia", "diameter", "n.b", "nb"],
  material: ["material", "grade material", "spec material", "moc"],
  grade: ["grade", "class", "gr"],
  pressureRating: ["pressure", "rating", "pn", "pressure rating", "class rating"],
  schedule: ["schedule", "sch", "thickness"],
  standard: ["standard", "spec", "specification", "std"],
  brand: ["brand", "make", "manufacturer", "mfg"],
  code: ["code", "sku", "part no", "part number", "item code", "material code"],
};

function headerScore(cells: string[]): number {
  const row = cells.map((cell) => cell.toLowerCase().trim());
  let score = 0;
  for (const cell of row) {
    if (!cell) continue;
    if (Object.values(HEADER_HINTS).some((hints) => hints.some((hint) => cell === hint || cell.includes(hint)))) {
      score += 1;
    }
  }
  return score;
}

/**
 * Finds the header row, tolerating a title block above it and a two-row header
 * ("Size" / "(mm)") by merging the following row when it also reads as headers.
 */
function detectHeaderRow(rows: string[][]): { index: number; map: Record<string, number>; span: number } | null {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const row = rows[i].map((cell) => cell.toLowerCase().trim());
    const found: Record<string, number> = {};
    row.forEach((cell, col) => {
      if (!cell) return;
      for (const [field, hints] of Object.entries(HEADER_HINTS)) {
        if (found[field] != null) continue;
        if (hints.some((hint) => cell === hint || cell.includes(hint))) found[field] = col;
      }
    });

    let span = 1;
    const next = rows[i + 1];
    if (next) {
      const nextScore = headerScore(next);
      const looksLikeData = next.some((cell) => /^\d+([.,]\d+)?$/.test(cell.trim())) && headerScore(next) < 2;
      if (nextScore >= 2 && !looksLikeData) {
        // Merge a second header line for columns that are still unmapped.
        next.map((cell) => cell.toLowerCase().trim()).forEach((cell, col) => {
          if (!cell) return;
          for (const [field, hints] of Object.entries(HEADER_HINTS)) {
            if (found[field] != null) continue;
            if (hints.some((hint) => cell.includes(hint))) found[field] = col;
          }
        });
        span = 2;
      }
    }

    if (found.description != null && (found.quantity != null || found.code != null)) {
      return { index: i, map: found, span };
    }
  }
  return null;
}

function rowsToLines(rows: string[][], sheetName: string, rowNumbers?: number[]): { text: string; uncertain: boolean } {
  const rowNumber = (index: number) => rowNumbers?.[index] ?? index + 1;
  const header = detectHeaderRow(rows);
  const lines: string[] = [];
  if (header) {
    const map = header.map;
    const dataStart = header.index + header.span;
    for (let i = dataStart; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.every((cell) => !cell)) continue;
      const pick = (field: string) => (map[field] != null ? (row[map[field]] ?? "").trim() : "");
      const description = pick("description");
      const code = pick("code");
      if (!description && !code) continue;
      // Skip repeated header rows in long sheets.
      if (headerScore(row) >= 3 && !/\d/.test(row.join(""))) continue;
      const quantity = pick("quantity");
      const unit = pick("unit");
      const extras = ["size", "material", "grade", "pressureRating", "schedule", "standard", "brand"]
        .map((field) => pick(field))
        .filter(Boolean)
        .join(" ");
      const qtyPart = quantity ? `${quantity} ${unit || "pcs"} ` : "";
      lines.push(`${qtyPart}${description || code} ${extras}  [${sheetName} row ${rowNumber(i)}]`.replace(/\s{2,}/g, " "));
    }
    return { text: lines.join("\n"), uncertain: false };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => !cell)) continue;
    const joined = row.filter(Boolean).join(" | ");
    if (joined.length > 2) lines.push(`${joined} [${sheetName} row ${rowNumber(i)}]`);
  }
  return { text: lines.join("\n"), uncertain: true };
}

function tableFromRows(options: {
  source: string;
  sheet: string | null;
  rows: string[][];
  rowNumbers?: number[];
  page?: number | null;
  slide?: number | null;
}): ExtractedTable | null {
  const numbered = options.rows.map((row, index) => ({
    cells: row,
    rowNumber: options.rowNumbers?.[index] ?? index + 1,
  }));
  const rows = numbered.filter((entry) => entry.cells.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) return null;
  const cellsOnly = rows.map((entry) => entry.cells);
  const headerInfo = detectHeaderRow(cellsOnly);
  const headerIndex = headerInfo?.index ?? -1;
  const header = headerIndex >= 0 ? cellsOnly[headerIndex].map((cell) => cell.trim()) : [];
  const dataStart = headerInfo ? headerInfo.index + headerInfo.span : 0;
  const dataRows = rows.slice(dataStart).map((entry) => ({
    rowNumber: entry.rowNumber,
    cells: entry.cells.map((cell) => cell.trim()),
  }));
  return {
    id: `${options.source}:${options.sheet ?? "page"}:${options.page ?? options.slide ?? 1}`,
    source: options.source,
    page: options.page ?? null,
    sheet: options.sheet,
    slide: options.slide ?? null,
    header,
    rows: dataRows.slice(0, 2_000),
    units: header.filter((cell) => /^(?:unit|uom|u\/m|mm|inch|in|kg|pcs|m|m2|m3|bar|psi)$/i.test(cell)),
    confidence: headerIndex >= 0 ? "HIGH" : "MEDIUM",
  };
}

export async function extractExcel(buffer: Buffer): Promise<DocumentText> {
  const detection = detectDocumentFormat(buffer, "workbook.xlsx");
  if (!["XLSX"].includes(detection.format)) {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: unsupportedFormatNote(detection.format),
      unreadable: true,
      format: detection.format,
    };
  }
  try {
    const safety = await ooxmlSafetyProblem(buffer, "workbook", {
      entries: MAX_DOCX_ENTRIES,
      entryBytes: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
      totalBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
    });
    if (safety) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: safety,
        unreadable: true,
        format: "XLSX",
      };
    }
    const workbook = await loadExcelWorkbook(buffer);
    const chunks: string[] = [];
    const tables: ExtractedTable[] = [];
    let uncertain = false;
    let skippedSheets = 0;
    let skippedRows = 0;
    let formulaCount = 0;
    let cellCount = 0;
    const sheets = workbook.worksheets.slice(0, MAX_XLSX_SHEETS);
    skippedSheets = Math.max(0, workbook.worksheets.length - sheets.length);

    for (const sheet of sheets) {
      const rows: string[][] = [];
      const rowNumbers: number[] = [];
      const maxRows = Math.min(sheet.rowCount, MAX_XLSX_ROWS);
      skippedRows += Math.max(0, sheet.rowCount - maxRows);
      for (let rowNumber = 1; rowNumber <= maxRows; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (!row || row.cellCount === 0) continue;
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const value = cell.value;
          if (value && typeof value === "object" && "formula" in value) formulaCount += 1;
          cellCount += 1;
          if (cellCount > MAX_XLSX_CELLS) return;
          values[colNumber - 1] = cellToString(value).toString().trim();
        });
        if (cellCount > MAX_XLSX_CELLS) {
          skippedRows += Math.max(0, maxRows - rowNumber);
          break;
        }
        while (values.length > 0 && values[values.length - 1] === undefined) values.pop();
        if (values.some((value) => (value ?? "").trim().length > 0)) {
          rows.push(values.map((value) => value ?? ""));
          rowNumbers.push(rowNumber);
        }
      }
      if (rows.length === 0) continue;
      const { text, uncertain: rowUncertain } = rowsToLines(rows, sheet.name, rowNumbers);
      if (rowUncertain) uncertain = true;
      if (text) chunks.push(`Sheet: ${sheet.name}\n${text}`);
      const table = tableFromRows({ source: "workbook.xlsx", sheet: sheet.name, rows, rowNumbers });
      if (table) tables.push(table);
    }

    if (chunks.length === 0) {
      return {
        text: "",
        pageCount: workbook.worksheets.length,
        status: "NEEDS_REVIEW",
        note: "The spreadsheet was opened but no readable rows were found.",
        unreadable: true,
        tables,
        metadata: { worksheets: workbook.worksheets.length, skippedSheets, skippedRows, formulaCount },
      };
    }

    const notes = [
      uncertain ? "No product/quantity headers were recognised, so every row was read as-is." : null,
      skippedSheets > 0 ? `${skippedSheets} worksheet(s) beyond the safe processing limit were not read.` : null,
      skippedRows > 0 ? `${skippedRows} row(s) beyond the safe processing limit were not read.` : null,
      formulaCount > 0 ? `${formulaCount} formula cell(s) used the cached calculated value; an empty cached result is not treated as zero.` : null,
    ].filter(Boolean);

    return {
      text: chunks.join("\n\n"),
      pageCount: workbook.worksheets.length,
      // Every row was read either way. An unrecognised layout is a caveat, not
      // an unreadable file, so it must not hold the extraction back.
      status: "TEXT_OK",
      note: notes.length > 0 ? notes.join(" ") : null,
      unreadable: false,
      tables,
      metadata: { worksheets: workbook.worksheets.length, skippedSheets, skippedRows, formulaCount },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The spreadsheet could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}). If it is an old .xls file, save it as .xlsx or .csv.`,
      unreadable: true,
    };
  }
}

export async function extractCsv(buffer: Buffer, filename = "data.csv"): Promise<DocumentText> {
  try {
    const detection = detectDocumentFormat(buffer, filename);
    const delimiter = detection.format === "TSV" ? "\t" : ",";
    const { parse } = await import("csv-parse/sync");
    const raw = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parse(raw, {
      relaxColumnCount: true,
      skipEmptyLines: true,
      bom: true,
      delimiter,
    }) as string[][];
    const normalized = rows.slice(0, MAX_XLSX_ROWS).map((row) => row.map((cell) => String(cell ?? "").trim()));
    const rowNumbers = normalized.map((_, index) => index + 1);
    const { text, uncertain } = rowsToLines(normalized, detection.format === "TSV" ? "TSV" : "CSV", rowNumbers);
    const table = tableFromRows({
      source: filename,
      sheet: detection.format === "TSV" ? "TSV" : "CSV",
      rows: normalized,
      rowNumbers,
    });
    return {
      text,
      pageCount: 1,
      status: text ? "TEXT_OK" : "NEEDS_REVIEW",
      note: [
        uncertain ? "No header row was recognised in the file, so every row was read as-is." : null,
        rows.length > normalized.length ? `${rows.length - normalized.length} row(s) beyond the safe limit were not read.` : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
      unreadable: !text,
      tables: table ? [table] : [],
      metadata: { rows: normalized.length },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The spreadsheet could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

async function convertHeic(buffer: Buffer): Promise<Buffer | null> {
  try {
    const sharpModule = (await import("sharp")) as unknown as {
      default?: (input: Buffer) => { jpeg: () => { toBuffer: () => Promise<Buffer> } };
    };
    const sharp = sharpModule.default;
    if (!sharp) return null;
    return await sharp(buffer).jpeg().toBuffer();
  } catch {
    return null;
  }
}

export async function extractImage(buffer: Buffer): Promise<DocumentText> {
  const detection = detectDocumentFormat(buffer, "image.jpg");
  let working = buffer;
  let conversionNote: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (["HEIC"].includes(detection.format)) {
    const converted = await convertHeic(buffer);
    if (!converted) {
      return {
        text: "",
        pageCount: 1,
        status: "NEEDS_REVIEW",
        note: "HEIC/HEIF photos (usually from an iPhone) cannot be decoded by this server. The original file is kept. Change the iPhone camera setting to “Most Compatible”, or re-send the photo as JPEG.",
        unreadable: true,
        format: detection.format,
      };
    }
    working = converted;
  }

  // Normalize orientation, contrast and size before OCR. This also converts
  // TIFF/BMP/GIF frames into a format Tesseract can read reliably.
  const prepared = await prepareImageForOcr(working);
  working = prepared.buffer;
  conversionNote = prepared.note;
  width = prepared.width;
  height = prepared.height;

  const photo = await toVisionImage(buffer);
  if (!ocrEnabled()) {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: "Text recognition (OCR) is turned off. The image is still stored and can be read by a configured vision model; nothing was assumed.",
      unreadable: true,
      images: photo ? [photo] : undefined,
      format: detection.format,
      metadata: { width, height },
    };
  }

  try {
    const languages = ocrLanguages();
    const Tesseract = (await import("tesseract.js")).default;
    const result = await Tesseract.recognize(working, languages, ocrOptions());
    const text = (result.data.text ?? "").trim();
    if (text.length < 10) {
      return {
        text,
        pageCount: 1,
        status: "NEEDS_REVIEW",
        note: `${conversionNote ? `${conversionNote} ` : ""}Text recognition found little in the image, so it was passed to the AI to read directly.`,
        unreadable: true,
        images: photo ? [photo] : undefined,
        format: detection.format,
        metadata: { width, height },
      };
    }
    const arabic = languages.includes("ara");
    return {
      text,
      pageCount: 1,
      status: "OCR_USED",
      note: `${conversionNote ? `${conversionNote} ` : ""}Text was read from the image with OCR (${languages}). Check the items against the original image, especially handwriting${
        arabic ? "." : "; Arabic script needs OCR_LANGUAGES to include “ara”."
      }`,
      unreadable: false,
      languages,
      ocrUsed: true,
      images: photo ? [photo] : undefined,
      format: detection.format,
      metadata: { width, height },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: `The image could not be read automatically (${error instanceof Error ? error.message.slice(0, 120) : "OCR unavailable"}). ${
        /fetch|network|download/i.test(error instanceof Error ? error.message : "")
          ? "OCR language data needs to be downloaded once; check the server's internet access."
          : ""
      }`.trim(),
      unreadable: true,
      images: photo ? [photo] : undefined,
      format: detection.format,
      metadata: { width, height },
    };
  }
}

export async function extractPlainText(buffer: Buffer): Promise<DocumentText> {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  return {
    text,
    pageCount: null,
    status: text ? "TEXT_OK" : "NEEDS_REVIEW",
    note: text ? null : "The text file was empty.",
    unreadable: !text,
  };
}

const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_DOCUMENTS = 25;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_NESTING_DEPTH = 3;
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;

/** Reads JSZip's central-directory size without inflating the entry first. */
function declaredUncompressedSize(entry: unknown): number | null {
  const data = (entry as { _data?: { uncompressedSize?: unknown } } | null)?._data;
  const size = Number(data?.uncompressedSize);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

/** Pre-flights an OOXML archive before ExcelJS/JSZip inflates its entries. */
async function ooxmlSafetyProblem(
  buffer: Buffer,
  label: string,
  limits: { entries: number; entryBytes: number; totalBytes: number },
): Promise<string | null> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);
    if (entries.length > limits.entries) {
      return `The ${label} contains ${entries.length} archive entries, above the safe limit of ${limits.entries}.`;
    }
    let declaredTotal = 0;
    for (const name of entries) {
      const declared = declaredUncompressedSize(zip.file(name));
      if (declared == null) continue;
      if (declared > limits.entryBytes) {
        return `The ${label} contains an entry above the safe decompressed-size limit.`;
      }
      declaredTotal += declared;
      if (declaredTotal > limits.totalBytes) {
        return `The ${label} declares a decompressed size above the safe limit.`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Decode the handful of XML entities that appear in OOXML text. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/** Strip tags from an OOXML document.xml stream, keeping paragraph breaks. */
function docxXmlToText(xml: string): string {
  // Replace paragraph/table row boundaries with newlines before stripping tags.
  const withBreaks = xml
    .replace(/<w:br[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");
  const text = withBreaks.replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text)
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function extractDocx(buffer: Buffer): Promise<DocumentText> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);
    if (entries.length > MAX_DOCX_ENTRIES) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: `The .docx contains ${entries.length} archive entries, above the safe limit of ${MAX_DOCX_ENTRIES}.`,
        unreadable: true,
      };
    }
    let declaredTotal = 0;
    for (const name of entries) {
      const declared = declaredUncompressedSize(zip.file(name));
      if (declared == null) continue;
      declaredTotal += declared;
      if (declared > MAX_DOCX_XML_BYTES || declaredTotal > MAX_ZIP_UNCOMPRESSED_BYTES) {
        return {
          text: "",
          pageCount: null,
          status: "NEEDS_REVIEW",
          note: "The .docx declared an unsafe decompressed size and was not extracted.",
          unreadable: true,
        };
      }
    }
    const documentEntry = zip.file("word/document.xml");
    if (!documentEntry) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: "The .docx did not contain a readable document.xml part.",
        unreadable: true,
      };
    }
    const xml = await documentEntry.async("string");
    if (Buffer.byteLength(xml, "utf8") > MAX_DOCX_XML_BYTES) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: "The .docx document.xml exceeded the safe extraction size.",
        unreadable: true,
      };
    }
    const text = docxXmlToText(xml);
    const tables: ExtractedTable[] = [];
    const tableMatches = [...xml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl\s*>/gi)].slice(0, 20);
    for (const tableMatch of tableMatches) {
      const rows = [...tableMatch[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr\s*>/gi)].map((rowMatch) =>
        [...rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc\s*>/gi)].map((cell) =>
          decodeXmlEntities(
            [...cell[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>/gi)].map((match) => match[1]).join(" "),
          ).replace(/\s+/g, " " ).trim(),
        ),
      );
      const table = tableFromRows({ source: "document.docx", sheet: null, page: null, rows });
      if (table) tables.push({ ...table, confidence: "MEDIUM" });
    }
    const media = entries.filter((name) => /^word\/media\//i.test(name) && !/\/$/.test(name));
    // Also pull any headers/footers for completeness.
    const extras: string[] = [];
    for (const name of Object.keys(zip.files)) {
      if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
        const part = zip.file(name);
        if (part) {
          const partXml = await part.async("string");
          const partText = docxXmlToText(partXml);
          if (partText) extras.push(partText);
        }
      }
    }
    let embeddedText = "";
    if (!text.trim() && ocrEnabled()) {
      for (const name of media.slice(0, 2)) {
        const part = zip.file(name);
        if (!part) continue;
        const image = await part.async("nodebuffer");
        if (image.length > 12 * 1024 * 1024) continue;
        const extracted = await extractImage(image);
        if (extracted.text.trim()) embeddedText += `\n--- ${name} ---\n${extracted.text}`;
      }
    }
    const combined = [text, ...extras, embeddedText].filter(Boolean).join("\n");
    return {
      text: combined,
      pageCount: null,
      status: combined ? "TEXT_OK" : "NEEDS_REVIEW",
      note: combined ? null : "The .docx contained no readable text. Embedded images are kept for visual review.",
      unreadable: !combined,
      tables,
      metadata: { tables: tables.length, embeddedImages: media.length },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The .docx could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

// ── HTML ───────────────────────────────────────────────────────────────────

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlFragmentToText(fragment: string): string {
  return decodeHtmlEntities(
    fragment
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|tr|table|section|article|blockquote)\s*>/gi, "\n")
      .replace(/<\/(?:td|th)\s*>/gi, "\t")
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function extractHtml(buffer: Buffer, filename = "document.html"): Promise<DocumentText> {
  try {
    const html = buffer.toString("utf8").slice(0, 5 * 1024 * 1024).replace(/^\uFEFF/, "");
    const title = decodeHtmlEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
    const withoutHead = html.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
    const text = htmlFragmentToText(withoutHead);
    const tables: ExtractedTable[] = [];
    const tableBlocks = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].slice(0, 20);
    for (const block of tableBlocks) {
      const rows: string[][] = [];
      const rowNumbers: number[] = [];
      const rowMatches = [...block[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
      rowMatches.slice(0, 1_000).forEach((rowMatch, rowIndex) => {
        const cells = [...rowMatch[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((cell) =>
          htmlFragmentToText(cell[2]).replace(/\n/g, " "),
        );
        if (cells.length > 0) {
          rows.push(cells);
          rowNumbers.push(rowIndex + 1);
        }
      });
      const table = tableFromRows({ source: filename, sheet: null, page: null, rows, rowNumbers });
      if (table) tables.push({ ...table, confidence: "MEDIUM" });
    }
    return {
      text,
      pageCount: null,
      status: text ? "TEXT_OK" : "NEEDS_REVIEW",
      note: text ? null : "The HTML document contained no readable body text.",
      unreadable: !text,
      tables,
      metadata: { title: title || null, tables: tables.length },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The HTML document could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

// ── RTF ────────────────────────────────────────────────────────────────────

const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "footer",
  "headerl",
  "headerr",
  "footerl",
  "footerr",
  "xmlnstbl",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
]);

/** A bounded RTF reader: text and paragraph breaks, never fields or objects. */
export function rtfToText(input: string): string {
  let out = "";
  const skipStack: boolean[] = [];
  let skip = false;
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === "{") {
      skipStack.push(skip);
      const ahead = input.slice(index + 1, index + 120);
      const destination = ahead.match(/^\\([a-zA-Z]+)/)?.[1]?.toLowerCase() ?? null;
      if (ahead.startsWith("\\*")) skip = true;
      if (destination && RTF_SKIP_DESTINATIONS.has(destination)) skip = true;
      index += 1;
      continue;
    }
    if (char === "}") {
      skip = skipStack.pop() ?? false;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = input[index + 1] ?? "";
      if (next === "\\" || next === "{" || next === "}") {
        if (!skip) out += next;
        index += 2;
        continue;
      }
      if (next === "'") {
        const hex = input.slice(index + 2, index + 4);
        if (!skip && /^[0-9a-fA-F]{2}$/.test(hex)) out += Buffer.from([parseInt(hex, 16)]).toString("latin1");
        index += 4;
        continue;
      }
      if (next === "*") {
        skip = true;
        index += 2;
        continue;
      }
      const control = input.slice(index + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
      if (control) {
        const word = control[1].toLowerCase();
        const parameter = control[2] ? Number(control[2]) : null;
        if (!skip) {
          if (word === "par" || word === "line" || word === "sect" || word === "page") out += "\n";
          else if (word === "tab") out += "\t";
          else if (word === "u" && parameter != null) {
            out += String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter);
          } else if (word === "emdash") out += "—";
          else if (word === "endash") out += "–";
        }
        index += control[0].length + 1;
        continue;
      }
      index += 2;
      continue;
    }
    if (!skip && char !== "\r" && char !== "\n") out += char;
    index += 1;
  }
  return out
    .replace(/[ \t]+/g, " ")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export async function extractRtf(buffer: Buffer): Promise<DocumentText> {
  try {
    const text = rtfToText(buffer.toString("latin1"));
    return {
      text,
      pageCount: null,
      status: text ? "TEXT_OK" : "NEEDS_REVIEW",
      note: text ? null : "The RTF document contained no readable text.",
      unreadable: !text,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The RTF document could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

// ── EML ────────────────────────────────────────────────────────────────────

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, data: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : Buffer.from(
              data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
              "latin1",
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return data;
    }
  });
}

function parseMimeHeaders(source: string): { headers: Record<string, string>; body: string } {
  const split = source.search(/\r?\n\r?\n/);
  const headerText = split >= 0 ? source.slice(0, split) : source;
  const body = split >= 0 ? source.slice(split).replace(/^\r?\n\r?\n/, "") : "";
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    headers[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return { headers, body };
}

function decodeTransfer(body: string, encoding: string | undefined): Buffer {
  const normalized = (encoding ?? "").trim().toLowerCase();
  if (normalized === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (normalized === "quoted-printable") {
    const bytes: number[] = [];
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === "=" && body[index + 1] === "\n") {
        index += 1;
        continue;
      }
      if (body[index] === "=" && body[index + 1] === "\r" && body[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (body[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(body.slice(index + 1, index + 3))) {
        bytes.push(parseInt(body.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }
      bytes.push(body.charCodeAt(index) & 0xff);
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, "utf8");
}

type ParsedMimePart = {
  headers: Record<string, string>;
  body: string;
};

function mimeParameter(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const pattern = new RegExp(`${name}\\*?\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const match = header.match(pattern);
  return (match?.[1] ?? match?.[2] ?? null)?.trim() ?? null;
}

async function parseMimePart(part: ParsedMimePart, depth: number, state: { text: string[]; tables: ExtractedTable[]; attachments: string[]; failures: string[] }): Promise<void> {
  if (depth > 3) return;
  const contentType = (part.headers["content-type"] ?? "text/plain").trim();
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const disposition = part.headers["content-disposition"] ?? "";
  const filename = decodeMimeWords(
    mimeParameter(disposition, "filename") ?? mimeParameter(contentType, "name") ?? "",
  );
  const isAttachment = /attachment/i.test(disposition) || Boolean(filename);

  if (mime.startsWith("multipart/")) {
    const boundary = mimeParameter(contentType, "boundary");
    if (!boundary) return;
    const pieces = part.body.split(`--${boundary}`).slice(1, 30);
    for (const piece of pieces) {
      const clean = piece.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, "");
      if (!clean.trim() || clean.trim() === "--") continue;
      const parsed = parseMimeHeaders(clean);
      await parseMimePart(parsed, depth + 1, state);
    }
    return;
  }

  const decoded = decodeTransfer(part.body, part.headers["content-transfer-encoding"]);
  if (mime === "text/plain" && !isAttachment) {
    state.text.push(decoded.toString("utf8"));
    return;
  }
  if (mime === "text/html" && !isAttachment) {
    const html = await extractHtml(decoded, filename || "email.html");
    if (html.text) state.text.push(html.text);
    if (html.tables) state.tables.push(...html.tables);
    return;
  }
  if (!isAttachment) return;

  const safeName = filename || `attachment-${state.attachments.length + 1}`;
  state.attachments.push(safeName);
  if (decoded.length > 12 * 1024 * 1024) {
    state.failures.push(`${safeName}: larger than the safe e-mail attachment limit.`);
    return;
  }
  const attachmentDetection = detectDocumentFormat(decoded, safeName);
  const nested =
    attachmentDetection.format === "EML"
      ? await extractEml(decoded, safeName, depth + 1)
      : await extractDocumentNative(decoded, safeName);
  if (nested.text.trim()) state.text.push(`--- ${safeName} ---\n${nested.text}`);
  else if (nested.unreadable) state.failures.push(`${safeName}: ${nested.note ?? "could not be read"}`);
  if (nested.tables) state.tables.push(...nested.tables);
}

export async function extractEml(
  buffer: Buffer,
  _filename = "message.eml",
  depth = 0,
): Promise<DocumentText> {
  if (depth > 3) {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: "Nested e-mail attachments exceeded the safe limit.",
      unreadable: true,
    };
  }
  try {
    const source = buffer.toString("utf8").slice(0, 15 * 1024 * 1024);
    const parsed = parseMimeHeaders(source);
    const state = { text: [] as string[], tables: [] as ExtractedTable[], attachments: [] as string[], failures: [] as string[] };
    await parseMimePart(parsed, 0, state);
    const text = state.text.join("\n\n").trim().slice(0, 80_000);
    const notes = [
      state.failures.length > 0 ? `Some e-mail attachments could not be read: ${state.failures.slice(0, 4).join("; ")}` : null,
    ].filter(Boolean);
    return {
      text,
      pageCount: null,
      status: text ? "TEXT_OK" : state.failures.length > 0 ? "NEEDS_REVIEW" : "FAILED",
      note: notes.length > 0 ? notes.join(" ") : null,
      unreadable: !text,
      tables: state.tables,
      metadata: {
        subject: decodeMimeWords(parsed.headers.subject ?? "") || null,
        from: decodeMimeWords(parsed.headers.from ?? "") || null,
        to: decodeMimeWords(parsed.headers.to ?? "") || null,
        date: parsed.headers.date ?? null,
        attachments: state.attachments.join(", ") || null,
      },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The e-mail message could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

// ── PPTX ───────────────────────────────────────────────────────────────────

function pptxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<a:br[^>]*\/?>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/a:tr>/g, "\n")
    .replace(/<\/a:tc>/g, "\t");
  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ""))
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function extractPptx(buffer: Buffer, filename = "presentation.pptx"): Promise<DocumentText> {
  try {
    const safety = await ooxmlSafetyProblem(buffer, "presentation", {
      entries: MAX_DOCX_ENTRIES,
      entryBytes: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
      totalBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
    });
    if (safety) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: safety,
        unreadable: true,
        format: "PPTX",
      };
    }
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);
    if (entries.length > MAX_DOCX_ENTRIES) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: `The presentation contains ${entries.length} archive entries, above the safe limit of ${MAX_DOCX_ENTRIES}.`,
        unreadable: true,
      };
    }
    const slides = entries
      .map((name) => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/i) }))
      .filter((entry): entry is { name: string; match: RegExpMatchArray } => Boolean(entry.match))
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
      .slice(0, 100);
    const chunks: string[] = [];
    const tables: ExtractedTable[] = [];
    for (const slide of slides) {
      const entry = zip.file(slide.name);
      if (!entry) continue;
      const xml = await entry.async("string");
      if (Buffer.byteLength(xml, "utf8") > MAX_DOCX_XML_BYTES) continue;
      const slideNo = Number(slide.match[1]);
      const text = pptxXmlToText(xml);
      if (text) chunks.push(`[slide ${slideNo}]\n${text}`);
      const tableMatches = [...xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl\s*>/gi)].slice(0, 20);
      for (const tableMatch of tableMatches) {
        const rows = [...tableMatch[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr\s*>/gi)].map((rowMatch) =>
          [...rowMatch[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc\s*>/gi)].map((cell) =>
            decodeXmlEntities(
              [...cell[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>/gi)].map((match) => match[1]).join(" "),
            ).replace(/\s+/g, " ").trim(),
          ),
        );
        const table = tableFromRows({ source: filename, sheet: null, slide: slideNo, rows });
        if (table) tables.push({ ...table, confidence: "MEDIUM" });
      }
    }

    const media = entries.filter((name) => /^ppt\/media\//i.test(name) && !/\/$/.test(name));
    let embeddedText = "";
    if (chunks.join("\n").trim().length < MIN_MEANINGFUL_CHARS && ocrEnabled()) {
      for (const name of media.slice(0, 3)) {
        const entry = zip.file(name);
        if (!entry) continue;
        const image = await entry.async("nodebuffer");
        if (image.length > 12 * 1024 * 1024) continue;
        const extracted = await extractImage(image);
        if (extracted.text.trim()) embeddedText += `\n--- ${name} ---\n${extracted.text}`;
      }
    }

    const text = `${chunks.join("\n\n")}${embeddedText}`.trim();
    return {
      text,
      pageCount: slides.length,
      status: text ? "TEXT_OK" : "NEEDS_REVIEW",
      note: text ? null : "The presentation contained no readable slide text. Embedded images are kept for visual review.",
      unreadable: !text,
      tables,
      metadata: { slides: slides.length, embeddedImages: media.length },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The presentation could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

export async function extractZip(buffer: Buffer, depth = 0): Promise<DocumentText> {
  if (depth > MAX_ZIP_NESTING_DEPTH) {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: "Archive nesting exceeded the safe limit.",
      unreadable: true,
    };
  }
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);
    if (entries.length > MAX_ZIP_ENTRIES) {
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: `Archive contains ${entries.length} entries, above the safe limit of ${MAX_ZIP_ENTRIES}.`,
        unreadable: true,
      };
    }
    // Guard against path traversal in entry names.
    for (const name of entries) {
      const normalized = name.replace(/\\/g, "/");
      if (normalized.includes("..") || normalized.startsWith("/") || normalized.includes("\u0000")) {
        return {
          text: "",
          pageCount: null,
          status: "NEEDS_REVIEW",
          note: "Archive contained an unsafe entry path and was not extracted.",
          unreadable: true,
        };
      }
    }
    let declaredUncompressed = 0;
    for (const name of entries) {
      const entry = zip.file(name);
      if (!entry || entry.dir) continue;
      const declared = declaredUncompressedSize(entry);
      if (declared == null) continue;
      if (declared > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
        return {
          text: "",
          pageCount: null,
          status: "NEEDS_REVIEW",
          note: `Archive entry "${name}" declares ${declared} uncompressed bytes, above the safe per-entry limit.`,
          unreadable: true,
        };
      }
      declaredUncompressed += declared;
      if (declaredUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
        return {
          text: "",
          pageCount: null,
          status: "NEEDS_REVIEW",
          note: "Archive declared decompressed size exceeded the safe limit.",
          unreadable: true,
        };
      }
    }
    let totalUncompressed = 0;
    const chunks: string[] = [];
    const tables: ExtractedTable[] = [];
    const failures: string[] = [];
    let processed = 0;
    let skippedForLimit = 0;
    for (const name of entries) {
      const entry = zip.file(name);
      if (!entry || entry.dir) continue;
      // Skip macos metadata and hidden junk.
      if (name.startsWith("__MACOSX/") || name.split("/").pop()?.startsWith(".")) continue;
      const data = await entry.async("nodebuffer");
      totalUncompressed += data.length;
      if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
        return {
          text: "",
          pageCount: null,
          status: "NEEDS_REVIEW",
          note: "Archive decompressed size exceeded the safe limit.",
          unreadable: true,
        };
      }
      const detection = detectDocumentFormat(data, name);
      if (!detection.info.supported) {
        failures.push(`${name}: ${unsupportedFormatNote(detection.format)}`);
        continue;
      }
      if (processed >= MAX_ZIP_DOCUMENTS) {
        skippedForLimit += 1;
        continue;
      }
      processed += 1;
      let nested: DocumentText;
      switch (detection.format) {
        case "PDF":
          nested = await extractPdf(data);
          break;
        case "DOCX":
          nested = await extractDocx(data);
          break;
        case "XLSX":
          nested = await extractExcel(data);
          break;
        case "CSV":
        case "TSV":
          nested = await extractCsv(data, name);
          break;
        case "HTML":
          nested = await extractHtml(data, name);
          break;
        case "RTF":
          nested = await extractRtf(data);
          break;
        case "EML":
          nested = await extractEml(data, name);
          break;
        case "PPTX":
          nested = await extractPptx(data, name);
          break;
        case "ZIP":
          nested = await extractZip(data, depth + 1);
          break;
        case "TXT":
          nested = await extractPlainText(data);
          break;
        default:
          if (detection.info.parser === "image") nested = await extractImage(data);
          else nested = { text: "", pageCount: null, status: "NEEDS_REVIEW", note: unsupportedFormatNote(detection.format), unreadable: true };
          break;
      }
      // For CSV/TSV, retain the original row text inside the archive excerpt as
      // well as the structured table. Downstream extraction can then cite the
      // exact row without losing delimiters.
      const chunkText =
        detection.format === "CSV" || detection.format === "TSV"
          ? data.toString("utf8").slice(0, 20_000).trim()
          : nested.text;
      if (chunkText) chunks.push(`--- ${name} ---\n${chunkText}`);
      if (nested.tables) tables.push(...nested.tables);
      if (nested.unreadable) failures.push(`${name}: ${nested.note ?? "could not be read"}`);
    }
    const combined = chunks.join("\n\n");
    const notes = [
      skippedForLimit > 0
        ? `${skippedForLimit} supported file(s) were kept but not read because the archive processing limit (${MAX_ZIP_DOCUMENTS}) was reached.`
        : null,
      failures.length > 0 ? `Some archive entries need review: ${failures.slice(0, 4).join("; ")}` : null,
    ].filter(Boolean);
    return {
      text: combined,
      pageCount: null,
      status: combined ? "TEXT_OK" : "NEEDS_REVIEW",
      note: notes.length > 0 ? notes.join(" ") : null,
      unreadable: !combined,
      tables,
      metadata: { entries: processed, skipped: skippedForLimit, failures: failures.length },
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The archive could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
      unreadable: true,
    };
  }
}

export async function extractDocumentNative(buffer: Buffer, filename: string): Promise<DocumentText> {
  const detection = detectDocumentFormat(buffer, filename);
  if (detection.encrypted) {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: "This Office/PDF file is password-protected or encrypted. Nothing was guessed. Provide an unlocked copy.",
      unreadable: true,
      encrypted: true,
      format: detection.format,
    };
  }
  switch (detection.format) {
    case "PDF":
      return extractPdf(buffer);
    case "XLSX":
      return extractExcel(buffer);
    case "DOCX":
      return extractDocx(buffer);
    case "PPTX":
      return extractPptx(buffer, filename);
    case "ZIP":
      return extractZip(buffer);
    case "CSV":
    case "TSV":
      return extractCsv(buffer, filename);
    case "HTML":
      return extractHtml(buffer, filename);
    case "RTF":
      return extractRtf(buffer);
    case "EML":
      return extractEml(buffer, filename);
    case "TXT":
      return extractPlainText(buffer);
    default:
      if (detection.info.parser === "image") return extractImage(buffer);
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: unsupportedFormatNote(detection.format),
        unreadable: true,
        format: detection.format,
      };
  }
}
