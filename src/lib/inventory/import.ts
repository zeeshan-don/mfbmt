import { db } from "../db";
import { sniffType } from "../storage";
import { normalizeGrade, normalizeMaterial, normalizePressure, normalizeSchedule, normalizeSize, normalizeUnit } from "../catalog/normalize";
import { inferCategoryFromDescription } from "../catalog/categories";

export const MAPPABLE_FIELDS = [
  { key: "sku", label: "Product code / SKU", required: false },
  { key: "name", label: "Product name", required: true },
  { key: "category", label: "Category", required: false },
  { key: "brand", label: "Brand", required: false },
  { key: "size", label: "Size", required: false },
  { key: "material", label: "Material", required: false },
  { key: "grade", label: "Grade", required: false },
  { key: "pressureRating", label: "Pressure rating", required: false },
  { key: "schedule", label: "Schedule", required: false },
  { key: "standard", label: "Standard", required: false },
  { key: "unit", label: "Unit", required: false },
  { key: "quantity", label: "Quantity on hand", required: true },
  { key: "reserved", label: "Reserved quantity", required: false },
  { key: "location", label: "Location", required: false },
] as const;

export type MappingField = (typeof MAPPABLE_FIELDS)[number]["key"];
export type ColumnMapping = Partial<Record<MappingField, number>>;

export type TabularData = { headers: string[]; rows: string[][]; sheetName: string };

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (obj.result != null) return String(obj.result);
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    if (obj.formula) return "";
    return "";
  }
  return String(value);
}

export async function readTabular(buffer: Buffer): Promise<TabularData> {
  const { family } = sniffType(buffer);
  if (family === "csv" || family === "text") {
    const { parse } = await import("csv-parse/sync");
    const raw = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parse(raw, { relaxColumnCount: true, skipEmptyLines: true, bom: true }) as string[][];
    const normalized = rows.map((row) => row.map((cell) => String(cell ?? "").trim()));
    return { headers: normalized[0] ?? [], rows: normalized.slice(1), sheetName: "CSV" };
  }
  if (family === "excel") {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The spreadsheet has no worksheets.");
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => values.push(cellToString(cell.value).trim()));
      rows.push(values);
    });
    return { headers: rows[0] ?? [], rows: rows.slice(1), sheetName: sheet.name };
  }
  throw new Error("Upload an Excel (.xlsx) or CSV file for inventory import.");
}

const GUESS: Record<MappingField, RegExp> = {
  sku: /(sku|code|item ?code|part ?no|product ?code)/i,
  name: /(name|description|product|item|particular)/i,
  category: /(category|group|type)/i,
  brand: /(brand|make|manufacturer)/i,
  size: /(size|dimension|dia)/i,
  material: /(material)/i,
  grade: /(grade|class)/i,
  pressureRating: /(pressure|rating|pn)/i,
  schedule: /(schedule|sch)/i,
  standard: /(standard|spec)/i,
  unit: /(unit|uom)/i,
  quantity: /(qty|quantity|on ?hand|stock)/i,
  reserved: /(reserved|allocated)/i,
  location: /(location|warehouse|store|bin)/i,
};

export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  headers.forEach((header, index) => {
    for (const field of MAPPABLE_FIELDS) {
      if (mapping[field.key] != null) continue;
      if (GUESS[field.key].test(header)) mapping[field.key] = index;
    }
  });
  return mapping;
}

export type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
};

export async function importInventory(options: {
  rows: string[][];
  mapping: ColumnMapping;
  defaultLocationCode: string;
  defaultLocationName: string;
  userId: string;
}): Promise<ImportReport> {
  const { rows, mapping, userId } = options;
  if (mapping.name == null || mapping.quantity == null) {
    throw new Error("Map both the product name and quantity columns before importing.");
  }

  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const locations = new Map<string, string>();

  const getLocation = async (code: string, name: string) => {
    const key = code.trim().toUpperCase();
    const cached = locations.get(key);
    if (cached) return cached;
    const location = await db.inventoryLocation.upsert({
      where: { code: key },
      update: {},
      create: { code: key, name: name.trim() || key },
    });
    locations.set(key, location.id);
    return location.id;
  };

  const seenSkus = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;
    if (!row || row.every((cell) => !cell)) {
      report.skipped += 1;
      continue;
    }
    const pick = (field: MappingField) => {
      const col = mapping[field];
      if (col == null) return "";
      return (row[col] ?? "").toString().trim();
    };

    const name = pick("name");
    if (!name) {
      report.errors.push({ row: rowNumber, message: "Missing product name." });
      report.skipped += 1;
      continue;
    }
    const quantityRaw = pick("quantity").replace(/,/g, "");
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity < 0) {
      report.errors.push({ row: rowNumber, message: `Quantity "${pick("quantity")}" is not a valid number.` });
      report.skipped += 1;
      continue;
    }
    const reservedRaw = pick("reserved").replace(/,/g, "");
    const reserved = reservedRaw ? Number(reservedRaw) : 0;
    if (!Number.isFinite(reserved) || reserved < 0) {
      report.errors.push({ row: rowNumber, message: `Reserved quantity "${reservedRaw}" is not valid.` });
      report.skipped += 1;
      continue;
    }
    if (reserved > quantity) {
      report.errors.push({ row: rowNumber, message: "Reserved quantity is larger than the quantity on hand." });
      report.skipped += 1;
      continue;
    }

    const categoryName =
      inferCategoryFromDescription(pick("category") || name)?.name ||
      pick("category") ||
      "Other Industrial Supplies";

    let sku = pick("sku");
    if (!sku) sku = `IMP-${name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24)}`;
    if (seenSkus.has(sku)) {
      report.errors.push({ row: rowNumber, message: `Duplicate product code ${sku} in this file.` });
      report.skipped += 1;
      continue;
    }
    seenSkus.add(sku);

    const attributes = {
      name,
      category: categoryName,
      brand: pick("brand") || null,
      size: normalizeSize(pick("size")),
      material: normalizeMaterial(pick("material")),
      grade: normalizeGrade(pick("grade")),
      pressureRating: normalizePressure(pick("pressureRating")),
      schedule: normalizeSchedule(pick("schedule")),
      standard: pick("standard").toUpperCase() || null,
      unit: normalizeUnit(pick("unit")),
    };

    const existing = await db.product.findUnique({ where: { sku } });
    const product = existing
      ? await db.product.update({ where: { sku }, data: attributes })
      : await db.product.create({ data: { sku, ...attributes } });
    if (existing) report.updated += 1;
    else report.created += 1;

    const locationId = await getLocation(
      pick("location") || options.defaultLocationCode,
      pick("location") || options.defaultLocationName,
    );

    const previous = await db.inventoryStock.findUnique({
      where: { productId_locationId: { productId: product.id, locationId } },
    });
    await db.inventoryStock.upsert({
      where: { productId_locationId: { productId: product.id, locationId } },
      update: {
        quantityOnHand: quantity,
        quantityReserved: reserved,
        source: "IMPORT",
        lastUpdatedAt: new Date(),
      },
      create: {
        productId: product.id,
        locationId,
        quantityOnHand: quantity,
        quantityReserved: reserved,
        source: "IMPORT",
      },
    });
    const delta = quantity - (previous?.quantityOnHand ?? 0);
    if (delta !== 0 || !previous) {
      await db.inventoryMovement.create({
        data: {
          productId: product.id,
          locationId,
          delta,
          reason: "Inventory import",
          refType: "IMPORT",
          userId,
        },
      });
    }
  }

  return report;
}
