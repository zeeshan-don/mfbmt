import PDFDocument from "pdfkit";

type Org = {
  name: string;
  legalName?: string | null;
  taxRegistrationNumber?: string | null;
  /** Short brand line shown above the company name. Defaults to the name. */
  brandLabel?: string | null;
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
    countryOfOrigin?: string | null;
    certification?: string | null;
    leadTimeDays?: number | null;
    deliveryTerms?: string | null;
    validityDate?: Date | null;
    technicalNotes?: string | null;
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

      doc
        .fillColor(ACCENT)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text((org.brandLabel || org.name).slice(0, 60), { continued: false });
      doc.moveDown(0.2);
      doc.fillColor(INK).fontSize(16).font("Helvetica-Bold").text(org.name);
      if (org.legalName && org.legalName !== org.name) {
        doc.fontSize(8.5).font("Helvetica").fillColor(MUTED).text(org.legalName);
      }
      const contact = [org.address, org.phone, org.email, org.taxRegistrationNumber ? `TRN: ${org.taxRegistrationNumber}` : null]
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

      // Fixed widths keep the money columns from overlapping on A4. The amount
      // column ends exactly at the right margin.
      const left = doc.page.margins.left;
      const descriptionWidth = 245;
      const qtyWidth = 42;
      const unitWidth = 32;
      const unitPriceWidth = 82;
      const amountWidth = pageWidth - descriptionWidth - qtyWidth - unitWidth - unitPriceWidth - 18;
      const columns = {
        item: left,
        qty: left + descriptionWidth + 4,
        unit: left + descriptionWidth + qtyWidth + 8,
        unitPrice: left + descriptionWidth + qtyWidth + unitWidth + 14,
        total: left + descriptionWidth + qtyWidth + unitWidth + unitPriceWidth + 18,
      };

      let y = tableTop + 10;
      doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Bold");
      doc.text("DESCRIPTION", columns.item, y, { width: descriptionWidth });
      doc.text("QTY", columns.qty, y, { width: qtyWidth, align: "right" });
      doc.text("UNIT", columns.unit, y, { width: unitWidth });
      doc.text("UNIT PRICE", columns.unitPrice, y, { width: unitPriceWidth, align: "right" });
      doc.text("AMOUNT", columns.total, y, { width: amountWidth, align: "right" });
      y += 16;

      for (const item of quotation.items) {
        if (y > doc.page.height - 160) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + pageWidth, y).lineWidth(0.4).strokeColor(LINE).stroke();
        y += 6;
        doc.fillColor(INK).fontSize(8.5).font("Helvetica-Bold").text(item.description.slice(0, 120), columns.item, y, {
          width: descriptionWidth,
        });
        const itemHeight = doc.heightOfString(item.description.slice(0, 120), { width: descriptionWidth });
        let specHeight = 0;
        const detail = [
          item.specs && item.specs !== item.description ? item.specs.slice(0, 220) : null,
          item.countryOfOrigin ? `Origin: ${item.countryOfOrigin}` : null,
          item.certification ? `Certification: ${item.certification}` : null,
          item.leadTimeDays != null ? `Lead time: ${item.leadTimeDays} days` : null,
          item.deliveryTerms ? `Delivery: ${item.deliveryTerms}` : null,
          item.validityDate ? `Line valid to: ${prettyDate(item.validityDate)}` : null,
          item.technicalNotes ? item.technicalNotes.slice(0, 160) : null,
        ].filter(Boolean).join(" · ");
        if (detail) {
          doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
          doc.text(detail, columns.item, y + itemHeight + 1, { width: descriptionWidth });
          specHeight = doc.heightOfString(detail, { width: descriptionWidth });
        }
        doc.fillColor(INK).fontSize(8.5).font("Helvetica");
        doc.text(String(item.quantity), columns.qty, y, { width: qtyWidth, align: "right" });
        doc.text(item.unit, columns.unit, y, { width: unitWidth });
        doc.text(fmt(item.unitPrice, quotation.currency), columns.unitPrice, y, { width: unitPriceWidth, align: "right" });
        doc.text(fmt(item.lineTotal, quotation.currency), columns.total, y, {
          width: amountWidth,
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
      // Print tax whenever the quotation actually contains tax, even if the
      // organisation later turns the setting off. Otherwise the total would not
      // reconcile with the subtotal.
      if (quotation.taxAmount > 0) {
        doc.text(org.taxLabel || "Tax", totalsX, y, { width: totalsWidth * 0.5 });
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
        // Keep the footer inside the bottom margin and disable wrapping: text
        // below the margin makes PDFKit add a blank page.
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(
          `${org.name} · ${quotation.quoteNumber} · Page ${i + 1} of ${pages.count}`,
          doc.page.margins.left,
          doc.page.height - 64,
          { width: pageWidth, align: "center", lineBreak: false },
        );
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
