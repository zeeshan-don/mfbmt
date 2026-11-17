import { db } from "../db";
import { parseJson } from "../json";
import { claimJob, completeJob, failJob, releaseStaleJobs } from "./jobs";
import { processInboundMessage, extractEnquiryById, checkEnquiryInventory } from "./enquiry";
import { ensureSourcingApproval } from "./approvals";
import { runSourcingForItem } from "../sourcing/engine";
import { sendSupplierQuoteRequest } from "./supplierQuotes";
import { JOB_TYPES } from "../constants";

/**
 * Executes one job. Handlers are idempotent: a retried job must not duplicate
 * enquiries, searches, offers or outbound messages.
 */
export async function processJob(jobId: string): Promise<{ ok: boolean; message: string }> {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: "Job not found" };
  const payload = parseJson<Record<string, string>>(job.payloadJson, {});

  switch (job.type) {
    case JOB_TYPES.INGEST_MESSAGE: {
      if (!payload.messageId) throw new Error("Missing messageId");
      const result = await processInboundMessage(payload.messageId);
      return { ok: true, message: `Message handled: ${result.outcome}` };
    }
    case JOB_TYPES.EXTRACT_ENQUIRY: {
      if (!payload.enquiryId) throw new Error("Missing enquiryId");
      const result = await extractEnquiryById(payload.enquiryId);
      return {
        ok: true,
        message: `${result.items} product line${result.items === 1 ? "" : "s"} extracted${
          result.requiresReview ? " (review needed)" : ""
        }`,
      };
    }
    case JOB_TYPES.CHECK_INVENTORY: {
      if (!payload.enquiryId) throw new Error("Missing enquiryId");
      const count = await checkEnquiryInventory(payload.enquiryId);
      return { ok: true, message: `Stock checked for ${count} line${count === 1 ? "" : "s"}` };
    }
    case JOB_TYPES.RUN_SOURCING: {
      if (!payload.enquiryItemId) throw new Error("Missing enquiryItemId");
      const result = await runSourcingForItem(payload.enquiryItemId);
      if (result.offers > 0) {
        await ensureSourcingApproval(payload.enquiryItemId);
      }
      return { ok: true, message: result.message };
    }
    case JOB_TYPES.SEND_SUPPLIER_RFQ: {
      if (!payload.supplierQuoteId) throw new Error("Missing supplierQuoteId");
      const result = await sendSupplierQuoteRequest(payload.supplierQuoteId);
      return { ok: result.ok, message: result.detail };
    }
    default:
      return { ok: false, message: `Unknown job type ${job.type}` };
  }
}

export async function runNextJob(workerId: string): Promise<boolean> {
  await releaseStaleJobs();
  const job = await claimJob(workerId);
  if (!job) return false;
  try {
    const result = await processJob(job.id);
    if (result.ok) {
      await completeJob(job.id, result.message);
    } else {
      await failJob(job.id, result.message);
    }
  } catch (error) {
    await failJob(job.id, error instanceof Error ? error.message : "Unknown job error");
  }
  return true;
}
