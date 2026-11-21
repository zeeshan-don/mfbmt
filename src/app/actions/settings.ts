"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorizeOwner, hashPassword } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { env, integrationEnv } from "@/lib/env";
import { testWhatsAppConnection } from "@/lib/integrations/whatsapp";
import { testEmailConnection } from "@/lib/email/send";
import { syncEmailIntake, renewEmailSubscriptions } from "@/lib/email/sync";
import { getRate } from "@/lib/costing/fx";
import { saveIntegration } from "@/lib/integrations/store";
import { disconnect } from "@/lib/email/oauth";
import { AIExtractionResponseSchema } from "@/lib/validation/extraction";
import { completeJson, aiStatus } from "@/lib/ai/provider";
import { getSearchAdapters } from "@/lib/sourcing/registry";
import { testStorage, storageDriver } from "@/lib/storage";
import { PERMISSIONS } from "@/lib/constants";
import { canonicalPhone, parseEmailAddress } from "@/lib/intake/identity";
import { retryJob } from "@/lib/workflow/jobs";
import { getOrgLimits, saveOrgLimits } from "@/lib/limits";

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
        const result = await testWhatsAppConnection();
        status = result.ok ? "CONNECTED" : result.needsAttention ? "NEEDS_ATTENTION" : "NOT_CONFIGURED";
        detail = result.detail;
        break;
      }
      case "AI_PROVIDER": {
        if (!aiStatus().configured) {
          detail = aiStatus().reason ?? "AI provider is not configured.";
          status = "NOT_CONFIGURED";
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
          await saveIntegration({ key: "AI_PROVIDER", status, lastError: result.ok ? null : detail, markSuccess: result.ok });
        }
        break;
      }
      case "WEB_SEARCH": {
        const adapter = getSearchAdapters().find((entry) => entry.key === "PUBLIC_WEB");
        if (!adapter?.available()) {
          detail = adapter?.unavailableReason?.() ?? "Web search is not configured.";
          status = "NOT_CONFIGURED";
        } else {
          const result = await adapter.search(["industrial valve supplier UAE"], {
            request: { description: "industrial valve", quantity: 1, unit: "pcs" },
            fetchPages: false,
          });
          status = result.status === "OK" ? "CONNECTED" : "NEEDS_ATTENTION";
          detail =
            result.status === "OK"
              ? `Web search returned ${result.candidates.length} result(s) for a test search.${result.note ? ` ${result.note}` : ""}`
              : (result.note ?? "Search provider returned an error.");
          await saveIntegration({
            key: "WEB_SEARCH",
            status,
            lastError: result.status === "OK" ? null : detail,
            markSuccess: result.status === "OK",
          });
        }
        break;
      }
      case "GMAIL":
      case "MICROSOFT365": {
        const result = await testEmailConnection();
        status = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
        detail = result.detail;
        if (result.ok) {
          const renewed = await renewEmailSubscriptions();
          detail = `${result.detail} ${renewed.detail}`;
        }
        await saveIntegration({
          key: key as "GMAIL" | "MICROSOFT365",
          status: result.ok ? "CONNECTED" : "NEEDS_ATTENTION",
          accountLabel: result.account ?? null,
          lastError: result.ok ? null : detail,
          markSuccess: result.ok,
        });
        break;
      }
      case "STORAGE": {
        const result = await testStorage();
        status = result.ok ? "CONNECTED" : "NEEDS_ATTENTION";
        detail = result.detail;
        await saveIntegration({
          key: "STORAGE",
          status,
          config: { driver: storageDriver },
          lastError: result.ok ? null : detail,
          markSuccess: result.ok,
        });
        break;
      }
      case "EXCHANGE_RATE": {
        const rate = await getRate("USD", "AED");
        status = rate ? "CONNECTED" : "NOT_CONFIGURED";
        detail = rate
          ? `1 USD = ${rate.rate} AED (${rate.source}).`
          : "No exchange-rate source is configured. Cross-currency totals are marked incomplete instead of guessed.";
        await saveIntegration({ key: "EXCHANGE_RATE", status, lastError: rate ? null : detail, markSuccess: Boolean(rate) });
        break;
      }
      case "OCR": {
        status = env.OCR_PROVIDER === "none" ? "NOT_CONFIGURED" : "CONNECTED";
        detail =
          env.OCR_PROVIDER === "none"
            ? "Photo and scan reading is turned off; images are attached for manual reading."
            : `OCR is available (languages: ${env.OCR_LANGUAGES}). Scanned PDFs and photos are read with it.`;
        await saveIntegration({ key: "OCR", status, lastError: null, markSuccess: status === "CONNECTED" });
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
  redirect(`/settings?tested=${encodeURIComponent(key)}&result=${encodeURIComponent(`${status}: ${detail}`)}#integrations`);
}

export async function syncEmailNowAction() {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const result = await syncEmailIntake({ trigger: "manual" });
  revalidatePath("/settings");
  revalidatePath("/enquiries");
  redirect(`/settings?sync=${encodeURIComponent(result.detail)}#integrations`);
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
    entityId: provider === "gmail" ? "GMAIL" : "MICROSOFT365",
  });
  revalidatePath("/settings");
  redirect("/settings?disconnected=1#integrations");
}

export async function saveOrganizationAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const existing = await db.organization.findUnique({ where: { id: user.organizationId } });
  if (!existing) redirect("/settings?error=Your+company+workspace+could+not+be+found.#company");
  const inventoryMode = String(formData.get("inventoryMode") ?? "STOCK_FIRST");
  const data = {
    name: str(formData.get("name")) ?? existing.name,
    legalName: str(formData.get("legalName")),
    taxRegistrationNumber: str(formData.get("taxRegistrationNumber")),
    email: str(formData.get("email")),
    phone: str(formData.get("phone")),
    address: str(formData.get("address")),
    website: str(formData.get("website")),
    defaultCurrency: (str(formData.get("defaultCurrency")) ?? existing.defaultCurrency).toUpperCase().slice(0, 3),
    quotationValidityDays: Number(String(formData.get("quotationValidityDays") ?? "14")) || 14,
    taxEnabled: formData.get("taxEnabled") === "on",
    taxInLandedCost: formData.get("taxInLandedCost") === "on",
    taxRatePct: Number(String(formData.get("taxRatePct") ?? "5")) || 0,
    taxLabel: str(formData.get("taxLabel")) ?? "VAT",
    quotationTerms: str(formData.get("quotationTerms")),
    minMarginPct: Math.min(100, Math.max(0, Number(String(formData.get("minMarginPct") ?? "0")) || 0)),
    inventoryMode: inventoryMode === "SOURCING_FIRST" ? "SOURCING_FIRST" : "STOCK_FIRST",
    inventoryConfiguredAt:
      inventoryMode === "SOURCING_FIRST" ? (existing.inventoryConfiguredAt ?? new Date()) : existing.inventoryConfiguredAt ?? null,
  };
  await db.organization.update({ where: { id: existing.id }, data });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "organization.updated",
    entityType: "Organization",
    entityId: existing?.id ?? "new",
    meta: { inventoryMode: data.inventoryMode },
  });
  revalidatePath("/settings");
  revalidatePath("/onboarding");
  redirect("/settings?saved=1#company");
}

export async function addExcludedContactAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const raw = str(formData.get("identifier"));
  if (!raw) redirect("/settings?error=Enter+a+phone+number+or+email#contacts");

  const identifier = raw.includes("@") ? parseEmailAddress(raw) : canonicalPhone(raw);
  if (!identifier) {
    redirect(`/settings?error=${encodeURIComponent("That phone number or email address could not be read. Use international format, e.g. +971501234567.")}#contacts`);
  }
  const category = String(formData.get("category") ?? "PERSONAL");

  await db.excludedContact.upsert({
    where: { organizationId_identifier: { organizationId: user.organizationId, identifier } },
    update: { category, label: str(formData.get("label")), reason: str(formData.get("reason")) },
    create: {
      organizationId: user.organizationId,
      identifier,
      category,
      label: str(formData.get("label")),
      reason: str(formData.get("reason")),
    },
  });

  const or = [
    ...(identifier.includes("@") ? [{ email: identifier }] : [{ phone: identifier }]),
  ];
  const contact = await db.contact.findFirst({ where: { OR: or } });
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
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "excluded_contact.removed",
    entityType: "ExcludedContact",
    entityId: id,
  });
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
  const customerTier = str(formData.get("customerTier"))?.toUpperCase() ?? null;
  if (scope === "CATEGORY" && !category) redirect("/settings?error=Choose+a+category+for+this+rule#pricing");

  await db.pricingRule.create({
    data: {
      scope,
      category,
      customerTier,
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
    meta: { scope, type, value, category, customerTier },
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

export async function saveLimitsAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const current = await getOrgLimits();
  const number = (key: string, fallback: number) => {
    const parsed = Number(String(formData.get(key) ?? ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const saved = await saveOrgLimits({
    maxItemsPerEnquiry: number("maxItemsPerEnquiry", current.maxItemsPerEnquiry),
    maxSearchQueriesPerItem: number("maxSearchQueriesPerItem", current.maxSearchQueriesPerItem),
    webSearchEnabled: formData.get("webSearchEnabled") === "on",
    monthlyAiBudgetAed: number("monthlyAiBudgetAed", current.monthlyAiBudgetAed),
    monthlyEnquiryAllowance: number("monthlyEnquiryAllowance", current.monthlyEnquiryAllowance),
    searchCacheTtlDays: number("searchCacheTtlDays", current.searchCacheTtlDays),
    lowConfidenceSecondPass: formData.get("lowConfidenceSecondPass") === "on",
    supplierAutoSendVerified: formData.get("supplierAutoSendVerified") === "on",
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "limits.updated",
    entityType: "Organization",
    meta: saved,
  });
  revalidatePath("/settings");
  redirect("/settings?saved=1#limits");
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
  const permissions = formData
    .getAll("permissions")
    .map(String)
    .filter((permission) => (PERMISSIONS as readonly string[]).includes(permission));
  try {
    await db.user.create({
      data: {
        email,
        name,
        passwordHash: await hashPassword(password),
        role: "STAFF",
        permissions: JSON.stringify(permissions),
        mustChangePassword: true,
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

export async function retryJobAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const jobId = String(formData.get("jobId") ?? "");
  try {
    await retryJob(jobId, user.name);
  } catch (error) {
    redirect(`/activity?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not retry")}#jobs`);
  }
  revalidatePath("/activity");
  redirect("/activity?saved=1#jobs");
}

/** Marks first-time setup complete once the owner has reviewed every step. */
export async function completeOnboardingAction() {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const org = await db.organization.findUnique({ where: { id: user.organizationId } });
  if (org) {
    await db.organization.update({ where: { id: org.id }, data: { onboardingCompletedAt: new Date() } });
  }
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "onboarding.completed",
    entityType: "Organization",
    entityId: org?.id ?? "new",
  });
  revalidatePath("/onboarding");
  redirect("/?onboarded=1");
}
