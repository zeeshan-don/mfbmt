import { describe, expect, it } from "vitest";
import { detectCurrency, extractPriceFromText } from "../src/lib/sourcing/extract";
import { getRate } from "../src/lib/costing/fx";

describe("multi-currency supplier evidence", () => {
  it("recognises EUR, CNY, SAR, INR and KRW when the page states them", () => {
    expect(extractPriceFromText("EUR 1250 per pc")).toMatchObject({ unitPrice: 1250, currency: "EUR" });
    expect(extractPriceFromText("CNY 8800 / set")).toMatchObject({ unitPrice: 8800, currency: "CNY" });
    expect(extractPriceFromText("SAR 4200 per unit")).toMatchObject({ unitPrice: 4200, currency: "SAR" });
    expect(extractPriceFromText("INR 150000 per pc")).toMatchObject({ unitPrice: 150000, currency: "INR" });
    expect(extractPriceFromText("KRW 900000 per set")).toMatchObject({ unitPrice: 900000, currency: "KRW" });
  });

  it("does not invent a currency when the listing omits one", () => {
    const result = extractPriceFromText("Price: 1250 per pc");
    expect(result.unitPrice).toBe(1250);
    expect(result.currency).toBeNull();
    expect(detectCurrency("price on request")).toBeNull();
  });

  it("returns an identity rate without a provider call", async () => {
    await expect(getRate("USD", "USD")).resolves.toMatchObject({ rate: 1, pair: "USD/USD" });
  });
});
