"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { authorizeOwner, hashPassword } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { env, integrationEnv } from "@/lib/env";
import { testWhatsAppConnection, whatsAppStatus } from "@/lib/intake/whatsapp";
import { testEmailConnection } from "@/lib/email/send";
import { syncEmailIntake } from "@/lib/email/sync";
import { getRate } from "@/lib/costing/fx";
import { normalizeIdentifier } from "@/lib/workflow/enquiry";
import { saveIntegration, getIntegration, readSecrets } from "@/lib/integrations/store";
import { disconnect } from "@/lib/email/oauth";
import { AIExtractionResponseSchema } from "@/lib/validation/extraction";
import { completeJson, aiStatus } from "@/lib/ai/provider";
import { getSearchAdapters } from "@/lib/sourcing/registry";
import { PERMISSIONS } from "@/lib/constants";

function str(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function testIntegrationAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const key = String(formData.get("key") ?? "");
  let status: string = "NEEDS_ATTENTION";
  let detail = "";

  try {
    switch (key) {
      case "WHATSAPP": {
        if (!whatsAppStatus().configured) {
          detail = `Missing credentials: ${whatsAppStatus().missing.join(", ")}.`;
        } else {
          const result = await testWhatsAppConnection();
          status = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
          detail = result.detail;
          await saveIntegration({
            key: "WHATSAPP",
            status,
            accountLabel: result.account ?? null,
            lastError: result.ok ? null : detail,
            config: { verifiedName: result.account ?? null },
          });
        }
        break;
      }
      case "AI_PROVIDER": {
        if (!aiStatus().configured) {
          detail = aiStatus().reason ?? "AI provider is not configured.";
        } else {
          const result = await completeJson(
            {
              system:
                "Return JSON only: {\"isRfq\":true,\"classification\":\"RFQ\",\"classificationConfidence\":1,\"classificationReason\":\"connection test\",\"items\":[],\"unreadableParts\":[]}",
              user: "Connection test. Reply with the JSON shape above.",
              maxTokens: 300,
            },
            AIExtractionResponseSchema,
          );
          status = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
          detail = result.ok ? `${env.AI_PROVIDER} · ${env.AI_MODEL} answered correctly.` : result.error;
          await saveIntegration({ key: "AI_PROVIDER", status, lastError: result.ok ? null : detail });
        }
        break;
      }
      case "WEB_SEARCH": {
        const adapter = getSearchAdapters().find((entry) => entry.key === "PUBLIC_WEB");
        if (!adapter?.available()) {
          detail = adapter?.unavailableReason?.() ?? "Web search is not configured.";
        } else {
          const result = await adapter.search(["industrial valve supplier UAE"], {
            request: { description: "industrial valve", quantity: 1, unit: "pcs" },
            fetchPages: false,
          });
          status = result.status === "OK" ? "CONNECTED" : "NEEDS_ATTENTION";
          detail =
            result.status === "OK"
              ? `${env.WEB_SEARCH_PROVIDER} returned ${result.candidates.length} result(s) for a test search.`
              : result.note ?? "Search provider returned an error.";
          await saveIntegration({ key: "WEB_SEARCH", status, lastError: result.status === "OK" ? null : detail });
        }
        break;
      }
      case "GMAIL":
      case "MICROSOFT365": {
        const provider = key === "GMAIL" ? "gmail" : "microsoft365";
        if (env.EMAIL_INTAKE_PROVIDER !== provider) {
          detail = `Set EMAIL_INTAKE_PROVIDER="${provider}" and connect the mailbox before testing.`;
        } else {
          const result = await testEmailConnection();
          status = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
          detail = result.detail;
          await saveIntegration({
            key: key as "GMAIL" | "MICROSOFT365",
            status,
            accountLabel: result.account ?? null,
            lastError: result.ok ? null : detail,
          });
        }
        break;
      }
      case "STORAGE": {
        const dir = path.resolve(process.cwd(), env.STORAGE_ROOT);
        await fs.mkdir(dir, { recursive: true });
        const probe = path.join(dir, ".probe");
        await fs.writeFile(probe, "ok");
        await fs.rm(probe, { force: true });
        status = "CONNECTED";
        detail = `Files are stored in ${env.STORAGE_ROOT}.`;
        await saveIntegration({ key: "STORAGE", status, config: { root: env.STORAGE_ROOT } });
        break;
      }
      case "EXCHANGE_RATE": {
        const rate = await getRate("USD", "AED");
        status = rate ? "CONNECTED" : "NEEDS_ATTENTION";
        detail = rate
          ? `1 USD = ${rate.rate} AED (${rate.source}).`
          : "No exchange-rate source is configured. Cross-currency totals will be marked incomplete.";
        await saveIntegration({ key: "EXCHANGE_RATE", status, lastError: rate ? null : detail });
        break;
      }
      case "OCR": {
        status = env.OCR_PROVIDER === "none" ? "NOT_CONFIGURED" : "CONNECTED";
        detail =
          env.OCR_PROVIDER === "none"
            ? "OCR is turned off; photos are attached for manual reading."
            : "Built-in OCR is available. It downloads language data on first use.";
        await saveIntegration({ key: "OCR", status, lastError: null });
        break;
      }
      default:
        detail = "Unknown integration.";
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : "Test failed.";
  }

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "integration.tested",
    entityType: "Integration",
    entityId: key,
    meta: { status, detail },
  });

  revalidatePath("/settings");
  redirect(`/settings?tested=${encodeURIComponent(key)}&result=${encodeURIComponent(`${status}: ${detail}`)}`);
}

export async function syncEmailNowAction() {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const result = await syncEmailIntake();
  revalidatePath("/settings");
  revalidatePath("/enquiries");
  redirect(`/settings?sync=${encodeURIComponent(result.detail)}`);
}

export async function disconnectEmailAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const provider = String(formData.get("provider") ?? "gmail") as "gmail" | "microsoft";
  await disconnect(provider);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "integration.disconnected",
    entityType: "Integration",
    entityId: provider,
  });
  revalidatePath("/settings");
  redirect("/settings?disconnected=1");
}

export async function saveOrganizationAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const existing = await db.organization.findFirst();
  const data = {
    name: str(formData.get("name")) ?? "Multi Fasteners Building Materials Trading LLC",
    legalName: str(formData.get("legalName")),
    trn: str(formData.get("trn")),
    email: str(formData.get("email")),
    phone: str(formData.get("phone")),
    address: str(formData.get("address")),
    website: str(formData.get("website")),
    defaultCurrency: (str(formData.get("defaultCurrency")) ?? "AED").toUpperCase(),
    quotationValidityDays: Number(String(formData.get("quotationValidityDays") ?? "14")) || 14,
    taxEnabled: formData.get("taxEnabled") === "on",
    taxRatePct: Number(String(formData.get("taxRatePct") ?? "5")) || 0,
    taxLabel: str(formData.get("taxLabel")) ?? "VAT",
    quotationTerms: str(formData.get("quotationTerms")),
  };
  if (existing) {
    await db.organization.update({ where: { id: existing.id }, data });
  } else {
    await db.organization.create({ data });
  }
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "organization.updated",
    entityType: "Organization",
    entityId: existing?.id ?? "new",
  });
  revalidatePath("/settings");
  redirect("/settings?saved=1#company");
}

export async function addExcludedContactAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const raw = str(formData.get("identifier"));
  if (!raw) redirect("/settings?error=Enter+a+phone+number+or+email");
  const identifier = normalizeIdentifier(raw);
  const category = String(formData.get("category") ?? "PERSONAL");
  await db.excludedContact.upsert({
    where: { identifier },
    update: { category, label: str(formData.get("label")), reason: str(formData.get("reason")) },
    create: {
      identifier,
      category,
      label: str(formData.get("label")),
      reason: str(formData.get("reason")),
    },
  });
  const contact = await db.contact.findFirst({
    where: { OR: [{ phone: { contains: identifier.replace(/^\+/, "").slice(-9) } }, { email: raw.toLowerCase() }] },
  });
  if (contact) await db.contact.update({ where: { id: contact.id }, data: { kind: category } });

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "excluded_contact.saved",
    entityType: "ExcludedContact",
    entityId: identifier,
    meta: { category },
  });
  revalidatePath("/settings");
  redirect("/settings?saved=1#contacts");
}

export async function removeExcludedContactAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const id = String(formData.get("id") ?? "");
  await db.excludedContact.deleteMany({ where: { id } });
  revalidatePath("/settings");
  redirect("/settings?saved=1#contacts");
}

export async function savePricingRuleAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const scope = String(formData.get("scope") ?? "GLOBAL");
  const type = String(formData.get("type") ?? "PERCENT_MARKUP");
  const value = Number(String(formData.get("value") ?? "0")) || 0;
  const category = scope === "CATEGORY" ? str(formData.get("category")) : null;
  if (scope === "CATEGORY" && !category) redirect("/settings?error=Choose+a+category+for+this+rule");

  await db.pricingRule.create({
    data: {
      scope,
      category,
      type,
      value,
      priority: Number(String(formData.get("priority") ?? "100")) || 100,
      isActive: true,
    },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "pricing_rule.created",
    entityType: "PricingRule",
    meta: { scope, type, value, category },
  });
  revalidatePath("/settings");
  redirect("/settings?saved=1#pricing");
}

export async function togglePricingRuleAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const id = String(formData.get("id") ?? "");
  const rule = await db.pricingRule.findUnique({ where: { id } });
  if (rule) {
    await db.pricingRule.update({ where: { id }, data: { isActive: !rule.isActive } });
  }
  revalidatePath("/settings");
  redirect("/settings#pricing");
}

export async function deletePricingRuleAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  await db.pricingRule.deleteMany({ where: { id: String(formData.get("id") ?? "") } });
  revalidatePath("/settings");
  redirect("/settings#pricing");
}

export async function createUserAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const email = (str(formData.get("email")) ?? "").toLowerCase();
  const name = str(formData.get("name"));
  const password = String(formData.get("password") ?? "");
  if (!email || !name || password.length < 10) {
    redirect("/settings?error=Name%2C+email+and+a+password+of+at+least+10+characters+are+required#team");
  }
  const permissions = formData.getAll("permissions").map(String).filter((p) => (PERMISSIONS as readonly string[]).includes(p));
  try {
    await db.user.create({
      data: {
        email,
        name,
        passwordHash: await hashPassword(password),
        role: "STAFF",
        permissions: JSON.stringify(permissions),
      },
    });
  } catch {
    redirect("/settings?error=A+user+with+that+email+already+exists#team");
  }
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "user.created",
    entityType: "User",
    meta: { email, permissions },
  });
  revalidatePath("/settings");
  redirect("/settings?saved=1#team");
}

export async function toggleUserAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const id = String(formData.get("id") ?? "");
  if (id === user.id) redirect("/settings?error=You+cannot+deactivate+your+own+account#team");
  const target = await db.user.findUnique({ where: { id } });
  if (target && target.role !== "OWNER") {
    await db.user.update({ where: { id }, data: { isActive: !target.isActive } });
    await db.session.deleteMany({ where: { userId: id } });
  }
  revalidatePath("/settings");
  redirect("/settings?saved=1#team");
}

