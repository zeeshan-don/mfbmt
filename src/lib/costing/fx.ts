import { db } from "../db";
import { env } from "../env";

export type RateResult = {
  rate: number;
  source: string;
  fetchedAt: Date;
  pair: string;
};

const CACHE_HOURS = 12;

function fixedUsdAed(): number {
  return env.FIXED_USD_AED;
}

async function fetchProviderRate(from: string, to: string): Promise<RateResult | null> {
  if (env.EXCHANGE_RATE_PROVIDER === "fixed") {
    const usdAed = fixedUsdAed();
    const toUsd = (currency: string) => {
      if (currency === "USD") return 1;
      if (currency === "AED") return 1 / usdAed;
      return null;
    };
    const fromUsd = toUsd(from);
    const toUsdRate = toUsd(to);
    if (fromUsd == null || toUsdRate == null) return null;
    return {
      rate: toUsdRate / fromUsd,
      source: "Configured fixed rate (USD/AED peg)",
      fetchedAt: new Date(),
      pair: `${from}/${to}`,
    };
  }

  if (env.EXCHANGE_RATE_PROVIDER === "exchangerate_host" && env.EXCHANGE_RATE_API_KEY) {
    try {
      const url = new URL("https://api.exchangerate.host/convert");
      url.searchParams.set("access_key", env.EXCHANGE_RATE_API_KEY);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      url.searchParams.set("amount", "1");
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (!response.ok) return null;
      const payload = (await response.json()) as { result?: number; info?: { rate?: number } };
      const rate = payload.result ?? payload.info?.rate;
      if (!rate || !Number.isFinite(rate)) return null;
      return { rate, source: "exchangerate.host", fetchedAt: new Date(), pair: `${from}/${to}` };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Returns a conversion rate together with its source and timestamp, or null
 * when no rate is available. Callers must mark the comparison as incomplete
 * rather than assuming a rate.
 */
export async function getRate(from: string, to: string): Promise<RateResult | null> {
  const base = from.toUpperCase();
  const quote = to.toUpperCase();
  if (base === quote) {
    return { rate: 1, source: "Same currency", fetchedAt: new Date(), pair: `${base}/${quote}` };
  }

  const freshAfter = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000);
  const cached = await db.exchangeRate.findFirst({
    where: { base, quote, fetchedAt: { gte: freshAfter } },
    orderBy: { fetchedAt: "desc" },
  });
  if (cached) {
    return { rate: cached.rate, source: cached.source, fetchedAt: cached.fetchedAt, pair: `${base}/${quote}` };
  }

  const fetched = await fetchProviderRate(base, quote);
  if (!fetched) return null;

  await db.exchangeRate.create({
    data: { base, quote, rate: fetched.rate, source: fetched.source, fetchedAt: fetched.fetchedAt },
  });
  return fetched;
}
