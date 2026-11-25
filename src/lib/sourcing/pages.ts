import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env";

const USER_AGENT = "OrchestratorProcurementBot/1.0 (+official supplier research; respects robots.txt)";
const MAX_BYTES = 400_000;
const MAX_REDIRECTS = 3;
const robotsCache = new Map<string, { disallow: string[]; allowed: boolean }>();

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

export function ipIsPrivate(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version !== 6) return true;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

function hostnameIsBlocked(hostname: string): boolean {
  // URL.hostname keeps the brackets around IPv6 literals ("[::1]").
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "metadata.google.internal") return true;
  if (isIP(host)) return ipIsPrivate(host);
  return false;
}

/**
 * Resolves a hostname and refuses anything that lands on a private, loopback,
 * link-local or otherwise non-public address. This closes the DNS-rebinding hole
 * that a hostname-only check leaves open (e.g. a public name pointing at 10.x).
 */
export async function hostResolvesPublic(hostname: string): Promise<boolean> {
  if (hostnameIsBlocked(hostname)) return false;
  const host = hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => !ipIsPrivate(entry.address));
  } catch {
    return false;
  }
}

export function isSafePublicUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    return !hostnameIsBlocked(url.hostname);
  } catch {
    return false;
  }
}

export async function robotsAllows(raw: string): Promise<boolean> {
  try {
    const url = new URL(raw);
    const origin = url.origin;
    const cached = robotsCache.get(origin);
    let entry = cached;
    if (!entry) {
      if (!(await hostResolvesPublic(url.hostname))) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(`${origin}/robots.txt`, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
          cache: "no-store",
          redirect: "manual",
        });
        if (!response.ok) {
          entry = { disallow: [], allowed: true };
        } else {
          const text = (await response.text()).slice(0, 100_000);
          const disallow: string[] = [];
          let applies = false;
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim().toLowerCase();
            if (trimmed.startsWith("user-agent:")) {
              const agent = trimmed.slice("user-agent:".length).trim();
              applies = agent === "*" || agent.includes("mfbmt");
            } else if (applies && trimmed.startsWith("disallow:")) {
              const path = trimmed.slice("disallow:".length).trim();
              if (path) disallow.push(path);
            }
          }
          entry = { disallow, allowed: true };
        }
      } catch {
        entry = { disallow: [], allowed: true };
      } finally {
        clearTimeout(timer);
      }
      robotsCache.set(origin, entry);
    }
    const path = url.pathname || "/";
    if (entry.disallow.some((rule) => path.startsWith(rule))) return false;
    return entry.allowed;
  } catch {
    return false;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type FetchFailure = { ok: false; text: ""; status: "ROBOTS_DISALLOWED" | "FAILED" | "TOO_LARGE"; note?: string };

/**
 * Fetches a public supplier page.
 *
 * Every hop is validated: the initial URL and each redirect target must be
 * http(s), must not embed credentials, and must resolve (via DNS) only to public
 * addresses. Redirects are followed manually, so an unvalidated Location header
 * is never followed by the HTTP client itself.
 */
export type PublicResource =
  | {
      ok: true;
      status: "OK";
      finalUrl: string;
      contentType: string;
      body: Buffer;
      text: string;
      links: string[];
      truncated: boolean;
    }
  | FetchFailure;

/**
 * Fetches a public HTML page or a public document (PDF/XLSX/image/text) for
 * supplier research. The same SSRF, DNS, redirect, robots, timeout and
 * content-type rules as fetchPublicPage apply. The caller decides whether a
 * document type is supported.
 */
export async function fetchPublicResource(
  raw: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<PublicResource> {
  const maxBytes = Math.max(10_000, Math.min(options.maxBytes ?? 750_000, 2_000_000));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? env.SEARCH_REQUEST_TIMEOUT_MS, 60_000));
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isSafePublicUrl(current)) return { ok: false, text: "", status: "FAILED", note: "URL is not allowed." };
    const url = new URL(current);
    if (!(await hostResolvesPublic(url.hostname))) {
      return { ok: false, text: "", status: "FAILED", note: "The address resolves to a non-public network." };
    }
    if (!(await robotsAllows(current))) {
      return { ok: false, text: "", status: "ROBOTS_DISALLOWED", note: "The site's robots.txt disallows automated reading." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png,image/webp",
        },
        signal: controller.signal,
        redirect: "manual",
        cache: "no-store",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, text: "", status: "FAILED", note: `HTTP ${response.status} without a location.` };
        const next = new URL(location, current).toString();
        if (!isSafePublicUrl(next)) {
          return { ok: false, text: "", status: "FAILED", note: "A redirect pointed to a disallowed address." };
        }
        current = next;
        continue;
      }
      if (!response.ok) return { ok: false, text: "", status: "FAILED", note: `HTTP ${response.status}` };
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const allowed =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml") ||
        contentType.includes("text/plain") ||
        contentType.includes("application/pdf") ||
        contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") ||
        contentType.includes("application/vnd.ms-excel") ||
        contentType.includes("text/csv") ||
        contentType.includes("image/jpeg") ||
        contentType.includes("image/png") ||
        contentType.includes("image/webp");
      if (!allowed) {
        return { ok: false, text: "", status: "FAILED", note: `Content type is not supported: ${contentType.slice(0, 80)}` };
      }

      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      if (reader) {
        while (received < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            if (received >= maxBytes) truncated = true;
          }
        }
        await reader.cancel().catch(() => undefined);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const htmlLike = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
      const links = htmlLike
        ? [...body.toString("utf8").matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((match) => match[1]).slice(0, 150)
        : [];
      return {
        ok: true,
        status: "OK",
        finalUrl: current,
        contentType,
        body,
        text: htmlLike ? htmlToText(body.toString("utf8")).slice(0, 120_000) : body.toString("utf8"),
        links,
        truncated,
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        status: "FAILED",
        note: error instanceof Error ? error.message.slice(0, 120) : "Fetch failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, text: "", status: "FAILED", note: "Too many redirects." };
}

export async function fetchPublicPage(raw: string): Promise<
  | { ok: true; text: string; status: "OK"; finalUrl: string; links: string[] }
  | FetchFailure
> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isSafePublicUrl(current)) return { ok: false, text: "", status: "FAILED", note: "URL is not allowed." };
    const url = new URL(current);
    if (!(await hostResolvesPublic(url.hostname))) {
      return { ok: false, text: "", status: "FAILED", note: "The address resolves to a non-public network." };
    }
    if (hop === 0 && !(await robotsAllows(current))) {
      return { ok: false, text: "", status: "ROBOTS_DISALLOWED", note: "The site's robots.txt disallows automated reading." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.SEARCH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
        redirect: "manual",
        cache: "no-store",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, text: "", status: "FAILED", note: `HTTP ${response.status} without a location.` };
        const next = new URL(location, current).toString();
        if (!isSafePublicUrl(next)) {
          return { ok: false, text: "", status: "FAILED", note: "A redirect pointed to a disallowed address." };
        }
        current = next;
        continue;
      }

      if (!response.ok) return { ok: false, text: "", status: "FAILED", note: `HTTP ${response.status}` };
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return { ok: false, text: "", status: "FAILED", note: "Not an HTML page." };
      }

      const reader = response.body?.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (received < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
          }
        }
        await reader.cancel().catch(() => undefined);
      }
      const html = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
        .map((match) => match[1])
        .slice(0, 100);
      return { ok: true, text: htmlToText(html).slice(0, 60_000), status: "OK", finalUrl: current, links };
    } catch (error) {
      return {
        ok: false,
        text: "",
        status: "FAILED",
        note: error instanceof Error ? error.message.slice(0, 120) : "Fetch failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, text: "", status: "FAILED", note: "Too many redirects." };
}
