import { db } from "../db";
import { parseJson } from "../json";
import { claimJob, completeJob, failJob, heartbeatJob, releaseExpiredJobs, LEASE_MS } from "./jobs";
import { processInboundMessage, extractEnquiryById, checkEnquiryInventory } from "./enquiry";
import { ensureSourcingApproval } from "./approvals";
import { runSourcingForItem } from "../sourcing/engine";
import { sendSupplierQuoteRequest } from "./supplierQuotes";
import { JOB_TYPES } from "../constants";
import { runWithTenant } from "../tenant";

/**
 * Executes one job. Handlers are idempotent: a retried job must not duplicate
 * enquiries, searches, offers or outbound messages.
 *
 * Long handlers run with a heartbeat so their lease is renewed; if the lease is
 * lost the result is discarded rather than written over a reclaimed job.
 */
export async function processJob(jobId: string, workerId: string): Promise<{ ok: boolean; message: string }> {
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
      return { ok: result.status !== "FAILED", message: result.message };
    }
    case JOB_TYPES.SEND_SUPPLIER_RFQ: {
      if (!payload.supplierQuoteId) throw new Error("Missing supplierQuoteId");
      const result = await sendSupplierQuoteRequest(payload.supplierQuoteId);
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.SYNC_EMAIL: {
      const { syncEmailIntake } = await import("../email/sync");
      const result = await syncEmailIntake({
        trigger: (payload.trigger as "poll" | "push" | "manual") ?? "poll",
      });
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.RENEW_EMAIL_WATCH: {
      const { renewEmailSubscriptions } = await import("../email/sync");
      const result = await renewEmailSubscriptions();
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.PURGE_EXPIRED: {
      const now = new Date();
      const expired = await db.supplierQuote.updateMany({
        where: { status: { in: ["REQUESTED", "AWAITING_APPROVAL", "SENT"] }, expiresAt: { lt: now } },
        data: { status: "EXPIRED" },
      });
      return { ok: true, message: `Expired ${expired.count} supplier request(s).` };
    }
    default:
      return { ok: false, message: `Unknown job type ${job.type}` };
  }
}

/** Runs a handler with a lease heartbeat until it settles. */
async function withHeartbeat<T>(jobId: string, workerId: string, run: () => Promise<T>): Promise<T> {
  const interval = Math.max(5_000, Math.min(LEASE_MS() / 3, 30_000));
  const timer = setInterval(() => {
    void heartbeatJob(jobId, workerId).catch(() => undefined);
  }, interval);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

export async function runNextJob(workerId: string): Promise<boolean> {
  await releaseExpiredJobs();
  const job = await claimJob(workerId);
  if (!job) return false;
  try {
    // Execute inside the owning tenant so every lookup, integration credential
    // and audit entry is scoped to that company.
    const result = await withHeartbeat(job.id, workerId, () =>
      runWithTenant({ organizationId: job.organizationId, source: "job" }, () => processJob(job.id, workerId)),
    );
    if (result.ok) {
      const completed = await completeJob(job.id, workerId, result.message);
      if (!completed) console.warn(`[worker] lost the lease for job ${job.id}; result was not written.`);
    } else {
      const outcome = await failJob(job.id, workerId, result.message);
      if (outcome === "lost") console.warn(`[worker] lost the lease for job ${job.id}; failure was not recorded.`);
    }
  } catch (error) {
    const outcome = await failJob(job.id, workerId, error instanceof Error ? error.message : "Unknown job error");
    if (outcome === "lost") console.warn(`[worker] lost the lease for job ${job.id} while handling an error.`);
  }
  return true;
}
