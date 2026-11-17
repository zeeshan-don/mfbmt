import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { generateAndStoreQuotationPdf } from "@/lib/workflow/quotations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Quotation PDF download. Owner or staff with quotation access only. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (user.role !== "OWNER" && !user.permissions.includes("quotations.view")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { id } = await context.params;
  const quotation = await db.customerQuotation.findUnique({ where: { id } });
  if (!quotation) return NextResponse.json({ error: "Not found." }, { status: 404 });

  if (!quotation.pdfPath) {
    const result = await generateAndStoreQuotationPdf(id);
    if (!result.ok) return NextResponse.json({ error: result.error ?? "Could not create PDF." }, { status: 500 });
  }

  const refreshed = await db.customerQuotation.findUnique({ where: { id } });
  if (!refreshed?.pdfPath) return NextResponse.json({ error: "PDF not available." }, { status: 404 });

  const root = path.resolve(process.cwd(), env.STORAGE_ROOT);
  const target = path.resolve(root, refreshed.pdfPath);
  if (!target.startsWith(root)) return NextResponse.json({ error: "Invalid path." }, { status: 400 });

  try {
    const buffer = await fs.readFile(target);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${refreshed.quoteNumber}.pdf"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "The PDF could not be read." }, { status: 500 });
  }
}
