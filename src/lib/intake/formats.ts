import path from "node:path";

/**
 * Content-first document format detection.
 *
 * A filename is a label supplied by the sender, never proof of the file type.
 * The registry below identifies the bytes first, uses the extension only as a
 * hint, and records when the two disagree. It deliberately does not execute or
 * render anything: detection is a bounded byte inspection.
 */

export type DocumentFormatId =
  | "PDF"
  | "DOCX"
  | "DOC"
  | "XLSX"
  | "XLS"
  | "CSV"
  | "TSV"
  | "TXT"
  | "RTF"
  | "HTML"
  | "EML"
  | "MSG"
  | "PPTX"
  | "PPT"
  | "JPEG"
  | "PNG"
  | "WEBP"
  | "HEIC"
  | "TIFF"
  | "BMP"
  | "GIF"
  | "ZIP"
  | "UNKNOWN";

export type DocumentParserKind =
  | "pdf"
  | "docx"
  | "excel"
  | "csv"
  | "text"
  | "rtf"
  | "html"
  | "eml"
  | "pptx"
  | "image"
  | "zip"
  | "unsupported";

export type DocumentFormatInfo = {
  id: DocumentFormatId;
  label: string;
  parser: DocumentParserKind;
  mime: string;
  extensions: string[];
  /** Formats with a real parser in this repository. */
  supported: boolean;
  /** How the content can be read when native parsing is insufficient. */
  ocr: boolean;
  vision: boolean;
  tables: boolean;
};

export const DOCUMENT_FORMATS: Record<DocumentFormatId, DocumentFormatInfo> = {
  PDF: {
    id: "PDF",
    label: "PDF",
    parser: "pdf",
    mime: "application/pdf",
    extensions: [".pdf"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  DOCX: {
    id: "DOCX",
    label: "Word document",
    parser: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  DOC: {
    id: "DOC",
    label: "Legacy Word document",
    parser: "unsupported",
    mime: "application/msword",
    extensions: [".doc"],
    supported: false,
    ocr: false,
    vision: false,
    tables: false,
  },
  XLSX: {
    id: "XLSX",
    label: "Excel workbook",
    parser: "excel",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  XLS: {
    id: "XLS",
    label: "Legacy Excel workbook",
    parser: "unsupported",
    mime: "application/vnd.ms-excel",
    extensions: [".xls", ".xlsb"],
    supported: false,
    ocr: false,
    vision: false,
    tables: false,
  },
  CSV: {
    id: "CSV",
    label: "CSV spreadsheet",
    parser: "csv",
    mime: "text/csv",
    extensions: [".csv"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  TSV: {
    id: "TSV",
    label: "Tab-separated spreadsheet",
    parser: "csv",
    mime: "text/tab-separated-values",
    extensions: [".tsv", ".tab"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  TXT: {
    id: "TXT",
    label: "Plain text",
    parser: "text",
    mime: "text/plain",
    extensions: [".txt", ".text", ".log", ".md"],
    supported: true,
    ocr: false,
    vision: false,
    tables: false,
  },
  RTF: {
    id: "RTF",
    label: "Rich text",
    parser: "rtf",
    mime: "application/rtf",
    extensions: [".rtf"],
    supported: true,
    ocr: false,
    vision: false,
    tables: false,
  },
  HTML: {
    id: "HTML",
    label: "HTML document",
    parser: "html",
    mime: "text/html",
    extensions: [".html", ".htm", ".xhtml"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  EML: {
    id: "EML",
    label: "Email message",
    parser: "eml",
    mime: "message/rfc822",
    extensions: [".eml"],
    supported: true,
    ocr: false,
    vision: false,
    tables: false,
  },
  MSG: {
    id: "MSG",
    label: "Outlook message",
    parser: "unsupported",
    mime: "application/vnd.ms-outlook",
    extensions: [".msg"],
    supported: false,
    ocr: false,
    vision: false,
    tables: false,
  },
  PPTX: {
    id: "PPTX",
    label: "PowerPoint presentation",
    parser: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    supported: true,
    ocr: false,
    vision: false,
    tables: true,
  },
  PPT: {
    id: "PPT",
    label: "Legacy PowerPoint presentation",
    parser: "unsupported",
    mime: "application/vnd.ms-powerpoint",
    extensions: [".ppt"],
    supported: false,
    ocr: false,
    vision: false,
    tables: false,
  },
  JPEG: {
    id: "JPEG",
    label: "JPEG image",
    parser: "image",
    mime: "image/jpeg",
    extensions: [".jpg", ".jpeg", ".jpe", ".jfif"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  PNG: {
    id: "PNG",
    label: "PNG image",
    parser: "image",
    mime: "image/png",
    extensions: [".png"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  WEBP: {
    id: "WEBP",
    label: "WebP image",
    parser: "image",
    mime: "image/webp",
    extensions: [".webp"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  HEIC: {
    id: "HEIC",
    label: "HEIC/HEIF image",
    parser: "image",
    mime: "image/heic",
    extensions: [".heic", ".heif"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  TIFF: {
    id: "TIFF",
    label: "TIFF image",
    parser: "image",
    mime: "image/tiff",
    extensions: [".tif", ".tiff"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  BMP: {
    id: "BMP",
    label: "Bitmap image",
    parser: "image",
    mime: "image/bmp",
    extensions: [".bmp", ".dib"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  GIF: {
    id: "GIF",
    label: "GIF image",
    parser: "image",
    mime: "image/gif",
    extensions: [".gif"],
    supported: true,
    ocr: true,
    vision: true,
    tables: false,
  },
  ZIP: {
    id: "ZIP",
    label: "ZIP archive",
    parser: "zip",
    mime: "application/zip",
    extensions: [".zip"],
    supported: true,
    ocr: false,
    vision: false,
    tables: false,
  },
  UNKNOWN: {
    id: "UNKNOWN",
    label: "Unsupported file",
    parser: "unsupported",
    mime: "application/octet-stream",
    extensions: [],
    supported: false,
    ocr: false,
    vision: false,
    tables: false,
  },
};

export type FormatDetection = {
  format: DocumentFormatId;
  info: DocumentFormatInfo;
  mime: string;
  extension: string;
  extensionMismatch: boolean;
  declaredMimeMismatch: boolean;
  encrypted: boolean;
  /** A safe, non-technical explanation used in the review screen. */
  note: string | null;
};

const ZIP_MARKERS: Array<[string, DocumentFormatId]> = [
  ["word/document.xml", "DOCX"],
  ["xl/workbook.xml", "XLSX"],
  ["ppt/presentation.xml", "PPTX"],
];

const OLE_MARKERS: Array<[RegExp, DocumentFormatId]> = [
  [/WordDocument/i, "DOC"],
  [/PowerPoint Document/i, "PPT"],
  [/Workbook|Book/i, "XLS"],
  [/__substg1\.0_|IPM\.Note/i, "MSG"],
];

function extensionOf(filename: string): string {
  return path.extname(filename || "").toLowerCase().slice(0, 12);
}

function isKnownExtension(extension: string): boolean {
  if (!extension) return false;
  return Object.values(DOCUMENT_FORMATS).some((format) => format.extensions.includes(extension));
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.length === 0) return false;
  if (sample.includes(0)) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable += 1;
  }
  return printable / sample.length > 0.9;
}

function zipFormat(buffer: Buffer): DocumentFormatId {
  // Central-directory names are readable without inflating anything. Look at
  // the tail first because the central directory is at the end of the archive.
  const tail = buffer.subarray(Math.max(0, buffer.length - 256 * 1024)).toString("latin1");
  for (const [marker, format] of ZIP_MARKERS) {
    if (tail.includes(marker)) return format;
  }
  return "ZIP";
}

function oleFormat(buffer: Buffer): DocumentFormatId {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024)).toString("latin1");
  for (const [marker, format] of OLE_MARKERS) {
    if (marker.test(sample)) return format;
  }
  return "UNKNOWN";
}

function detectTextFormat(text: string, extension: string): DocumentFormatId {
  const head = text.slice(0, 8192).replace(/^\uFEFF/, "").trimStart();
  if (/^\{\\rtf\d/i.test(head)) return "RTF";
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(head) || /<html[\s>]/i.test(head.slice(0, 4096))) {
    return "HTML";
  }
  // EML is text, but its header block is unambiguous enough to parse safely.
  const headerBlock = head.split(/\r?\n\r?\n/)[0] ?? "";
  const headerNames = new Set(
    [...headerBlock.matchAll(/^([A-Za-z][A-Za-z0-9-]{1,40}):/gm)].map((match) => match[1].toLowerCase()),
  );
  if (
    (extension === ".eml" && headerNames.size >= 2) ||
    (headerNames.has("mime-version") && headerNames.has("content-type")) ||
    (headerNames.has("from") && headerNames.has("subject") && headerNames.has("date") && headerNames.size >= 4)
  ) {
    return "EML";
  }
  if (extension === ".tsv" || extension === ".tab") return "TSV";
  if (extension === ".csv") return "CSV";
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 20);
  if (lines.length >= 2) {
    const tabs = lines.map((line) => (line.match(/\t/g) ?? []).length);
    if (tabs.every((count) => count > 0) && tabs[0] >= 1) return "TSV";
    const commas = lines.map((line) => (line.match(/,/g) ?? []).length);
    if (commas.every((count) => count > 0) && commas[0] >= 1) return "CSV";
  }
  return "TXT";
}

/**
 * Detects the real format from bytes. `filename` and `declaredMime` are hints
 * only and are used to report a mismatch, never to choose the parser.
 */
export function detectDocumentFormat(
  buffer: Buffer,
  filename = "",
  declaredMime?: string | null,
): FormatDetection {
  const head = buffer.subarray(0, 64);
  const extension = extensionOf(filename);
  let format: DocumentFormatId = "UNKNOWN";
  let encrypted = false;

  if (head.subarray(0, 5).toString("latin1") === "%PDF-") {
    format = "PDF";
    // An encrypted PDF can still begin with %PDF-. Do not attempt to guess a
    // password; surface the state clearly to the owner.
    encrypted = /\/Encrypt\b/.test(
      buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024)).toString("latin1"),
    );
  } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    format = "JPEG";
  } else if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    format = "PNG";
  } else if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    format = "WEBP";
  } else if (head.subarray(0, 4).toString("latin1") === "II*\u0000" || head.subarray(0, 4).toString("latin1") === "MM\u0000*") {
    format = "TIFF";
  } else if (head.subarray(0, 2).toString("latin1") === "BM") {
    format = "BMP";
  } else if (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a") {
    format = "GIF";
  } else if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    format = zipFormat(buffer);
  } else if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    format = oleFormat(buffer);
    encrypted = /EncryptedPackage/i.test(
      buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024)).toString("latin1"),
    );
  } else {
    const brand = head.subarray(4, 12).toString("latin1");
    if (brand.includes("ftyphei") || brand.includes("ftypmif1") || brand.includes("ftypmsf1")) {
      format = "HEIC";
    } else if (looksLikeText(buffer)) {
      format = detectTextFormat(buffer.toString("utf8"), extension);
    }
  }

  // OLE containers cannot distinguish DOC/XLS/PPT/MSG reliably from the header
  // alone when the directory names are compressed; the extension is a safe hint
  // for the unsupported-file message, never for selecting a parser.
  if (format === "UNKNOWN" && ["DOC", "XLS", "PPT", "MSG"].includes(extensionToFormat(extension))) {
    format = extensionToFormat(extension);
  }

  const info = DOCUMENT_FORMATS[format];
  const supportedExtensions = info.extensions;
  const extensionIsKnown = isKnownExtension(extension);
  const extensionMismatch =
    Boolean(extension) &&
    extensionIsKnown &&
    supportedExtensions.length > 0 &&
    !supportedExtensions.includes(extension);

  const declared = (declaredMime ?? "").trim().toLowerCase();
  const declaredMimeMismatch =
    Boolean(declared) &&
    !declared.startsWith("application/octet-stream") &&
    !info.mime.startsWith(declared) &&
    !declared.startsWith(info.mime) &&
    // CSV/TSV/plain text are often all declared as text/plain by mail clients.
    !(declared === "text/plain" && ["TXT", "CSV", "TSV"].includes(format));

  let note: string | null = null;
  if (encrypted) note = "This file is password-protected or encrypted. Nothing was guessed; provide an unlocked copy.";
  else if (!info.supported) note = unsupportedFormatNote(format);
  else if (extensionMismatch) {
    note = `The filename extension ${extension} does not match the actual ${info.label} content. The content was read as ${info.label}.`;
  }

  return {
    format,
    info,
    mime: info.mime,
    extension,
    extensionMismatch,
    declaredMimeMismatch,
    encrypted,
    note,
  };
}

function extensionToFormat(extension: string): DocumentFormatId {
  for (const format of Object.values(DOCUMENT_FORMATS)) {
    if (format.extensions.includes(extension)) return format.id;
  }
  return "UNKNOWN";
}

export function unsupportedFormatNote(format: DocumentFormatId): string {
  switch (format) {
    case "DOC":
      return "Legacy .doc files are not parsed. The original file is kept; ask the sender for a .docx or PDF copy, or open it and save it as PDF.";
    case "XLS":
      return "Legacy .xls/.xlsb workbooks are not parsed. The original file is kept; save it as .xlsx or .csv and upload it again.";
    case "PPT":
      return "Legacy .ppt presentations are not parsed. The original file is kept; save it as .pptx or PDF and upload it again.";
    case "MSG":
      return "Outlook .msg files are not parsed on this server. The original file is kept; export the message as .eml or PDF and upload it again.";
    default:
      return "This is not a supported document type for automatic reading. The original file is kept for review; ask the sender for a PDF copy.";
  }
}

/** Formats with a real parser in this repository. */
export function supportedDocumentFormats(): DocumentFormatInfo[] {
  return Object.values(DOCUMENT_FORMATS).filter((format) => format.supported);
}

/** A short, accurate list for error messages and settings screens. */
export function supportedFormatList(): string {
  return supportedDocumentFormats()
    .map((format) => format.label)
    .join(", ");
}
