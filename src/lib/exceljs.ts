import JSZip from "jszip";

/**
 * ExcelJS's normal package entrypoint pulls in `unzipper`, whose dependency
 * chain hits a `generator-function` module-sync export that Node cannot parse
 * (it fails with "Unexpected string"). The distributed bundle is the same
 * library, already includes its zip reader, and loads correctly on Node and
 * Vercel. Keep every Excel read behind this helper.
 */
export async function loadExcelJs() {
  const exceljs = await import("exceljs/dist/exceljs.min.js");
  return exceljs.default;
}

/**
 * Some valid producers prefix every SpreadsheetML element (for example
 * `<x:workbook>` and `<x:sheets>`). ExcelJS expects unprefixed element names
 * and throws while reading the workbook model. If the first load fails, strip
 * only element prefixes and retry; attribute names such as `r:id` are kept.
 */
export async function loadExcelWorkbook(buffer: Buffer): Promise<import("exceljs").Workbook> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return workbook;
  } catch (error) {
    const repaired = await stripElementPrefixes(buffer);
    if (!repaired) throw error;
    const retry = new ExcelJS.Workbook();
    await retry.xlsx.load(repaired as unknown as ArrayBuffer);
    return retry;
  }
}

const SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function stripSpreadsheetPrefixes(text: string): string {
  // Only remove prefixes bound to the SpreadsheetML namespace. Other namespaces
  // such as dc:creator in docProps must keep their prefixes for ExcelJS.
  const prefixes = new Set<string>();
  const declarations = /xmlns:([A-Za-z_][\w.-]*)="([^"]+)"/g;
  for (let match = declarations.exec(text); match; match = declarations.exec(text)) {
    if (match[2] === SPREADSHEETML_NAMESPACE) prefixes.add(match[1]);
  }
  let cleaned = text;
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`<(/?)${escaped}:`, "g"), "<$1");
  }
  return cleaned;
}

async function stripElementPrefixes(buffer: Buffer): Promise<Buffer | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    let changed = false;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir || !/\.xml$/i.test(name)) continue;
      const text = await entry.async("string");
      const cleaned = stripSpreadsheetPrefixes(text);
      if (cleaned !== text) {
        zip.file(name, cleaned);
        changed = true;
      }
    }
    if (!changed) return null;
    return await zip.generateAsync({ type: "nodebuffer" });
  } catch {
    return null;
  }
}
