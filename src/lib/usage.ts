import PDFDocument from "pdfkit";
import { db } from "./db";
import { getRate } from "./costing/fx";
import { monthBounds } from "./limits";

export type MonthlyUsage = {
  month: string;
  enquiriesReceived: number;
  rfqsCreated: number;
  quotationsSent: number;
  searchQueries: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostUsd: number;
  aiCalls: number;
  fxRate: number | null;
  aiCostAed: number | null;
};

export async function getMonthlyUsage(month?: string): Promise<MonthlyUsage> {
  const { start, end, label } = monthBounds(month);
  const range = { gte: start, lt: end };
  const [enquiriesReceived, rfqsCreated, quotationsSent, searchQueries, ai, rate] = await Promise.all([
    db.enquiry.count({ where: { createdAt: range } }),
    db.supplierQuote.count({ where: { createdAt: range } }),
    db.customerQuotation.count({ where: { sentAt: range } }),
    db.searchQuery.count({ where: { createdAt: range } }),
    db.aiUsage.aggregate({
      where: { createdAt: range },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
    getRate("USD", "AED").catch(() => null),
  ]);
  const aiCostUsd = ai._sum.estimatedCostUsd ?? 0;
  return {
    month: label,
    enquiriesReceived,
    rfqsCreated,
    quotationsSent,
    searchQueries,
    aiInputTokens: ai._sum.inputTokens ?? 0,
    aiOutputTokens: ai._sum.outputTokens ?? 0,
    aiCostUsd,
    aiCalls: ai._count._all,
    fxRate: rate?.rate ?? null,
    aiCostAed: rate ? aiCostUsd * rate.rate : null,
  };
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function usageCsv(usage: MonthlyUsage): string {
  const rows: Array<[string, string | number | null]> = [
    ["month", usage.month],
    ["enquiries_received", usage.enquiriesReceived],
    ["rfqs_created", usage.rfqsCreated],
    ["quotations_sent", usage.quotationsSent],
    ["search_queries", usage.searchQueries],
    ["ai_calls", usage.aiCalls],
    ["ai_input_tokens", usage.aiInputTokens],
    ["ai_output_tokens", usage.aiOutputTokens],
    ["ai_cost_usd", usage.aiCostUsd.toFixed(6)],
    ["usd_aed_rate", usage.fxRate],
    ["ai_cost_aed", usage.aiCostAed == null ? "INCOMPLETE — no FX rate" : usage.aiCostAed.toFixed(2)],
  ];
  return ["metric,value", ...rows.map(([key, value]) => `${csvCell(key)},${csvCell(value)}`)].join("\r\n");
}

export async function usagePdf(usage: MonthlyUsage): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.fontSize(18).text("Monthly usage report", { underline: true });
  doc.moveDown(0.4).fontSize(10).fillColor("#444").text(`Month: ${usage.month}`);
  doc.moveDown(1).fillColor("#111").fontSize(12).text("Commercial activity");
  const rows = [
    ["Enquiries received", String(usage.enquiriesReceived)],
    ["Supplier RFQs created", String(usage.rfqsCreated)],
    ["Quotations sent", String(usage.quotationsSent)],
    ["Search queries", String(usage.searchQueries)],
    ["AI calls", String(usage.aiCalls)],
    ["AI input tokens", String(usage.aiInputTokens)],
    ["AI output tokens", String(usage.aiOutputTokens)],
    ["AI cost (USD)", usage.aiCostUsd.toFixed(4)],
    ["USD → AED rate", usage.fxRate == null ? "not available" : usage.fxRate.toFixed(6)],
    ["AI cost (AED)", usage.aiCostAed == null ? "incomplete — no rate" : usage.aiCostAed.toFixed(2)],
  ];
  doc.moveDown(0.5).fontSize(10);
  for (const [label, value] of rows) doc.text(`${label}: ${value}`);
  doc.moveDown(1).fontSize(8).fillColor("#666").text("Generated from deterministic usage records. No supplier cost or margin is included.");
  doc.end();
  return finished;
}
