import { Prisma } from "@prisma/client";

/**
 * Financial arithmetic for the order lifecycle.
 *
 * Every stored amount is a Prisma Decimal backed by PostgreSQL numeric. No
 * operand in this module is converted to a JavaScript float: binary floating
 * point cannot represent 0.10 exactly and repeated additions drift.
 */
export type Dec = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

export function dec(value?: Prisma.Decimal.Value | null): Prisma.Decimal {
  if (value == null || value === "") return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

/** Currency amounts are stored with four decimal places and displayed at two. */
export function money(value?: Prisma.Decimal.Value | null): Prisma.Decimal {
  return dec(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

/** Quantities keep four decimal places (pcs, kg, m, litres). */
export function qty(value?: Prisma.Decimal.Value | null): Prisma.Decimal {
  return dec(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

export function sum(values: Iterable<Prisma.Decimal.Value>): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  for (const value of values) total = total.plus(dec(value));
  return total;
}

export function equals(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value, tolerance = "0.0001"): boolean {
  return dec(a).minus(dec(b)).abs().lte(dec(tolerance));
}

export function isPositive(value: Prisma.Decimal.Value): boolean {
  return dec(value).gt(0);
}

export function isZero(value: Prisma.Decimal.Value): boolean {
  return equals(value, 0);
}

export function maxDec(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Prisma.Decimal {
  return dec(a).gte(dec(b)) ? dec(a) : dec(b);
}

export function minDec(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Prisma.Decimal {
  return dec(a).lte(dec(b)) ? dec(a) : dec(b);
}

export function toNumber(value: Prisma.Decimal.Value | null | undefined): number {
  if (value == null) return 0;
  return Number(dec(value).toFixed(4));
}

export function toMoneyString(value: Prisma.Decimal.Value | null | undefined): string {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

export type LineTotals = {
  gross: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  net: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  /** Net + tax. Stored per line; the document subtotal is the sum of nets. */
  lineTotal: Prisma.Decimal;
};

/**
 * Gross → discount → net → tax for one line. The discount is a percentage of
 * the gross line value and tax is applied to the discounted net, matching the
 * quotation PDF and the configured organisation tax settings.
 */
export function lineTotals(input: {
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discountPct?: Prisma.Decimal.Value | null;
  taxRatePct?: Prisma.Decimal.Value | null;
}): LineTotals {
  const gross = money(qty(input.quantity).times(money(input.unitPrice)));
  const discountAmount = money(gross.times(dec(input.discountPct)).div(100));
  const net = money(gross.minus(discountAmount));
  const taxAmount = money(net.times(dec(input.taxRatePct)).div(100));
  return { gross, discountAmount, net, taxAmount, lineTotal: money(net.plus(taxAmount)) };
}

export function isCurrencyCode(value: string | null | undefined): boolean {
  return /^[A-Z]{3}$/.test((value ?? "").trim().toUpperCase());
}
