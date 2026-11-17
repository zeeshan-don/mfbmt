// Business dates are shown in the company's time zone, not the server's (UTC in production).
const DISPLAY_TZ = process.env.BUSINESS_TIMEZONE || "Asia/Dubai";

function withTimeZone<T extends Intl.DateTimeFormatOptions>(options: T): T & { timeZone?: string } {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: DISPLAY_TZ });
    return { ...options, timeZone: DISPLAY_TZ };
  } catch {
    return options;
  }
}

export function formatMoney(value: number | null | undefined, currency = "AED"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${currency.toUpperCase()} ${value.toLocaleString("en-AE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatQty(value: number | null | undefined, unit = "pcs"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted} ${unit}`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-GB", withTimeZone({ day: "2-digit", month: "short", year: "numeric" }));
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-GB", withTimeZone({
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }));
}

export function timeAgo(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(date);
}

export function truncate(text: string, max = 110): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
