import { env } from "../env";
import { sniffType } from "../storage";

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
};

const MIN_MEANINGFUL_CHARS = 25;
const MIN_CHARS_PER_PAGE = 20;

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
  let tasks: MupdfTasks | null = null;
  try {
    tasks = (await import("mupdf/tasks")) as unknown as MupdfTasks;
  } catch {
    tasks = null;
  }

  if (tasks) {
    try {
      const document = tasks.loadPDF(new Uint8Array(buffer));
      const pageCount = document.countPages();
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

      if (meaningful) {
        return {
          text: textPages.map((page) => `[page ${page.page}]\n${page.text}`).join("\n\n"),
          pageCount,
          status: "TEXT_OK",
          note: null,
          unreadable: false,
          pages: textPages.map((page) => ({ page: page.page, text: page.text, ocr: false })),
        };
      }

      if (!ocrEnabled()) {
        return {
          text: textPages.map((page) => page.text).join("\n").trim(),
          pageCount,
          status: "NEEDS_REVIEW",
          note: "This PDF has no readable text layer (it is a scan or a photo). Photo and scan reading is turned off, so nothing was assumed. Turn on OCR in Settings or enter the items manually.",
          unreadable: true,
          pages: textPages.map((page) => ({ page: page.page, text: page.text, ocr: false })),
        };
      }

      const languages = ocrLanguages();
      const Tesseract = (await import("tesseract.js")).default;
      const ocrPages: Array<{ page: number; text: string; ocr: boolean }> = [];
      const limit = Math.min(pageCount, Math.max(1, env.OCR_PDF_MAX_PAGES));

      for (const page of textPages.slice(0, limit)) {
        try {
          const png = tasks.drawPageAsPNG(document, page.page - 1, 200);
          const result = await Tesseract.recognize(Buffer.from(png), languages);
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
        note: readable
          ? `This PDF had no text layer, so ${ocrPages.length} page(s) were read with OCR (${languages}). Check quantities and technical details against the original scan.`
          : "The PDF pages could not be read even with OCR. Nothing was assumed; please enter the items manually.",
        unreadable: !readable,
        pages: ocrPages,
        languages,
        ocrUsed: true,
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
  description: ["description", "item", "product", "particular", "material description", "goods", "item description", "description of goods"],
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

function rowsToLines(rows: string[][], sheetName: string): { text: string; uncertain: boolean } {
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
      lines.push(`${qtyPart}${description || code} ${extras}  [${sheetName} row ${i + 1}]`.replace(/\s{2,}/g, " "));
    }
    return { text: lines.join("\n"), uncertain: false };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => !cell)) continue;
    const joined = row.filter(Boolean).join(" | ");
    if (joined.length > 2) lines.push(`${joined} [${sheetName} row ${i + 1}]`);
  }
  return { text: lines.join("\n"), uncertain: true };
}

export async function extractExcel(buffer: Buffer): Promise<DocumentText> {
  const sniffed = sniffType(buffer);
  if (sniffed.mime === "application/vnd.ms-excel") {
    return {
      text: "",
      pageCount: null,
      status: "NEEDS_REVIEW",
      note: "Legacy .xls workbooks are not read. Open the file in Excel or LibreOffice and save it as .xlsx or .csv, then upload it again.",
      unreadable: true,
    };
  }
  try {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const chunks: string[] = [];
    let uncertain = false;
    workbook.eachSheet((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          values.push(cellToString(cell.value).toString().trim());
        });
        // Pad so a short row does not shift columns.
        while (values.length < 32) values.push("");
        rows.push(values);
      });
      if (rows.length === 0) return;
      const { text, uncertain: rowUncertain } = rowsToLines(rows, sheet.name);
      if (rowUncertain) uncertain = true;
      if (text) chunks.push(`Sheet: ${sheet.name}\n${text}`);
    });

    if (chunks.length === 0) {
      return {
        text: "",
        pageCount: workbook.worksheets.length,
        status: "NEEDS_REVIEW",
        note: "The spreadsheet was opened but no readable rows were found.",
        unreadable: true,
      };
    }
    return {
      text: chunks.join("\n\n"),
      pageCount: workbook.worksheets.length,
      status: uncertain ? "NEEDS_REVIEW" : "TEXT_OK",
      note: uncertain
        ? "The spreadsheet layout was not clear (no product/quantity headers were recognised), so columns were read as-is. Please check the extracted items."
        : null,
      unreadable: uncertain,
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

export async function extractCsv(buffer: Buffer): Promise<DocumentText> {
  try {
    const { parse } = await import("csv-parse/sync");
    const raw = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parse(raw, { relaxColumnCount: true, skipEmptyLines: true, bom: true }) as string[][];
    const normalized = rows.map((row) => row.map((cell) => String(cell ?? "").trim()));
    const { text, uncertain } = rowsToLines(normalized, "CSV");
    return {
      text,
      pageCount: 1,
      status: uncertain || !text ? "NEEDS_REVIEW" : "TEXT_OK",
      note: uncertain ? "No header row was recognised in the CSV; rows were read as-is. Please review." : null,
      unreadable: uncertain || !text,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The CSV could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}).`,
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
  if (!ocrEnabled()) {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: "Photo and scan reading (OCR) is turned off. The image is attached to the enquiry for you to read and enter manually.",
      unreadable: true,
    };
  }

  let working = buffer;
  const sniffed = sniffType(buffer);
  if (sniffed.mime === "image/heic" || sniffed.mime === "image/heif") {
    const converted = await convertHeic(buffer);
    if (!converted) {
      return {
        text: "",
        pageCount: 1,
        status: "NEEDS_REVIEW",
        note: "HEIC/HEIF photos (usually from an iPhone) cannot be decoded by this server. Change the iPhone camera setting to “Most Compatible”, or re-send the photo as JPEG.",
        unreadable: true,
      };
    }
    working = converted;
  }

  try {
    const languages = ocrLanguages();
    const Tesseract = (await import("tesseract.js")).default;
    const result = await Tesseract.recognize(working, languages);
    const text = (result.data.text ?? "").trim();
    if (text.length < 10) {
      return {
        text,
        pageCount: 1,
        status: "NEEDS_REVIEW",
        note: "No readable text was found in the image. Nothing was assumed; the image stays attached for review.",
        unreadable: true,
      };
    }
    const arabic = languages.includes("ara");
    return {
      text,
      pageCount: 1,
      status: "OCR_USED",
      note: `Text was read from the photo with OCR (${languages}). Check the items against the image, especially handwriting${
        arabic ? "." : "; Arabic script needs OCR_LANGUAGES to include “ara”."
      }`,
      unreadable: false,
      languages,
      ocrUsed: true,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: `The photo could not be read automatically (${error instanceof Error ? error.message.slice(0, 120) : "OCR unavailable"}). ${
        /fetch|network|download/i.test(error instanceof Error ? error.message : "")
          ? "OCR language data needs to be downloaded once; check the server's internet access."
          : ""
      }`.trim(),
      unreadable: true,
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

export async function extractDocument(buffer: Buffer, filename: string): Promise<DocumentText> {
  const { family } = sniffType(buffer);
  switch (family) {
    case "pdf":
      return extractPdf(buffer);
    case "excel":
      return extractExcel(buffer);
    case "csv":
      return extractCsv(buffer);
    case "image":
      return extractImage(buffer);
    case "text":
      return extractPlainText(buffer);
    default:
      return {
        text: "",
        pageCount: null,
        status: "NEEDS_REVIEW",
        note: `${filename} is not a supported document type. Supported: PDF, XLSX, CSV, plain text, JPEG, PNG and WebP.`,
        unreadable: true,
      };
  }
}
