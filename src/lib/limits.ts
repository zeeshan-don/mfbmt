import { db } from "./db";
import { getCurrentOrganization } from "./organization";
import { getSettingJson, setSettingJson } from "./settings";
import { getRate } from "./costing/fx";

export type OrgLimits = {
  maxItemsPerEnquiry: number;
  maxSearchQueriesPerItem: number;
  webSearchEnabled: boolean;
  monthlyAiBudgetAed: number;
  monthlyEnquiryAllowance: number;
  searchCacheTtlDays: number;
  lowConfidenceSecondPass: boolean;
  supplierAutoSendVerified: boolean;
  slaOverdueHours: number;
};

const GENERAL_DEFAULTS: OrgLimits = {
  maxItemsPerEnquiry: 5,
  maxSearchQueriesPerItem: 2,
  webSearchEnabled: true,
  monthlyAiBudgetAed: 100,
  monthlyEnquiryAllowance: 500,
  searchCacheTtlDays: 7,
  lowConfidenceSecondPass: false,
  supplierAutoSendVerified: false,
  slaOverdueHours: 48,
};

const OGS_DEFAULTS: OrgLimits = {
  ...GENERAL_DEFAULTS,
  maxSearchQueriesPerItem: 3,
  monthlyAiBudgetAed: 250,
  monthlyEnquiryAllowance: 1_200,
};

const LIMITS_KEY = "commercial.limits";

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export async function getDefaultLimits(): Promise<OrgLimits> {
  const organization = await getCurrentOrganization().catch(() => null);
  return organization?.procurementProfile === "INDUSTRIAL" ? OGS_DEFAULTS : GENERAL_DEFAULTS;
}

export async function getOrgLimits(): Promise<OrgLimits> {
  const [defaults, stored] = await Promise.all([
    getDefaultLimits(),
    getSettingJson<Partial<OrgLimits>>(LIMITS_KEY, {}),
  ]);
  return {
    maxItemsPerEnquiry: clampNumber(stored.maxItemsPerEnquiry, defaults.maxItemsPerEnquiry, 1, 50),
    maxSearchQueriesPerItem: clampNumber(stored.maxSearchQueriesPerItem, defaults.maxSearchQueriesPerItem, 1, 10),
    webSearchEnabled: typeof stored.webSearchEnabled === "boolean" ? stored.webSearchEnabled : defaults.webSearchEnabled,
    monthlyAiBudgetAed: clampNumber(stored.monthlyAiBudgetAed, defaults.monthlyAiBudgetAed, 0, 100_000),
    monthlyEnquiryAllowance: clampNumber(stored.monthlyEnquiryAllowance, defaults.monthlyEnquiryAllowance, 0, 100_000),
    slaOverdueHours: clampNumber(stored.slaOverdueHours, defaults.slaOverdueHours, 1, 720),
    searchCacheTtlDays: clampNumber(stored.searchCacheTtlDays, defaults.searchCacheTtlDays, 1, 90),
    lowConfidenceSecondPass: stored.lowConfidenceSecondPass === true,
    supplierAutoSendVerified: stored.supplierAutoSendVerified === true,
  };
}

export async function saveOrgLimits(input: Partial<OrgLimits>): Promise<OrgLimits> {
  const current = await getOrgLimits();
  const next: OrgLimits = {
    ...current,
    ...input,
    maxItemsPerEnquiry: clampNumber(input.maxItemsPerEnquiry ?? current.maxItemsPerEnquiry, current.maxItemsPerEnquiry, 1, 50),
    maxSearchQueriesPerItem: clampNumber(input.maxSearchQueriesPerItem ?? current.maxSearchQueriesPerItem, current.maxSearchQueriesPerItem, 1, 10),
    monthlyAiBudgetAed: clampNumber(input.monthlyAiBudgetAed ?? current.monthlyAiBudgetAed, current.monthlyAiBudgetAed, 0, 100_000),
    monthlyEnquiryAllowance: clampNumber(input.monthlyEnquiryAllowance ?? current.monthlyEnquiryAllowance, current.monthlyEnquiryAllowance, 0, 100_000),
    searchCacheTtlDays: clampNumber(input.searchCacheTtlDays ?? current.searchCacheTtlDays, current.searchCacheTtlDays, 1, 90),
    supplierAutoSendVerified: input.supplierAutoSendVerified ?? current.supplierAutoSendVerified,
    slaOverdueHours: clampNumber(input.slaOverdueHours ?? current.slaOverdueHours, current.slaOverdueHours, 1, 720),
  };
  await setSettingJson(LIMITS_KEY, next);
  return next;
}

export function monthBounds(month?: string): { start: Date; end: Date; label: string } {
  const selected = /^\d{4}-\d{2}$/.test(month ?? "") ? (month as string) : new Date().toISOString().slice(0, 7);
  const start = new Date(`${selected}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end, label: selected };
}

export async function aiBudgetStatus(limit?: OrgLimits): Promise<{
  allowed: boolean;
  spentAed: number | null;
  budgetAed: number;
  warning: "NONE" | "80" | "100";
}> {
  const limits = limit ?? (await getOrgLimits());
  const { start } = monthBounds();
  const sum = await db.aiUsage.aggregate({
    where: { createdAt: { gte: start } },
    _sum: { estimatedCostUsd: true },
  });
  const usd = sum._sum.estimatedCostUsd ?? 0;
  const rate = await getRate("USD", "AED").catch(() => null);
  const spentAed = rate ? usd * rate.rate : null;
  if (spentAed == null) {
    return { allowed: true, spentAed: null, budgetAed: limits.monthlyAiBudgetAed, warning: "NONE" };
  }
  const warning = spentAed >= limits.monthlyAiBudgetAed ? "100" : spentAed >= limits.monthlyAiBudgetAed * 0.8 ? "80" : "NONE";
  return {
    allowed: limits.monthlyAiBudgetAed === 0 ? false : spentAed < limits.monthlyAiBudgetAed,
    spentAed,
    budgetAed: limits.monthlyAiBudgetAed,
    warning,
  };
}

export async function enquiryAllowanceStatus(limit?: OrgLimits): Promise<{
  used: number;
  allowance: number;
  warning: "NONE" | "80" | "100";
  allowed: boolean;
}> {
  const limits = limit ?? (await getOrgLimits());
  const { start } = monthBounds();
  const used = await db.enquiry.count({ where: { createdAt: { gte: start } } });
  const warning = used >= limits.monthlyEnquiryAllowance ? "100" : used >= limits.monthlyEnquiryAllowance * 0.8 ? "80" : "NONE";
  return { used, allowance: limits.monthlyEnquiryAllowance, warning, allowed: limits.monthlyEnquiryAllowance === 0 ? false : used < limits.monthlyEnquiryAllowance };
}
