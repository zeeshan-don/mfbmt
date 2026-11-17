import { env } from "../env";
import { sniffType } from "../storage";

export type DocumentText = {
  text: string;
  pageCount: number | null;
  status: "TEXT_OK" | "OCR_USED" | "NEEDS_REVIEW" | "FAILED";
  note: string | null;
  unreadable: boolean;
};

const MIN_MEANINGFUL_CHARS = 25;

async function loadPdfParse() {
  // pdf-parse is CommonJS; keep it external (see next.config serverExternalPackages).
  const mod = (await import("pdf-parse")) as unknown as {
    default?: (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
  };
  const fn = mod.default ?? (mod as unknown as (buffer: Buffer) => Promise<{ text: string; numpages: number }>);
  return fn;
}

export async function extractPdf(buffer: Buffer): Promise<DocumentText> {
  try {
    const pdfParse = await loadPdfParse();
    const parsed = await pdfParse(buffer);
    const text = (parsed.text ?? "").replace(/\u0000/g, "").trim();
    const pages = parsed.numpages || 1;
    const perPage = text.length / pages;
    if (text.length >= MIN_MEANINGFUL_CHARS && perPage >= 20) {
      return { text, pageCount: pages, status: "TEXT_OK", note: null, unreadable: false };
    }
    return {
      text,
      pageCount: pages,
      status: "NEEDS_REVIEW",
      note:
        "This PDF appears to be a scan with little or no readable text. The pages could not be read reliably, so nothing was assumed. Please review the document or retype the items.",
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
    if ("formula" in obj) return ""; // never trust formulas without cached results
    return "";
  }
  return String(value);
}

const HEADER_HINTS: Record<string, string[]> = {
  description: ["description", "item", "product", "particular", "material description", "goods"],
  quantity: ["qty", "quantity", "required qty", "order qty"],
  unit: ["unit", "uom", "u/m"],
  size: ["size", "dimension", "dia", "diameter"],
  material: ["material", "grade material", "spec material"],
  grade: ["grade", "class"],
  pressureRating: ["pressure", "rating", "class", "pn"],
  schedule: ["schedule", "sch"],
  standard: ["standard", "spec", "specification"],
  brand: ["brand", "make", "manufacturer"],
  code: ["code", "sku", "part no", "part number", "item code"],
};

function detectHeaderRow(rows: string[][]): { index: number; map: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const row = rows[i].map((cell) => cell.toLowerCase().trim());
    const found: Record<string, number> = {};
    row.forEach((cell, col) => {
      if (!cell) return;
      for (const [field, hints] of Object.entries(HEADER_HINTS)) {
        if (found[field] != null) continue;
        if (hints.some((hint) => cell === hint || cell.includes(hint))) found[field] = col;
      }
    });
    if (found.description != null && (found.quantity != null || found.code != null)) {
      return { index: i, map: found };
    }
  }
  return null;
}

function rowsToLines(rows: string[][], sheetName: string): { text: string; uncertain: boolean } {
  const header = detectHeaderRow(rows);
  const lines: string[] = [];
  if (header) {
    const map = header.map;
    for (let i = header.index + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.every((cell) => !cell)) continue;
      const pick = (field: string) => (map[field] != null ? (row[map[field]] ?? "").trim() : "");
      const description = pick("description");
      const code = pick("code");
      if (!description && !code) continue;
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
        ? "The spreadsheet layout was not clear (no product/quantity headers were recognized), so columns were read as-is. Please check the extracted items."
        : null,
      unreadable: uncertain,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      status: "FAILED",
      note: `The spreadsheet could not be read (${error instanceof Error ? error.message.slice(0, 140) : "unknown error"}). Legacy .xls files should be saved as .xlsx or .csv.`,
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
      note: uncertain ? "No header row was recognized in the CSV; rows were read as-is. Please review." : null,
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

export async function extractImage(buffer: Buffer): Promise<DocumentText> {
  if (env.OCR_PROVIDER === "none") {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: "OCR is turned off. The image is attached to the enquiry for you to read and enter manually.",
      unreadable: true,
    };
  }
  const sniffed = sniffType(buffer);
  if (sniffed.mime === "image/heic" || sniffed.mime === "image/heif") {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: "HEIC photos are not decoded by this server. Please re-send as JPEG or enter the items manually.",
      unreadable: true,
    };
  }
  try {
    const Tesseract = (await import("tesseract.js")).default;
    const result = await Tesseract.recognize(buffer, "eng");
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
    return {
      text,
      pageCount: 1,
      status: "OCR_USED",
      note: "Text was read from the photo. Check the extracted items against the image, especially handwriting.",
      unreadable: false,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: 1,
      status: "NEEDS_REVIEW",
      note: `The photo could not be read automatically (${error instanceof Error ? error.message.slice(0, 120) : "OCR unavailable"}).`,
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
        note: `${filename} is not a supported document type.`,
        unreadable: true,
      };
  }
}
