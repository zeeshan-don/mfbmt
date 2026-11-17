import PDFDocument from "pdfkit";

type Org = {
  name: string;
  legalName?: string | null;
  trn?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxLabel: string;
  taxEnabled: boolean;
};

type Quotation = {
  quoteNumber: string;
  date: Date;
  validityDate: Date | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  currency: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  terms?: string | null;
  notes?: string | null;
  items: Array<{
    description: string;
    specs?: string | null;
    quantity: number;
    unit: string;
    unitPrice: number;
    lineTotal: number;
  }>;
};

const INK = "#0f172a";
const MUTED = "#475569";
const LINE = "#cbd5e1";
const ACCENT = "#1d4ed8";

function fmt(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function prettyDate(date: Date | null): string {
  if (!date) return "—";
  return date.toISOString().slice(0, 10);
}

export async function generateQuotationPdf(input: { org: Org; quotation: Quotation }): Promise<Buffer> {
  const { org, quotation } = input;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      doc.fillColor(ACCENT).fontSize(9).font("Helvetica-Bold").text("MFBMT", { continued: false });
      doc.moveDown(0.2);
      doc.fillColor(INK).fontSize(16).font("Helvetica-Bold").text(org.name);
      if (org.legalName && org.legalName !== org.name) {
        doc.fontSize(8.5).font("Helvetica").fillColor(MUTED).text(org.legalName);
      }
      const contact = [org.address, org.phone, org.email, org.trn ? `TRN: ${org.trn}` : null]
        .filter(Boolean)
        .join("  ·  ");
      doc.fontSize(8.5).fillColor(MUTED).text(contact, { width: pageWidth * 0.62 });

      doc.moveUp(4);
      doc.fontSize(14).font("Helvetica-Bold").fillColor(INK).text("QUOTATION", {
        align: "right",
      });
      doc.fontSize(8.5).font("Helvetica").fillColor(MUTED);
      doc.text(`No. ${quotation.quoteNumber}`, { align: "right" });
      doc.text(`Date: ${prettyDate(quotation.date)}`, { align: "right" });
      doc.text(`Valid until: ${prettyDate(quotation.validityDate)}`, { align: "right" });

      doc.moveDown(1.2);
      const topY = doc.y;
      doc.fillColor(MUTED).fontSize(8).text("QUOTATION FOR", doc.page.margins.left, topY);
      doc.fillColor(INK).fontSize(10).font("Helvetica-Bold").text(quotation.customerName, doc.page.margins.left, topY + 12);
      doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
      if (quotation.customerPhone) doc.text(quotation.customerPhone, doc.page.margins.left, topY + 26);
      if (quotation.customerEmail) doc.text(quotation.customerEmail, doc.page.margins.left, topY + (quotation.customerPhone ? 38 : 26));

      const tableTop = topY + 70;
      doc.moveTo(doc.page.margins.left, tableTop).lineTo(doc.page.margins.left + pageWidth, tableTop).lineWidth(0.8).strokeColor(LINE).stroke();

      const columns = {
        item: doc.page.margins.left,
        qty: doc.page.margins.left + pageWidth * 0.58,
        unit: doc.page.margins.left + pageWidth * 0.7,
        unitPrice: doc.page.margins.left + pageWidth * 0.78,
        total: doc.page.margins.left + pageWidth * 0.9,
      };

      let y = tableTop + 10;
      doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Bold");
      doc.text("DESCRIPTION", columns.item, y);
      doc.text("QTY", columns.qty, y, { width: 40, align: "right" });
      doc.text("UNIT", columns.unit, y, { width: 40 });
      doc.text("UNIT PRICE", columns.unitPrice, y, { width: 70, align: "right" });
      doc.text("AMOUNT", columns.total, y, { width: pageWidth - (columns.total - doc.page.margins.left), align: "right" });
      y += 16;

      for (const item of quotation.items) {
        if (y > doc.page.height - 160) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + pageWidth, y).lineWidth(0.4).strokeColor(LINE).stroke();
        y += 6;
        doc.fillColor(INK).fontSize(9).font("Helvetica-Bold").text(item.description.slice(0, 120), columns.item, y, {
          width: pageWidth * 0.55,
        });
        const itemHeight = doc.heightOfString(item.description.slice(0, 120), { width: pageWidth * 0.55 });
        let specHeight = 0;
        if (item.specs && item.specs !== item.description) {
          doc.font("Helvetica").fontSize(7.8).fillColor(MUTED);
          const specs = item.specs.slice(0, 220);
          doc.text(specs, columns.item, y + itemHeight + 1, { width: pageWidth * 0.55 });
          specHeight = doc.heightOfString(specs, { width: pageWidth * 0.55 });
        }
        doc.fillColor(INK).fontSize(9).font("Helvetica");
        doc.text(String(item.quantity), columns.qty, y, { width: 40, align: "right" });
        doc.text(item.unit, columns.unit, y, { width: 40 });
        doc.text(fmt(item.unitPrice, quotation.currency), columns.unitPrice, y, { width: 70, align: "right" });
        doc.text(fmt(item.lineTotal, quotation.currency), columns.total, y, {
          width: pageWidth - (columns.total - doc.page.margins.left),
          align: "right",
        });
        y += Math.max(22, itemHeight + specHeight + 12);
      }

      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + pageWidth, y).lineWidth(0.8).strokeColor(LINE).stroke();
      y += 12;

      const totalsX = doc.page.margins.left + pageWidth * 0.62;
      const totalsWidth = pageWidth * 0.38;
      doc.font("Helvetica").fontSize(9).fillColor(MUTED);
      doc.text("Subtotal", totalsX, y, { width: totalsWidth * 0.5 });
      doc.text(fmt(quotation.subtotal, quotation.currency), totalsX, y, { width: totalsWidth, align: "right" });
      y += 14;
      if (quotation.taxAmount > 0 && org.taxEnabled) {
        doc.text(org.taxLabel, totalsX, y, { width: totalsWidth * 0.5 });
        doc.text(fmt(quotation.taxAmount, quotation.currency), totalsX, y, { width: totalsWidth, align: "right" });
        y += 14;
      }
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
      doc.text("Total", totalsX, y, { width: totalsWidth * 0.5 });
      doc.text(fmt(quotation.total, quotation.currency), totalsX, y, { width: totalsWidth, align: "right" });
      y += 28;

      if (quotation.notes) {
        doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("Notes", doc.page.margins.left, y);
        doc.fillColor(INK).text(quotation.notes, doc.page.margins.left, y + 12, { width: pageWidth });
        y = doc.y + 10;
      }

      if (quotation.terms) {
        if (y > doc.page.height - 150) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED).text("TERMS", doc.page.margins.left, y);
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(quotation.terms, doc.page.margins.left, y + 12, {
          width: pageWidth,
        });
      }

      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i += 1) {
        doc.switchToPage(i);
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
          `${org.name} · ${quotation.quoteNumber} · Page ${i + 1} of ${pages.count}`,
          doc.page.margins.left,
          doc.page.height - 34,
          { width: pageWidth, align: "center" },
        );
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
