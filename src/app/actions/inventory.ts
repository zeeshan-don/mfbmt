"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireTenantId } from "@/lib/tenant";
import { authorize, authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { readTabular, guessMapping, importInventory, MAPPABLE_FIELDS, type ColumnMapping } from "@/lib/inventory/import";
import { assertAllowedUpload } from "@/lib/storage";
import { normalizeUnit } from "@/lib/catalog/normalize";
import { setSettingJson, deleteSetting } from "@/lib/settings";

export async function previewInventoryImportAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/inventory/import?error=Choose+a+file");

  const buffer = Buffer.from(await file.arrayBuffer());
  const check = assertAllowedUpload(buffer, file.name);
  if (!check.ok) redirect(`/inventory/import?error=${encodeURIComponent(check.error)}`);

  try {
    const tabular = await readTabular(buffer);
    const token = `import:${Date.now().toString(36)}`;
    await setSettingJson(token, {
      headers: tabular.headers,
      rows: tabular.rows.slice(0, 3000),
      sheetName: tabular.sheetName,
      filename: file.name,
    });
    redirect(`/inventory/import?token=${token}`);
  } catch (error) {
    redirect(`/inventory/import?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not read the file")}`);
  }
}

export async function runInventoryImportAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");

  const token = String(formData.get("token") ?? "");
  const setting = await db.appSetting.findFirst({ where: { key: token } });
  if (!setting) redirect("/inventory/import?error=This+import+has+expired.+Upload+the+file+again.");

  const parsed = JSON.parse(setting.value) as { headers: string[]; rows: string[][]; filename: string };
  const mapping: ColumnMapping = {};
  for (const field of MAPPABLE_FIELDS) {
    const raw = formData.get(`map_${field.key}`);
    if (raw != null && String(raw) !== "") mapping[field.key] = Number(raw);
  }

  const locationCode = String(formData.get("locationCode") ?? "MAIN").trim() || "MAIN";
  const locationName = String(formData.get("locationName") ?? "Main warehouse").trim() || locationCode;

  try {
    const report = await importInventory({
      rows: parsed.rows,
      mapping,
      defaultLocationCode: locationCode,
      defaultLocationName: locationName,
      userId: user.id,
    });
    await deleteSetting(token);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "inventory.imported",
      entityType: "Inventory",
      meta: { filename: parsed.filename, ...report },
    });
    const params = new URLSearchParams({
      imported: String(report.created + report.updated),
      created: String(report.created),
      updated: String(report.updated),
      skipped: String(report.skipped),
    });
    if (report.errors.length > 0) {
      params.set("errors", String(report.errors.length));
      params.set("firstError", `Row ${report.errors[0].row}: ${report.errors[0].message}`);
    }
    revalidatePath("/inventory");
    redirect(`/inventory?${params.toString()}`);
  } catch (error) {
    redirect(`/inventory/import?token=${token}&error=${encodeURIComponent(error instanceof Error ? error.message : "Import failed")}`);
  }
}

export async function createProductAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const sku = String(formData.get("sku") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  if (!sku || !name) redirect("/inventory?error=Product+code+and+name+are+required");

  try {
    const product = await db.product.create({
      data: {
        sku,
        name,
        category: String(formData.get("category") ?? "Other Industrial Supplies"),
        brand: String(formData.get("brand") ?? "").trim() || null,
        size: String(formData.get("size") ?? "").trim() || null,
        material: String(formData.get("material") ?? "").trim() || null,
        grade: String(formData.get("grade") ?? "").trim() || null,
        pressureRating: String(formData.get("pressureRating") ?? "").trim() || null,
        unit: normalizeUnit(String(formData.get("unit") ?? "pcs")),
      },
    });
    const organizationId = await requireTenantId();
    const location = await db.inventoryLocation.upsert({
      where: { organizationId_code: { organizationId, code: "MAIN" } },
      update: {},
      create: { organizationId, code: "MAIN", name: "Main warehouse" },
    });
    const quantity = Number(String(formData.get("quantity") ?? "0").replace(/,/g, "")) || 0;
    await db.inventoryStock.create({
      data: { productId: product.id, locationId: location.id, quantityOnHand: quantity, source: "MANUAL" },
    });
    await db.inventoryMovement.create({
      data: { productId: product.id, locationId: location.id, delta: quantity, reason: "Product created", userId: user.id },
    });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "inventory.product_created",
      entityType: "Product",
      entityId: product.id,
      meta: { sku, quantity },
    });
  } catch (error) {
    redirect(`/inventory?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not create product")}`);
  }
  revalidatePath("/inventory");
  redirect("/inventory?saved=1");
}

export async function adjustStockAction(formData: FormData) {
  const user = await authorize("inventory.view");
  if (!user) redirect("/login");
  if (user.role !== "OWNER") redirect("/inventory?error=Only+the+owner+can+change+stock");

  const productId = String(formData.get("productId") ?? "");
  const delta = Number(String(formData.get("delta") ?? "").replace(/,/g, ""));
  if (!productId || !Number.isFinite(delta) || delta === 0) redirect("/inventory?error=Enter+a+stock+quantity+change");

  const organizationId = await requireTenantId();
  const location = await db.inventoryLocation.upsert({
    where: { organizationId_code: { organizationId, code: "MAIN" } },
    update: {},
    create: { organizationId, code: "MAIN", name: "Main warehouse" },
  });
  const stock = await db.inventoryStock.findUnique({
    where: { productId_locationId: { productId, locationId: location.id } },
  });
  const next = Math.max(0, (stock?.quantityOnHand ?? 0) + delta);

  await db.inventoryStock.upsert({
    where: { productId_locationId: { productId, locationId: location.id } },
    update: { quantityOnHand: next, lastUpdatedAt: new Date(), source: "ADJUSTMENT" },
    create: { productId, locationId: location.id, quantityOnHand: next, source: "ADJUSTMENT" },
  });
  await db.inventoryMovement.create({
    data: { productId, locationId: location.id, delta, reason: "Manual stock update", userId: user.id },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "inventory.stock_adjusted",
    entityType: "Product",
    entityId: productId,
    meta: { delta, next },
  });
  revalidatePath("/inventory");
  redirect("/inventory?saved=1");
}
