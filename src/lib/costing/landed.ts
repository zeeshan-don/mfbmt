export type LandedCostInput = {
  unitPrice: number | null;
  currency: string | null;
  quantity: number;
  moq: number | null;
  shippingCost: number | null;
  otherCharges: number | null;
  taxes: number | null;
  fxRate: number | null;
  fxSource?: string | null;
  fxFetchedAt?: Date | null;
  targetCurrency: string;
  taxEnabled: boolean;
};

export type LandedCost = {
  currency: string;
  effectiveQuantity: number;
  productCost: number | null;
  shipping: number | null;
  otherCharges: number | null;
  taxes: number | null;
  total: number | null;
  unitPriceOnly: boolean;
  complete: boolean;
  missing: string[];
  notes: string[];
  fx: { rate: number; source: string | null; at: Date | null } | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Total estimated landed cost = goods + freight + other known charges + taxes.
 * Unknown components are never invented: they are listed in `missing` and the
 * total is marked incomplete so it is never compared as a confirmed cost.
 */
export function computeLandedCost(input: LandedCostInput): LandedCost {
  const missing: string[] = [];
  const notes: string[] = [];
  const currency = input.targetCurrency.toUpperCase();
  const effectiveQuantity = Math.max(input.quantity, input.moq ?? 0) || input.quantity;

  const needsConversion = Boolean(input.currency) && input.currency!.toUpperCase() !== currency;
  const rate = needsConversion ? input.fxRate : 1;
  if (needsConversion && (rate == null || !Number.isFinite(rate) || rate <= 0)) {
    missing.push("Exchange rate");
    notes.push(`No documented ${input.currency} → ${currency} rate is available, so costs cannot be compared fairly.`);
  }

  if (input.unitPrice == null || !Number.isFinite(input.unitPrice)) {
    missing.push("Unit price");
  }

  const convert = (value: number) => (rate && Number.isFinite(rate) ? round2(value * rate) : null);

  const productCost =
    input.unitPrice != null && Number.isFinite(input.unitPrice) && rate != null
      ? convert(input.unitPrice * effectiveQuantity)
      : null;

  const shipping = input.shippingCost != null ? convert(input.shippingCost) : null;
  const otherCharges = input.otherCharges != null ? convert(input.otherCharges) : null;

  if (input.shippingCost == null) missing.push("Shipping");
  if (input.otherCharges == null) missing.push("Other charges");
  if (input.moq != null && input.moq > input.quantity) {
    notes.push(`Supplier requires a minimum order of ${input.moq}, so cost is calculated for ${effectiveQuantity}.`);
  }

  // Purchase-side VAT is normally recoverable for a trading company, so an
  // unquoted tax line does not make the comparison incomplete. Only a tax
  // amount the supplier actually states is added.
  const taxes = input.taxes != null ? convert(input.taxes) : 0;

  const components = [productCost, shipping, otherCharges, taxes];
  const knownTotal = components.every((value) => value != null)
    ? round2(components.reduce<number>((sum, value) => sum + (value ?? 0), 0))
    : productCost != null
      ? round2(productCost + (shipping ?? 0) + (otherCharges ?? 0) + (taxes ?? 0))
      : null;

  const complete = missing.length === 0 && knownTotal != null;

  if (!complete && input.unitPrice != null) {
    notes.push("The total is an estimate because some charges are not known yet.");
  }

  return {
    currency,
    effectiveQuantity,
    productCost,
    shipping,
    otherCharges,
    taxes,
    total: knownTotal,
    unitPriceOnly: complete && input.shippingCost === 0 && input.otherCharges === 0,
    complete,
    missing,
    notes,
    fx: needsConversion
      ? { rate: input.fxRate ?? 0, source: input.fxSource ?? null, at: input.fxFetchedAt ?? null }
      : null,
  };
}

export function money(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${currency.toUpperCase()} ${value.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
