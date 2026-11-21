"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function createCustomerAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const name = str(formData.get("name"));
  if (!name) redirect("/customers?error=Customer+name+is+required");
  const email = str(formData.get("email"));
  const existing = email
    ? await db.customer.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })
    : null;
  if (existing) redirect(`/customers/${existing.id}?error=${encodeURIComponent("That customer already exists.")}`);

  const customer = await db.customer.create({
    data: {
      name,
      email,
      phone: str(formData.get("phone")),
      taxNumber: str(formData.get("taxNumber")),
      country: str(formData.get("country")),
      tier: ["STANDARD", "SILVER", "GOLD", "STRATEGIC"].includes(String(formData.get("tier")))
        ? String(formData.get("tier"))
        : "STANDARD",
      notes: str(formData.get("notes")),
      contacts: str(formData.get("contactName"))
        ? {
            create: [{
              name: String(formData.get("contactName")),
              role: str(formData.get("contactRole")),
              email: str(formData.get("contactEmail")),
              phone: str(formData.get("contactPhone")),
              isPrimary: true,
            }],
          }
        : undefined,
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "customer.created",
    entityType: "Customer",
    entityId: customer.id,
    meta: { name, tier: customer.tier },
  });
  revalidatePath("/customers");
  redirect(`/customers/${customer.id}?saved=1`);
}

export async function updateCustomerAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const customerId = String(formData.get("customerId") ?? "");
  const tier = ["STANDARD", "SILVER", "GOLD", "STRATEGIC"].includes(String(formData.get("tier")))
    ? String(formData.get("tier"))
    : "STANDARD";
  const name = str(formData.get("name"));
  if (!name) redirect(`/customers/${customerId}?error=Customer+name+is+required`);
  await db.customer.update({
    where: { id: customerId },
    data: {
      name,
      email: str(formData.get("email")),
      phone: str(formData.get("phone")),
      taxNumber: str(formData.get("taxNumber")),
      country: str(formData.get("country")),
      tier,
      notes: str(formData.get("notes")),
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "customer.updated",
    entityType: "Customer",
    entityId: customerId,
    meta: { tier },
  });
  revalidatePath("/customers");
  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}?saved=1`);
}
