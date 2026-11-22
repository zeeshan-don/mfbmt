import { db } from "../db";
import { requireTenantId } from "../tenant";
import {
  convertWithPackaging,
  validatePackagingConversions,
  type PackagingConversion,
} from "./units";

/**
 * Product-specific packaging factors.
 *
 * A factor is stored only when an operator explicitly configures it. Reading a
 * product with no configuration returns an empty list, which makes every
 * packaging conversion unknown rather than assuming a default.
 */

export type ProductConversionResult =
  | { ok: true; value: number; conversions: PackagingConversion[] }
  | { ok: false; error: string; conversions: PackagingConversion[] };

export async function getProductPackaging(productId: string): Promise<PackagingConversion[]> {
  const rows = await db.productPackaging.findMany({
    where: { productId },
    orderBy: { unit: "asc" },
    select: { unit: true, baseUnit: true, factor: true },
  });
  const validation = validatePackagingConversions(rows);
  return validation.ok ? validation.conversions : [];
}

/**
 * Converts a quantity for one product. The product must belong to the current
 * tenant (enforced by the Prisma tenant guard) and its packaging configuration
 * must be valid. An unconfigured packaging unit remains unknown.
 */
export async function convertProductQuantity(input: {
  productId: string;
  value: number;
  fromUnit: string;
  toUnit: string;
}): Promise<ProductConversionResult> {
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true },
  });
  if (!product) {
    return { ok: false, error: "Product not found in this organization.", conversions: [] };
  }
  const conversions = await getProductPackaging(input.productId);
  const value = convertWithPackaging(input.value, input.fromUnit, input.toUnit, conversions);
  if (value == null) {
    return {
      ok: false,
      error: `No valid conversion from ${input.fromUnit} to ${input.toUnit} is configured for this product.`,
      conversions,
    };
  }
  return { ok: true, value, conversions };
}

/**
 * Replaces a product's packaging configuration. Validation is performed before
 * anything is written, so an invalid factor can never leave a half-configured
 * product. Quantities are not touched.
 */
export async function setProductPackaging(input: {
  productId: string;
  conversions: PackagingConversion[];
}): Promise<{ ok: true; conversions: PackagingConversion[] } | { ok: false; error: string }> {
  const organizationId = await requireTenantId();
  const product = await db.product.findFirst({
    where: { id: input.productId },
    select: { id: true },
  });
  if (!product) return { ok: false, error: "Product not found in this organization." };

  const validation = validatePackagingConversions(input.conversions);
  if (!validation.ok) return { ok: false, error: validation.error };

  await db.$transaction(async (tx) => {
    await tx.productPackaging.deleteMany({ where: { productId: input.productId, organizationId } });
    if (validation.conversions.length > 0) {
      await tx.productPackaging.createMany({
        data: validation.conversions.map((conversion) => ({
          organizationId,
          productId: input.productId,
          unit: conversion.unit,
          baseUnit: conversion.baseUnit,
          factor: conversion.factor,
        })),
      });
    }
  });

  return { ok: true, conversions: validation.conversions };
}
