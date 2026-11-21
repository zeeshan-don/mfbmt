import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getMonthlyUsage, usageCsv, usagePdf } from "@/lib/usage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await requireOwner();
  const url = new URL(request.url);
  const month = url.searchParams.get("month") ?? undefined;
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  const usage = await getMonthlyUsage(month);
  if (format === "pdf") {
    const pdf = await usagePdf(usage);
    return new NextResponse(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="usage-${usage.month}.pdf"`,
      },
    });
  }
  return new NextResponse(usageCsv(usage), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${usage.month}.csv"`,
    },
  });
}
