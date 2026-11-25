import { db } from "../db";
import { parseJson } from "../json";
import { claimJob, completeJob, failJob, heartbeatJob, releaseExpiredJobs, LEASE_MS } from "./jobs";
import { processInboundMessage, extractEnquiryById, checkEnquiryInventory } from "./enquiry";
import { ensureSourcingApproval } from "./approvals";
import { runSourcingForItem } from "../sourcing/engine";
import { resumeDeepResearchRun, runDeepResearchForItem } from "../sourcing/research/engine";
import { sendSupplierQuoteRequest, sendSupplierReminder } from "./supplierQuotes";
import { JOB_TYPES } from "../constants";
import { runWithTenant } from "../tenant";
import { recoverStaleOutboundClaims } from "../outbound/messages";
import { broadcastOrgRefresh } from "../realtime";

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
    case JOB_TYPES.REPROCESS_DOCUMENTS: {
      if (payload.enquiryId) {
        const result = await extractEnquiryById(payload.enquiryId, { forceDocumentProcessing: true });
        return {
          ok: true,
          message: `Documents re-read; ${result.items} product line${result.items === 1 ? "" : "s"} retained`,
        };
      }
      if (payload.supplierReplyId) {
        const reply = await db.supplierEmailReply.findUnique({
          where: { id: payload.supplierReplyId },
          include: { attachments: true },
        });
        if (!reply) throw new Error("Supplier reply not found");
        const { processDocumentPackage } = await import("../intake/documentPackage");
        await processDocumentPackage({
          key: `supplier-reply:${reply.id}`,
          supplierReplyId: reply.id,
          force: true,
          attachments: reply.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            storagePath: attachment.storagePath,
            sha256: attachment.sha256,
            sizeBytes: attachment.sizeBytes,
          })),
        });
        const { enrichSupplierReplyAi } = await import("./supplierReply");
        const ai = await enrichSupplierReplyAi(reply.id);
        return {
          ok: true,
          message: `Supplier documents re-read; AI pass ${ai.status.toLowerCase()}`,
        };
      }
      throw new Error("Missing enquiryId or supplierReplyId");
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
    case JOB_TYPES.RUN_DEEP_RESEARCH: {
      const result = payload.runId
        ? await resumeDeepResearchRun(payload.runId, {})
        : payload.enquiryItemId
          ? await runDeepResearchForItem(payload.enquiryItemId, {
              maxRounds: payload.maxRounds ? Number(payload.maxRounds) : undefined,
              maxQueries: payload.maxQueries ? Number(payload.maxQueries) : undefined,
              maxUrls: payload.maxUrls ? Number(payload.maxUrls) : undefined,
              maxPagesPerDomain: payload.maxPagesPerDomain ? Number(payload.maxPagesPerDomain) : undefined,
              maxConcurrentPages: payload.maxConcurrentPages ? Number(payload.maxConcurrentPages) : undefined,
              budgetAed: payload.budgetAed ? Number(payload.budgetAed) : undefined,
            })
          : (() => {
              throw new Error("Missing enquiryItemId");
            })();
      return {
        ok: result.status !== "FAILED",
        message: `${result.message} Queries: ${result.queries}; pages: ${result.pages}.`,
      };
    }
    case JOB_TYPES.SEND_SUPPLIER_RFQ: {
      if (!payload.supplierQuoteId) throw new Error("Missing supplierQuoteId");
      const result = await sendSupplierQuoteRequest(payload.supplierQuoteId);
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.SUPPLIER_REMINDER: {
      if (!payload.supplierQuoteId) throw new Error("Missing supplierQuoteId");
      const result = await sendSupplierReminder(payload.supplierQuoteId);
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.SYNC_EMAIL: {
      const { syncEmailIntake } = await import("../email/sync");
      const result = await syncEmailIntake({
        trigger: (payload.trigger as "poll" | "push" | "manual" | "initial") ?? "poll",
      });
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.RENEW_EMAIL_WATCH: {
      const { renewEmailSubscriptions } = await import("../email/sync");
      const result = await renewEmailSubscriptions();
      return { ok: result.ok, message: result.detail };
    }
    case JOB_TYPES.OPS_CHECK: {
      const { runOpsCheck } = await import("../ops-monitor");
      const result = await runOpsCheck();
      return { ok: true, message: `Operational checks complete${result.alerted.length ? ` (${result.alerted.join(", ")})` : ""}` };
    }
    case JOB_TYPES.OPS_DIGEST: {
      const { sendDailyDigest } = await import("../ops-monitor");
      const result = await sendDailyDigest();
      return { ok: true, message: result.sent ? "Daily digest sent" : "Daily digest already sent" };
    }
    case JOB_TYPES.EXTRACT_SUPPLIER_REPLY: {
      if (!payload.replyId) throw new Error("Missing replyId");
      const { enrichSupplierReplyAi } = await import("./supplierReply");
      const result = await enrichSupplierReplyAi(payload.replyId);
      return {
        ok: true,
        message:
          result.status === "OK"
            ? "Supplier reply re-read by AI"
            : `AI reading pass unavailable: ${result.status}`,
      };
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
  // A worker can die after claiming an outbound message but before recording a
  // provider outcome. Sweep those expired SENDING leases into UNKNOWN here so
  // both the long-running worker and the QStash watchdog make them visible for
  // human reconciliation instead of leaving them stuck forever.
  await recoverStaleOutboundClaims();
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
  // Any job can change data the UI is showing. Tell the owning company's open
  // tabs to re-render, regardless of whether this attempt succeeded or failed.
  await broadcastOrgRefresh(job.organizationId, "job");
  return true;
}
