import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { detectDocumentFormat } from "@/lib/intake/formats";
import { analyzeDocument } from "@/lib/intake/documentIntelligence";
import { processDocumentPackage } from "@/lib/intake/documentPackage";
import { saveAttachmentForOrganization } from "@/lib/storage";
import { extractEnquiryById } from "@/lib/workflow/enquiry";

function makeTextPdf(pages: string[]): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    pages.forEach((text, index) => {
      if (index > 0) doc.addPage();
      doc.text(text);
    });
    doc.end();
  });
}

function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:tbl>
      <a:tr><a:tc><a:t>Description</a:t></a:tc><a:tc><a:t>Quantity</a:t></a:tc><a:tc><a:t>Unit</a:t></a:tc></a:tr>
      <a:tr><a:tc><a:t>Gate valve SS316 Class 150</a:t></a:tc><a:tc><a:t>12</a:t></a:tc><a:tc><a:t>pcs</a:t></a:tc></a:tr>
    </a:tbl><a:p><a:r><a:t>Valve price list</a:t></a:r></a:p></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function makeEml(): string {
  return [
    "From: Sales <sales@supplier.example>",
    "To: buyer@mfbmt.example",
    "Subject: Quotation",
    "Date: Tue, 25 Nov 2026 10:00:00 +0400",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUNDARY-1"',
    "",
    "--BOUNDARY-1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please find the attached item list.",
    "--BOUNDARY-1",
    'Content-Type: text/csv; name="items.csv"',
    "Content-Disposition: attachment; filename=\"items.csv\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Description,Qty,Unit\nGate valve,10,pcs\n").toString("base64"),
    "--BOUNDARY-1--",
    "",
  ].join("\r\n");
}

describe("document intelligence: format detection and parsers", () => {
  it("detects real content rather than trusting a misleading extension", async () => {
    const pdf = await makeTextPdf(["Real PDF inside a text filename"]);
    const detection = detectDocumentFormat(pdf, "quote.txt", "text/plain");
    expect(detection.format).toBe("PDF");
    expect(detection.extensionMismatch).toBe(true);

    const parsed = await analyzeDocument(pdf, "quote.txt", { declaredMime: "text/plain" });
    expect(parsed.format).toBe("PDF");
    expect(parsed.text).toContain("Real PDF");
    expect(parsed.quality.status).toBe("GOOD");
  });

  it("reads PPTX slide text and table rows", async () => {
    const buffer = await makePptx();
    const parsed = await analyzeDocument(buffer, "valves.pptx");
    expect(parsed.format).toBe("PPTX");
    expect(parsed.text).toContain("Gate valve SS316 Class 150");
    expect(parsed.tables?.length).toBe(1);
    expect(parsed.tables?.[0].rows[0].cells).toContain("12");
    expect(parsed.processingStatus).toBe("COMPLETED");
  });

  it("reads HTML body text and preserves a table", async () => {
    const html = `<html><head><title>Price list</title><script>alert("x")</script></head>
      <body><h1>Valves</h1><table><tr><th>Description</th><th>Qty</th></tr>
      <tr><td>Gate valve</td><td>10</td></tr></table></body></html>`;
    const parsed = await analyzeDocument(Buffer.from(html), "list.html");
    expect(parsed.format).toBe("HTML");
    expect(parsed.text).toContain("Valves");
    expect(parsed.text).not.toContain("alert");
    expect(parsed.tables?.[0].header).toEqual(["Description", "Qty"]);
    expect(parsed.tables?.[0].rows[0].cells).toEqual(["Gate valve", "10"]);
  });

  it("reads RTF text without executing control content", async () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0\fs20 Quotation for 10 gate valves\par Delivery: 2 weeks\par}`;
    const parsed = await analyzeDocument(Buffer.from(rtf), "quote.rtf");
    expect(parsed.format).toBe("RTF");
    expect(parsed.text).toContain("Quotation for 10 gate valves");
    expect(parsed.text).toContain("Delivery: 2 weeks");
    expect(parsed.text).not.toContain("fonttbl");
  });

  it("reads an EML body and a supported attachment", async () => {
    const parsed = await analyzeDocument(Buffer.from(makeEml()), "reply.eml");
    expect(parsed.format).toBe("EML");
    expect(parsed.text).toContain("Please find the attached item list.");
    expect(parsed.text).toContain("Gate valve");
    expect(parsed.metadata?.attachments).toContain("items.csv");
  });

  it("identifies TIFF content and keeps it for visual review when OCR is off", async () => {
    const detection = detectDocumentFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]), "scan.tif");
    expect(detection.format).toBe("TIFF");
    const parsed = await analyzeDocument(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]), "scan.tif");
    expect(parsed.format).toBe("TIFF");
    expect(parsed.processingStatus).toBe("NEEDS_REVIEW");
    expect(parsed.unreadable).toBe(true);
  });

  it("reports a password-protected PDF without guessing content", async () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n%%EOF");
    const parsed = await analyzeDocument(pdf, "locked.pdf");
    expect(parsed.processingStatus).toBe("PASSWORD_PROTECTED");
    expect(parsed.text).toBe("");
    expect(parsed.note).toMatch(/password-protected/i);
  });

  it("reads a PDF nested inside a ZIP instead of skipping it", async () => {
    const zip = new JSZip();
    zip.file("quote.pdf", await makeTextPdf(["Nested PDF with 5 pcs stainless elbows"]));
    zip.file("notes.txt", "Delivery to Dubai");
    const parsed = await analyzeDocument(await zip.generateAsync({ type: "nodebuffer" }), "bundle.zip");
    expect(parsed.text).toContain("Nested PDF with 5 pcs stainless elbows");
    expect(parsed.text).toContain("Delivery to Dubai");
    expect(parsed.tables).toEqual([]);
  });

  it("flags garbled text as a quality caveat rather than a success", async () => {
    const parsed = await analyzeDocument(
      Buffer.from("Ã©Ã©Ã©Ã©Ã©Ã©Ã©Ã©Ã©Ã©\nÃ©Ã©Ã©Ã©Ã©Ã©Ã©Ã©Ã©Ã©\nÃ©Ã©Ã©"),
      "broken.txt",
    );
    expect(parsed.quality.issues.some((issue) => issue.code === "GARBLED_TEXT")).toBe(true);
    expect(parsed.processingStatus).toBe("PARTIAL");
  });
});

describe("document packages", () => {
  it("records a package, detects duplicate bytes, and accepts unsupported originals", async () => {
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `DOC-${randomUUID().slice(0, 8)}`,
        channel: "MANUAL",
        rawText: "10 pcs gate valve",
        status: "READY",
      },
    });
    const orgId = enquiry.organizationId;
    const csv = Buffer.from("Description,Qty,Unit\nGate valve,10,pcs\n");
    const legacy = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

    const storedCsv = await saveAttachmentForOrganization(csv, "items.csv", orgId);
    const storedCsv2 = await saveAttachmentForOrganization(csv, "copy.csv", orgId);
    const storedLegacy = await saveAttachmentForOrganization(legacy, "legacy.xls", orgId);

    const makeAttachment = async (stored: Awaited<ReturnType<typeof saveAttachmentForOrganization>>, filename: string) =>
      db.attachment.create({
        data: {
          enquiryId: enquiry.id,
          filename,
          storedName: stored.storedName,
          mimeType: filename.endsWith(".csv") ? "text/csv" : "application/vnd.ms-excel",
          detectedMime: null,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storagePath: stored.storagePath,
        },
      });

    const first = await makeAttachment(storedCsv, "items.csv");
    const duplicate = await makeAttachment(storedCsv2, "copy.csv");
    const legacyAttachment = await makeAttachment(storedLegacy, "legacy.xls");

    const result = await processDocumentPackage({
      key: `test:${enquiry.id}`,
      enquiryId: enquiry.id,
      attachments: [
        { id: first.id, filename: first.filename, mimeType: first.mimeType, storagePath: first.storagePath, sha256: first.sha256 },
        { id: duplicate.id, filename: duplicate.filename, mimeType: duplicate.mimeType, storagePath: duplicate.storagePath, sha256: duplicate.sha256 },
        { id: legacyAttachment.id, filename: legacyAttachment.filename, mimeType: legacyAttachment.mimeType, storagePath: legacyAttachment.storagePath, sha256: legacyAttachment.sha256 },
      ],
    });

    expect(result.summary.attachmentCount).toBe(3);
    expect(result.summary.formats.some((entry) => entry.format === "CSV")).toBe(true);
    expect(result.summary.duplicates).toHaveLength(1);
    expect(result.summary.unsupportedCount).toBe(1);
    expect(result.summary.status).toBe("PARTIAL");
    expect(result.summary.tablesExtracted).toBeGreaterThan(0);

    const persisted = await db.attachment.findUniqueOrThrow({ where: { id: first.id } });
    expect(persisted.processingStatus).toBe("COMPLETED");
    expect(persisted.tablesJson).toContain("Gate valve");
    const failed = await db.attachment.findUniqueOrThrow({ where: { id: legacyAttachment.id } });
    expect(failed.processingStatus).toBe("UNSUPPORTED");
    expect(failed.textExtract).toBe("");
    expect(failed.failureMessage ?? "").toMatch(/older|legacy|not a supported/i);

    const pkg = await db.documentPackage.findFirstOrThrow({ where: { key: `test:${enquiry.id}` } });
    expect(pkg.status).toBe("PARTIAL");
  });

  it("processes a customer PDF and CSV together without losing either source", async () => {
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `MIX-${randomUUID().slice(0, 8)}`,
        channel: "MANUAL",
        rawText: "Please quote the attached items.",
        status: "EXTRACTING",
      },
    });
    const orgId = enquiry.organizationId;
    const pdf = await makeTextPdf(["20 pcs long radius elbow ASTM A234 WPB"]);
    const csv = Buffer.from("Description,Qty,Unit\n10 pcs gate valve SS316 Class 150,10,pcs\n");
    for (const [buffer, filename, mimeType] of [
      [pdf, "request.pdf", "application/pdf"],
      [csv, "quantities.csv", "text/csv"],
    ] as Array<[Buffer, string, string]>) {
      const stored = await saveAttachmentForOrganization(buffer, filename, orgId);
      await db.attachment.create({
        data: {
          enquiryId: enquiry.id,
          filename,
          storedName: stored.storedName,
          mimeType,
          detectedMime: mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storagePath: stored.storagePath,
        },
      });
    }

    const result = await extractEnquiryById(enquiry.id);
    expect(result.items).toBeGreaterThanOrEqual(2);
    const items = await db.enquiryItem.findMany({ where: { enquiryId: enquiry.id } });
    expect(items.some((item) => /elbow/i.test(item.description))).toBe(true);
    expect(items.some((item) => /gate valve/i.test(item.description))).toBe(true);

    const pkg = await db.documentPackage.findFirstOrThrow({ where: { enquiryId: enquiry.id } });
    expect(pkg.summaryJson).toContain("\"formats\"");
    expect(pkg.summaryJson).toContain("PDF");
    expect(pkg.summaryJson).toContain("CSV");
  });
});
