import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { loadExcelJs } from "../src/lib/exceljs";
import { extractDocument } from "../src/lib/intake/documents";

describe("document parsers: docx and zip", () => {
  it("extracts text from a .docx", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>RFQ for 2 inch ANSI 150 carbon steel flanges</w:t></w:r></w:p>
          <w:p><w:r><w:t>Quantity 10 pieces, NACE MR0175 required</w:t></w:r></w:p>
        </w:body>
      </w:document>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(buffer, "rfq.docx");
    expect(result.unreadable).toBe(false);
    expect(result.text).toContain("RFQ for 2 inch ANSI 150 carbon steel flanges");
    expect(result.text).toContain("NACE MR0175");
  });

  it("reads a valid workbook whose SpreadsheetML elements are namespace-prefixed", async () => {
    const ExcelJS = await loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("RFQ");
    sheet.addRow(["Description", "Qty"]);
    sheet.addRow(["SS316 elbow 1 inch", 10]);

    const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
    for (const name of ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/sharedStrings.xml"]) {
      const entry = zip.file(name);
      if (!entry) continue;
      let xml = await entry.async("string");
      xml = xml.replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, "<$1x:$2");
      xml = xml.replace(/<x:([A-Za-z_][\w.-]*)([^>]*?)xmlns="([^"]+)"/, '<x:$1$2xmlns:x="$3"');
      zip.file(name, xml);
    }

    const doc = await extractDocument(await zip.generateAsync({ type: "nodebuffer" }), "prefixed.xlsx");
    expect(doc.unreadable).toBe(false);
    expect(doc.text).toContain("SS316 elbow 1 inch");
  });

  it("does not crash on a corrupt .docx", async () => {
    const result = await extractDocument(Buffer.from("not a zip"), "bad.docx");
    expect(result).toBeDefined();
  });

  it("extracts text files from a .zip archive", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "Supplier quote: 10 pcs flanges at AED 45 each");
    zip.file("data.csv", "item,qty,price\nflange,10,45");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(buffer, "bundle.zip");
    expect(result.unreadable).toBe(false);
    expect(result.text).toContain("Supplier quote");
    expect(result.text).toContain("flange,10,45");
  });

  it("rejects archive path traversal", async () => {
    const zip = new JSZip();
    zip.file("../evil.txt", "should not be extracted");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(buffer, "traversal.zip");
    expect(result.unreadable).toBe(true);
    expect(result.note).toMatch(/unsafe entry path/i);
  });

  it("rejects archives exceeding entry count", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 205; i += 1) zip.file(`f${i}.txt`, "x");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(buffer, "big.zip");
    expect(result.unreadable).toBe(true);
    expect(result.note).toMatch(/above the safe limit/i);
  });

  it("rejects a zip bomb by its declared uncompressed size before inflating it", async () => {
    const zip = new JSZip();
    zip.file("huge.txt", "x".repeat(21 * 1024 * 1024));
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(buffer.length).toBeLessThan(1024 * 1024);
    const result = await extractDocument(buffer, "bomb.zip");
    expect(result.unreadable).toBe(true);
    expect(result.note).toMatch(/safe per-entry limit|decompressed size/i);
    expect(result.text).toBe("");
  });

  it("treats a MIME/extension mismatch as untrusted content, not as the claimed type", async () => {
    const result = await extractDocument(Buffer.from("description,qty\nflange,10"), "quote.pdf");
    expect(result.text).toContain("flange");
    expect(result.text).toContain("10 pcs");
    expect(result.status).not.toBe("FAILED");
  });

  it("fails a legacy .xls visibly with re-save instructions", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const result = await extractDocument(ole, "legacy.xls");
    expect(result.unreadable).toBe(true);
    expect(result.note).toMatch(/\.xls|save it as/i);
  });
});