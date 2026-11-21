import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer-facing Excel export. Supplier costs and margin are never included. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (user.role !== "OWNER" && !user.permissions.includes("quotations.view")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const { id } = await context.params;
  const quotation = await db.customerQuotation.findUnique({ where: { id }, include: { items: true } });
  if (!quotation) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!["APPROVED", "SENT"].includes(quotation.status)) {
    return NextResponse.json({ error: "Approve the quotation before exporting it." }, { status: 409 });
  }
  if (quotation.items.some((item) => item.unitPrice == null)) {
    return NextResponse.json({ error: "Every line must be priced before export." }, { status: 409 });
  }

  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Procurement Intelligence";
  const sheet = workbook.addWorksheet("Quotation");

  sheet.columns = [
    { header: "Description", key: "description", width: 42 },
    { header: "Specification", key: "specs", width: 34 },
    { header: "Country of origin", key: "origin", width: 17 },
    { header: "Certification", key: "certification", width: 20 },
    { header: "Lead time (days)", key: "lead", width: 14 },
    { header: "Delivery terms", key: "delivery", width: 20 },
    { header: "Line valid until", key: "validity", width: 16 },
    { header: "Qty", key: "quantity", width: 10 },
    { header: "Unit", key: "unit", width: 9 },
    { header: "Unit price", key: "unitPrice", width: 14 },
    { header: "Amount", key: "amount", width: 16 },
  ];

  sheet.spliceRows(1, 0, [`Quotation ${quotation.quoteNumber}`], [`Customer: ${quotation.customerName}`], [`Version: ${quotation.version}`], []);
  sheet.mergeCells("A1:K1");
  sheet.getCell("A1").font = { bold: true, size: 16 };
  sheet.getCell("A2").font = { bold: true };
  for (const item of quotation.items) {
    sheet.addRow({
      description: item.description,
      specs: item.specs ?? "",
      origin: item.countryOfOrigin ?? "",
      certification: item.certification ?? "",
      lead: item.leadTimeDays ?? "",
      delivery: item.deliveryTerms ?? "",
      validity: item.validityDate?.toISOString().slice(0, 10) ?? "",
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      amount: item.lineTotal,
    });
  }
  const headerRow = sheet.getRow(5);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  sheet.getColumn("unitPrice").numFmt = "#,##0.00";
  sheet.getColumn("amount").numFmt = "#,##0.00";
  sheet.addRow({});
  sheet.addRow({ description: "Subtotal", amount: quotation.subtotal });
  if (quotation.taxAmount > 0) sheet.addRow({ description: "Tax", amount: quotation.taxAmount });
  sheet.addRow({ description: "Total", amount: quotation.total }).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${quotation.quoteNumber}-v${quotation.version}.xlsx"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
