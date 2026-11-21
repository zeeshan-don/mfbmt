import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireOwner();
  const [organization, enquiries, quotations, suppliers, customers, products] = await Promise.all([
    db.organization.findFirst(),
    db.enquiry.findMany({ include: { items: true } }),
    db.customerQuotation.findMany({ include: { items: true } }),
    db.supplier.findMany(),
    db.customer.findMany(),
    db.product.findMany(),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    organization,
    enquiries,
    quotations,
    suppliers,
    customers,
    products,
  };

  return new NextResponse(stringifyJson(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="organization-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}