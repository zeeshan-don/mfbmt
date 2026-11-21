"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { stringifyJson } from "@/lib/json";
import { sendSupplierQuoteRequest } from "@/lib/workflow/supplierQuotes";
import { supplierSendGuard } from "@/lib/suppliers/sendGuard";

/**
 * Batch approval is still an explicit owner decision for each supplier message.
 * One click creates a durable APPROVED approval row per quote, then uses the
 * normal guarded sender. A blocked/excluded supplier or a daily cap stops that
 * message without affecting the rest of the batch.
 */
export async function approveSupplierDraftsAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");

  const ids = [...new Set(formData.getAll("quoteIds").map(String).filter(Boolean))].slice(
    0,
    env.SUPPLIER_DAILY_SEND_LIMIT,
  );
  if (ids.length === 0) redirect("/suppliers/outreach?error=Choose+at+least+one+draft");

  let sent = 0;
  const failures: string[] = [];

  for (const quoteId of ids) {
    const quote = await db.supplierQuote.findUnique({
      where: { id: quoteId },
      include: { supplier: { select: { name: true } } },
    });
    if (!quote || quote.status !== "DRAFT") {
      failures.push("A selected draft is no longer waiting.");
      continue;
    }

    const guard = await supplierSendGuard(quote.supplierId);
    if (!guard.ok) {
      failures.push(`${quote.supplier.name}: ${guard.error ?? "sending is blocked"}`);
      await db.supplierQuote.update({
        where: { id: quote.id },
        data: { lastError: guard.error ?? "Sending is blocked." },
      });
      continue;
    }

    const approval = await db.approval.create({
      data: {
        type: "SUPPLIER_QUOTE_SEND",
        entityType: "SupplierQuote",
        entityId: quote.id,
        enquiryId: quote.enquiryItemId
          ? (await db.enquiryItem.findUnique({ where: { id: quote.enquiryItemId }, select: { enquiryId: true } }))?.enquiryId ?? null
          : null,
        status: "APPROVED",
        requestedBy: quote.subject ? "draft queue" : "draft queue",
        decidedById: user.id,
        decidedAt: new Date(),
        reason: "Approved as part of the owner's batch draft review.",
        payloadJson: stringifyJson({
          supplier: quote.supplier.name,
          subject: quote.subject,
          to: quote.sentTo ?? null,
          batch: true,
          approvedBy: user.name,
        }),
      },
    });

    const result = await sendSupplierQuoteRequest(quote.id);
    if (result.ok) {
      sent += 1;
      await writeAudit({
        actorId: user.id,
        actorLabel: user.name,
        action: "supplier_quote.batch_sent",
        entityType: "SupplierQuote",
        entityId: quote.id,
        meta: { supplier: quote.supplier.name, approvalId: approval.id },
      });
    } else {
      await db.approval.update({
        where: { id: approval.id },
        data: { status: "CANCELLED", reason: result.detail.slice(0, 500) },
      });
      await db.supplierQuote.update({ where: { id: quote.id }, data: { lastError: result.detail.slice(0, 500) } });
      failures.push(`${quote.supplier.name}: ${result.detail}`);
    }
  }

  revalidatePath("/suppliers/outreach");
  revalidatePath("/suppliers");
  const query = new URLSearchParams({ sent: String(sent) });
  if (failures.length) query.set("error", failures.join(" · ").slice(0, 700));
  redirect(`/suppliers/outreach?${query.toString()}`);
}
