/** Shared status values and the plain-language labels shown to the owner. */

export const ROLES = { OWNER: "OWNER", STAFF: "STAFF" } as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = [
  "enquiries.view",
  "enquiries.review",
  "sourcing.view",
  "inventory.view",
  "suppliers.view",
  "quotations.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const CLASSIFICATIONS = {
  RFQ: "Customer quotation request",
  AVAILABILITY: "Product availability question",
  FOLLOW_UP: "Existing customer follow-up",
  SUPPLIER: "Supplier communication",
  BUSINESS_OTHER: "Other business message",
  PERSONAL: "Family / personal message",
  UNCLEAR: "Unclear message",
} as const;
export type Classification = keyof typeof CLASSIFICATIONS;

export const ENQUIRY_STATUS_LABELS: Record<string, string> = {
  NEW: "Just received",
  EXTRACTING: "Reading the request",
  NEEDS_REVIEW: "Needs your review",
  READY: "Ready to source",
  SOURCING: "Finding suppliers",
  AWAITING_APPROVAL: "Awaiting your approval",
  APPROVED: "Supplier approved",
  QUOTED: "Quotation prepared",
  CLOSED: "Completed",
  REJECTED: "Rejected",
  IGNORED: "Not a quotation request",
};

export const INVENTORY_STATUS_LABELS: Record<string, string> = {
  UNCHECKED: "Not checked yet",
  AVAILABLE: "In stock",
  PARTIAL: "Partly in stock",
  SHORT: "Not in stock",
  NONE: "Not in stock",
  CLARIFY: "Details needed",
  NOT_CONFIGURED: "Inventory not set up",
};

export const SOURCING_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  QUEUED: "Queued",
  SEARCHING: "Searching suppliers",
  RESULTS_READY: "Options ready",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  NO_RESULTS: "No verified supplier found",
  FAILED: "Search failed",
  NOT_REQUIRED: "Covered by stock",
};

export const MATCH_STATUS_LABELS: Record<string, string> = {
  EXACT: "Exact match",
  EQUIVALENT: "Approved equivalent",
  POSSIBLE: "Possible match — not verified",
  INSUFFICIENT: "Not enough information",
  NO_MATCH: "Does not match",
};

export const OFFER_STATUS_LABELS: Record<string, string> = {
  DISCOVERED: "Supplier discovered",
  LISTING_FOUND: "Product listing found",
  POSSIBLE_MATCH: "Possible match — not verified",
  VERIFIED: "Specification verified",
  CONTACTED: "Supplier contacted",
  QUOTE_RECEIVED: "Quotation received",
  PRICE_CONFIRMED: "Price confirmed",
  EXPIRED: "Offer expired",
  UNAVAILABLE: "Supplier unavailable",
};

export const OFFER_VERIFICATION_LABELS: Record<string, string> = {
  UNVERIFIED: "Not verified",
  PARTIAL: "Partly verified",
  VERIFIED: "Verified",
  EXPIRED: "Expired",
};

export const CONTACT_KINDS = {
  CUSTOMER: "Customer",
  SUPPLIER: "Supplier",
  FAMILY: "Family",
  PERSONAL: "Personal",
  OTHER: "Other",
  UNKNOWN: "Unknown",
} as const;

export const EXCLUDED_CATEGORIES = {
  FAMILY: "Family",
  PERSONAL: "Personal",
  TRUSTED_SUPPLIER: "Trusted supplier",
  CUSTOMER: "Customer",
  OTHER: "Other",
} as const;

/** Categories whose messages are never retained, classified by AI or sourced. */
export const PRIVATE_CATEGORIES = ["FAMILY", "PERSONAL", "OTHER"] as const;

/** The only durable queue states. UI, health and the worker share this list. */
export const JOB_STATUS = {
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];
export const ACTIVE_JOB_STATUSES: JobStatus[] = [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING];

export const JOB_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Waiting to run",
  PROCESSING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const JOB_TYPES = {
  INGEST_MESSAGE: "INGEST_MESSAGE",
  EXTRACT_ENQUIRY: "EXTRACT_ENQUIRY",
  CHECK_INVENTORY: "CHECK_INVENTORY",
  RUN_SOURCING: "RUN_SOURCING",
  SEND_SUPPLIER_RFQ: "SEND_SUPPLIER_RFQ",
  BUILD_QUOTATION: "BUILD_QUOTATION",
  SYNC_EMAIL: "SYNC_EMAIL",
  RENEW_EMAIL_WATCH: "RENEW_EMAIL_WATCH",
  PURGE_EXPIRED: "PURGE_EXPIRED",
  OPS_CHECK: "OPS_CHECK",
  OPS_DIGEST: "OPS_DIGEST",
} as const;

export const integrationKeys = [
  "WHATSAPP",
  "GMAIL",
  "MICROSOFT365",
  "AI_PROVIDER",
  "WEB_SEARCH",
  "OCR",
  "STORAGE",
  "EXCHANGE_RATE",
] as const;
export type IntegrationKey = (typeof integrationKeys)[number];

/** Integration status values shown in Settings. */
export const INTEGRATION_STATUS_LABELS: Record<string, string> = {
  NOT_CONFIGURED: "Not configured",
  CONNECTING: "Connecting",
  CONNECTED: "Connected and tested",
  NEEDS_ATTENTION: "Needs attention",
  DISCONNECTED: "Disconnected",
};

export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key.replaceAll("_", " ").toLowerCase();
}
