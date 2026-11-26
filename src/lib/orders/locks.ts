import type { Prisma } from "@prisma/client";
import { requireTenantId } from "../tenant";

/**
 * Shared order-mutation locks.
 *
 * Every transaction that changes a sales order's commercial or fulfilment
 * obligations takes the same row lock on the parent `SalesOrder` first. That
 * makes closure, procurement, receipts, dispatch, invoicing and payments
 * serialize against each other for one order, so an obligation cannot be
 * created after closure validated the order.
 *
 * Raw SQL bypasses the Prisma tenant guard, so every statement includes the
 * organization id from trusted server-side context. Lock order is always:
 *   SalesOrder -> PurchaseOrder / CustomerInvoice / SupplierBill -> stock rows.
 */

export type LockedSalesOrder = {
  id: string;
  organizationId: string;
  orderNumber: string;
  status: string;
  currency: string;
  total: Prisma.Decimal;
};

export type LockedPurchaseOrder = {
  id: string;
  organizationId: string;
  salesOrderId: string;
  status: string;
  version: number;
  total: Prisma.Decimal;
};

export class OrderLockError extends Error {
  readonly code: "NOT_FOUND" | "TERMINAL";
  constructor(code: "NOT_FOUND" | "TERMINAL", message: string) {
    super(message);
    this.name = "OrderLockError";
    this.code = code;
  }
}

const TERMINAL = new Set(["CLOSED", "CANCELLED"]);

/**
 * Locks one tenant-owned sales order and returns its current state.
 * `allowTerminal` is only for read-only closure summaries; mutating callers must
 * leave it false so a closed order cannot accept new obligations.
 */
export async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  options: { allowTerminal?: boolean } = {},
): Promise<LockedSalesOrder> {
  const organizationId = await requireTenantId();
  const rows = await tx.$queryRaw<LockedSalesOrder[]>`
    SELECT "id", "organizationId", "orderNumber", "status", "currency", "total"
    FROM "SalesOrder"
    WHERE "id" = ${salesOrderId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  const order = rows[0];
  if (!order) throw new OrderLockError("NOT_FOUND", "Sales order not found.");
  if (!options.allowTerminal && TERMINAL.has(order.status)) {
    throw new OrderLockError("TERMINAL", "This sales order is closed; no further obligation can be changed.");
  }
  return order;
}

/** Locks one tenant-owned purchase order (always after its sales order). */
export async function lockPurchaseOrder(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
): Promise<LockedPurchaseOrder | null> {
  const organizationId = await requireTenantId();
  const rows = await tx.$queryRaw<LockedPurchaseOrder[]>`
    SELECT "id", "organizationId", "salesOrderId", "status", "version", "total"
    FROM "PurchaseOrder"
    WHERE "id" = ${purchaseOrderId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Locks one tenant-owned customer invoice (after its sales order). */
export async function lockCustomerInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<{ id: string; salesOrderId: string; status: string } | null> {
  const organizationId = await requireTenantId();
  const rows = await tx.$queryRaw<Array<{ id: string; salesOrderId: string; status: string }>>`
    SELECT "id", "salesOrderId", "status"
    FROM "CustomerInvoice"
    WHERE "id" = ${invoiceId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Locks one tenant-owned supplier bill and returns its purchase order link. */
export async function lockSupplierBill(
  tx: Prisma.TransactionClient,
  billId: string,
): Promise<{ id: string; purchaseOrderId: string | null; status: string } | null> {
  const organizationId = await requireTenantId();
  const rows = await tx.$queryRaw<Array<{ id: string; purchaseOrderId: string | null; status: string }>>`
    SELECT "id", "purchaseOrderId", "status"
    FROM "SupplierBill"
    WHERE "id" = ${billId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Locks usable inventory stock rows for one product in a deterministic order.
 * The ordered lock set prevents two dispatches from deadlocking while taking
 * the same locations in different sequences.
 */
export async function lockStockForProduct(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<Array<{ id: string; locationId: string; quantityOnHand: Prisma.Decimal; quantityReserved: Prisma.Decimal }>> {
  const organizationId = await requireTenantId();
  return tx.$queryRaw`
    SELECT "id", "locationId", "quantityOnHand", "quantityReserved"
    FROM "InventoryStock"
    WHERE "productId" = ${productId}
      AND "organizationId" = ${organizationId}
      AND "quantityOnHand" > 0
    ORDER BY "locationId" ASC, "id" ASC
    FOR UPDATE
  `;
}

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL.has(status);
}
