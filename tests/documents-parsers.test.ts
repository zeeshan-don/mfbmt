import { describe, expect, it } from "vitest";
import JSZip from "jszip";
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
});