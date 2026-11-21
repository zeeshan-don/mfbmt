"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorize, authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { readTabular } from "@/lib/inventory/import";
import { assertAllowedUpload } from "@/lib/storage";
import { stringifyJson } from "@/lib/json";
import { normalizeDomain } from "@/lib/sourcing/contacts";

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function createSupplierAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const name = str(formData.get("name"));
  if (!name) redirect("/suppliers?error=Supplier+name+is+required");

  const categories = String(formData.get("categories") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const supplier = await db.supplier.create({
    data: {
      name,
      website: str(formData.get("website")),
      country: str(formData.get("country")),
      city: str(formData.get("city")),
      address: str(formData.get("address")),
      contactPerson: str(formData.get("contactPerson")),
      email: str(formData.get("email")),
      phone: str(formData.get("phone")),
      whatsapp: str(formData.get("whatsapp")),
      notes: str(formData.get("notes")),
      categories: stringifyJson(categories),
      status: "ACTIVE",
    },
  });

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "supplier.created",
    entityType: "Supplier",
    entityId: supplier.id,
    meta: { name },
  });
  revalidatePath("/suppliers");
  redirect(`/suppliers/${supplier.id}?saved=1`);
}

export async function updateSupplierAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const supplierId = String(formData.get("supplierId") ?? "");
  await db.supplier.update({
    where: { id: supplierId },
    data: {
      name: str(formData.get("name")) ?? undefined,
      website: str(formData.get("website")),
      country: str(formData.get("country")),
      city: str(formData.get("city")),
      address: str(formData.get("address")),
      contactPerson: str(formData.get("contactPerson")),
      email: str(formData.get("email")),
      phone: str(formData.get("phone")),
      whatsapp: str(formData.get("whatsapp")),
      notes: str(formData.get("notes")),
      status: String(formData.get("status") ?? "ACTIVE"),
      paymentTerms: str(formData.get("paymentTerms")),
      typicalLeadTimeDays: str(formData.get("typicalLeadTimeDays"))
        ? Math.max(0, Math.round(Number(String(formData.get("typicalLeadTimeDays")).replace(/[^0-9.]/g, ""))))
        : null,
      doNotContact: formData.get("doNotContact") === "on",
      lastVerifiedAt: new Date(),
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "supplier.updated",
    entityType: "Supplier",
    entityId: supplierId,
  });
  revalidatePath(`/suppliers/${supplierId}`);
  redirect(`/suppliers/${supplierId}?saved=1`);
}

export async function addSupplierProductAction(formData: FormData) {
  const user = await authorize("suppliers.view");
  if (!user) redirect("/login");
  const supplierId = String(formData.get("supplierId") ?? "");
  const title = str(formData.get("title"));
  if (!title) redirect(`/suppliers/${supplierId}?error=Product+title+is+required`);
  const priceRaw = str(formData.get("unitPrice"));
  const price = priceRaw ? Number(priceRaw.replace(/,/g, "")) : null;

  await db.supplierProduct.create({
    data: {
      supplierId,
      title,
      description: str(formData.get("description")),
      sku: str(formData.get("sku")),
      unitPrice: price != null && Number.isFinite(price) ? price : null,
      currency: str(formData.get("currency"))?.toUpperCase() ?? null,
      moq: str(formData.get("moq")) ? Number(String(formData.get("moq")).replace(/,/g, "")) : null,
      availability: str(formData.get("availability")),
      sourceUrl: str(formData.get("sourceUrl")),
      specs: stringifyJson({ note: "Recorded by your company from supplier communication or catalogue." }),
      isDemo: false,
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "supplier_product.recorded",
    entityType: "Supplier",
    entityId: supplierId,
    meta: { title, price },
  });
  revalidatePath(`/suppliers/${supplierId}`);
  redirect(`/suppliers/${supplierId}?saved=1`);
}

export async function importSuppliersAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/suppliers?error=Choose+a+file");

  const buffer = Buffer.from(await file.arrayBuffer());
  const check = assertAllowedUpload(buffer, file.name);
  if (!check.ok) redirect(`/suppliers?error=${encodeURIComponent(check.error)}`);

  let created = 0;
  let skipped = 0;
  try {
    const tabular = await readTabular(buffer);
    const headerIndex = (patterns: RegExp[]) =>
      tabular.headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    const nameCol = headerIndex([/supplier|company|name/i]);
    const emailCol = headerIndex([/e-?mail/i]);
    const phoneCol = headerIndex([/phone|mobile|tel/i]);
    const whatsappCol = headerIndex([/whats/i]);
    const countryCol = headerIndex([/country/i]);
    const cityCol = headerIndex([/city|emirate/i]);
    const websiteCol = headerIndex([/website|site|url/i]);
    const categoryCol = headerIndex([/categor/i]);
    const currencyCol = headerIndex([/currenc/i]);
    const paymentCol = headerIndex([/payment/i]);
    const leadTimeCol = headerIndex([/lead.?time/i]);

    if (nameCol < 0) redirect("/suppliers?error=No+supplier+name+column+found");

    for (const row of tabular.rows) {
      const name = (row[nameCol] ?? "").trim();
      if (!name) {
        skipped += 1;
        continue;
      }
      const email = emailCol >= 0 ? (row[emailCol] ?? "").trim() || null : null;
      const website = websiteCol >= 0 ? (row[websiteCol] ?? "").trim() || null : null;
      const domain = normalizeDomain(website);
      const exists = await db.supplier.findFirst({
        where: { OR: [{ name }, ...(email ? [{ email }] : []), ...(domain ? [{ domain }] : [])] },
      });
      if (exists) {
        skipped += 1;
        continue;
      }
      const categories = categoryCol >= 0 ? (row[categoryCol] ?? "").split(/[,;/]/).map((c) => c.trim()).filter(Boolean) : [];
      const currencies = currencyCol >= 0 ? (row[currencyCol] ?? "").split(/[,;/\s]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)) : [];
      await db.supplier.create({
        data: {
          name,
          email,
          phone: phoneCol >= 0 ? (row[phoneCol] ?? "").trim() || null : null,
          whatsapp: whatsappCol >= 0 ? (row[whatsappCol] ?? "").trim() || null : null,
          country: countryCol >= 0 ? (row[countryCol] ?? "").trim() || null : null,
          city: cityCol >= 0 ? (row[cityCol] ?? "").trim() || null : null,
          website,
          domain,
          paymentTerms: paymentCol >= 0 ? (row[paymentCol] ?? "").trim() || null : null,
          typicalLeadTimeDays: leadTimeCol >= 0 && Number((row[leadTimeCol] ?? "").replace(/[^0-9.]/g, "")) > 0
            ? Math.round(Number((row[leadTimeCol] ?? "").replace(/[^0-9.]/g, "")))
            : null,
          categories: stringifyJson(categories),
          currencies: stringifyJson(currencies),
          status: "UNVERIFIED",
          notes: "Imported from spreadsheet. Confirm details before sending requests.",
        },
      });
      created += 1;
    }
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "suppliers.imported",
      entityType: "Supplier",
      meta: { created, skipped, filename: file.name },
    });
  } catch (error) {
    redirect(`/suppliers?error=${encodeURIComponent(error instanceof Error ? error.message : "Import failed")}`);
  }
  revalidatePath("/suppliers");
  redirect(`/suppliers?imported=${created}&skipped=${skipped}`);
}
