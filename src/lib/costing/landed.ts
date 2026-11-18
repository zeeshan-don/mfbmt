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
  /** When true, an unstated supplier tax makes the total incomplete. */
  taxEnabled: boolean;
};

export type LandedCost = {
  currency: string;
  /** Currency the offer was quoted in, or null when the offer did not state one. */
  sourceCurrency: string | null;
  currencyKnown: boolean;
  /** Quantity that would actually be purchased (MOQ applied). */
  effectiveQuantity: number;
  requestedQuantity: number;
  /** Units bought only because of the supplier's MOQ. */
  excessQuantity: number;
  productCost: number | null;
  shipping: number | null;
  otherCharges: number | null;
  taxes: number | null;
  total: number | null;
  /** Cost per requested unit, including overbuy but excluding unallocated freight. */
  effectiveUnitCost: number | null;
  onlyProductCost: boolean;
  complete: boolean;
  missing: string[];
  notes: string[];
  fx: { rate: number; source: string | null; at: Date | null } | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Total estimated landed cost = goods + freight + other known charges + taxes.
 *
 * Unknown components are never invented and never treated as zero: they are
 * listed in `missing`, the total stays null, and `complete` is false so the
 * offer cannot be presented as the cheapest comparable option.
 *
 * An offer without a currency is not assumed to be in the target currency.
 */
export function computeLandedCost(input: LandedCostInput): LandedCost {
  const missing: string[] = [];
  const notes: string[] = [];
  const currency = input.targetCurrency.toUpperCase();

  const sourceCurrency = input.currency ? input.currency.trim().toUpperCase() : null;
  const currencyKnown = Boolean(sourceCurrency);
  if (!currencyKnown) {
    missing.push("Currency");
    notes.push("The supplier did not state a currency, so the cost cannot be converted or compared.");
  }

  const requestedQuantity = Math.max(0, input.quantity || 0);
  const moq = input.moq != null && Number.isFinite(input.moq) && input.moq > 0 ? input.moq : null;
  const effectiveQuantity = moq != null ? Math.max(requestedQuantity, moq) : requestedQuantity;
  const excessQuantity = Math.max(0, round4(effectiveQuantity - requestedQuantity));

  const needsConversion = currencyKnown && sourceCurrency !== currency;
  const rate = !currencyKnown ? null : needsConversion ? input.fxRate : 1;

  if (needsConversion && (rate == null || !Number.isFinite(rate) || rate <= 0)) {
    missing.push("Exchange rate");
    notes.push(
      `No documented ${sourceCurrency} → ${currency} rate is available, so this cost cannot be compared fairly.`,
    );
  }

  if (input.unitPrice == null || !Number.isFinite(input.unitPrice)) {
    missing.push("Unit price");
  }

  const convertible = rate != null && Number.isFinite(rate) && rate > 0;
  const convert = (value: number | null): number | null =>
    value != null && Number.isFinite(value) && convertible ? round2(value * rate) : null;

  const productCost =
    input.unitPrice != null && Number.isFinite(input.unitPrice) && convertible
      ? round2(input.unitPrice * effectiveQuantity * rate)
      : null;

  if (input.shippingCost == null) missing.push("Shipping");
  else if (!convertible) missing.push("Shipping conversion");

  if (input.otherCharges == null) missing.push("Other charges");
  else if (!convertible) missing.push("Other charges conversion");

  const taxesKnown = input.taxes != null && Number.isFinite(input.taxes);
  if (input.taxEnabled && !taxesKnown) {
    missing.push("Supplier tax");
    notes.push("Supplier tax is included in this comparison but the offer does not state it.");
  }

  const shipping = input.shippingCost != null ? convert(input.shippingCost) : null;
  const otherCharges = input.otherCharges != null ? convert(input.otherCharges) : null;
  const taxes = taxesKnown ? convert(input.taxes as number) : input.taxEnabled ? null : 0;

  if (moq != null && effectiveQuantity > requestedQuantity) {
    notes.push(
      `Supplier requires a minimum order of ${moq}, so ${effectiveQuantity} would be purchased and ${excessQuantity} would stay in stock.`,
    );
  }

  const components = [productCost, shipping, otherCharges, taxes];
  const allKnown = components.every((value) => value != null);
  const total = allKnown
    ? round2(components.reduce<number>((sum, value) => sum + (value ?? 0), 0))
    : null;

  const complete = missing.length === 0 && total != null;

  if (!complete && input.unitPrice != null) {
    notes.push("The total is an estimate because some charges are not known yet.");
  }

  const effectiveUnitCost =
    productCost != null && requestedQuantity > 0 ? round2(productCost / requestedQuantity) : null;

  return {
    currency,
    sourceCurrency,
    currencyKnown,
    effectiveQuantity,
    requestedQuantity,
    excessQuantity,
    productCost,
    shipping,
    otherCharges,
    taxes,
    total,
    effectiveUnitCost,
    onlyProductCost: complete && input.shippingCost === 0 && input.otherCharges === 0,
    complete,
    missing: [...new Set(missing)],
    notes,
    fx: needsConversion
      ? { rate: input.fxRate ?? 0, source: input.fxSource ?? null, at: input.fxFetchedAt ?? null }
      : null,
  };
}

export function money(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${currency.toUpperCase()} ${value.toLocaleString("en-AE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
