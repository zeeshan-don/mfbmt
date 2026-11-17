import { env } from "../env";

const USER_AGENT = "MFBMTProcurementBot/1.0 (+official supplier research; respects robots.txt)";
const MAX_BYTES = 400_000;
const robotsCache = new Map<string, { disallow: string[]; allowed: boolean }>();

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export function isSafePublicUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (isPrivateHost(url.hostname)) return false;
    if (url.username || url.password) return false;
    return true;
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(`${origin}/robots.txt`, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
          cache: "no-store",
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

export async function fetchPublicPage(raw: string): Promise<{
  ok: boolean;
  text: string;
  status: "OK" | "ROBOTS_DISALLOWED" | "FAILED" | "TOO_LARGE";
  note?: string;
}> {
  if (!isSafePublicUrl(raw)) return { ok: false, text: "", status: "FAILED", note: "URL is not allowed." };
  if (!(await robotsAllows(raw))) {
    return { ok: false, text: "", status: "ROBOTS_DISALLOWED", note: "The site's robots.txt disallows automated reading." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.SEARCH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(raw, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
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
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { ok: true, text: htmlToText(html).slice(0, 60_000), status: "OK" };
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
