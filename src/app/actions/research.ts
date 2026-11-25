"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authorizeOwner } from "@/lib/auth";
import { revalidateOrgPath } from "@/lib/revalidate";
import { writeAudit } from "@/lib/audit";
import { parseJson } from "@/lib/json";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { cancelDeepResearchRun } from "@/lib/sourcing/research/engine";
import { upsertProspectFromCandidate } from "@/lib/suppliers/prospects";
import { createSupplierQuoteRequest } from "@/lib/workflow/supplierQuotes";

function str(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

async function ownedRun(runId: string) {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    include: { enquiryItem: true, candidates: true },
  });
  if (!run) redirect("/sourcing?error=Research+run+not+found");
  return run;
}

export async function startDeepResearchAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const itemId = str(formData.get("itemId"));
  const item = await db.enquiryItem.findUnique({ where: { id: itemId }, include: { enquiry: true } });
  if (!item) redirect("/sourcing?error=Product+line+not+found");
  if (item.quantityToSource <= 0) redirect(`/sourcing/${itemId}?error=Nothing+needs+sourcing`);

  await enqueueJob({
    type: JOB_TYPES.RUN_DEEP_RESEARCH,
    payload: { enquiryItemId: item.id },
    idempotencyKey: `deep-research:${item.id}:${randomUUID()}`,
    maxAttempts: 2,
  });

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.queued",
    entityType: "EnquiryItem",
    entityId: item.id,
    meta: { mode: "DEEP" },
  });
  revalidateOrgPath(user.organizationId, `/sourcing/${item.id}`);
  redirect(`/sourcing/${item.id}?deepQueued=1`);
}

export async function cancelDeepResearchAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const runId = str(formData.get("runId"));
  const run = await ownedRun(runId);
  await cancelDeepResearchRun(run.id);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.cancelled_by_owner",
    entityType: "ResearchRun",
    entityId: run.id,
  });
  revalidateOrgPath(user.organizationId, `/sourcing/${run.enquiryItemId ?? ""}`);
  redirect(`/sourcing/${run.enquiryItemId ?? ""}?deepCancelled=1`);
}

export async function resumeDeepResearchAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const runId = str(formData.get("runId"));
  const run = await ownedRun(runId);
  await enqueueJob({
    type: JOB_TYPES.RUN_DEEP_RESEARCH,
    payload: { runId: run.id, enquiryItemId: run.enquiryItemId ?? "" },
    idempotencyKey: `deep-research-resume:${run.id}:${randomUUID()}`,
    maxAttempts: 2,
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.resumed",
    entityType: "ResearchRun",
    entityId: run.id,
  });
  revalidateOrgPath(user.organizationId, `/sourcing/${run.enquiryItemId ?? ""}`);
  redirect(`/sourcing/${run.enquiryItemId ?? ""}?deepResumed=1`);
}

export async function markResearchCandidateAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const candidateId = str(formData.get("candidateId"));
  const decision = str(formData.get("decision"));
  const candidate = await db.researchCandidate.findUnique({ where: { id: candidateId }, include: { run: true } });
  if (!candidate) redirect("/sourcing?error=Supplier+candidate+not+found");
  // Approval must go through approveResearchCandidateAction, which enforces the
  // technical qualification. This endpoint can only clear or apply the review
  // marker, never bypass a failed/unknown match.
  const status = decision === "IRRELEVANT" ? "IRRELEVANT" : "NEW";
  await db.researchCandidate.update({ where: { id: candidate.id }, data: { status } });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.candidate_marked",
    entityType: "ResearchCandidate",
    entityId: candidate.id,
    meta: { status, canonicalName: candidate.canonicalName },
  });
  revalidateOrgPath(user.organizationId, `/sourcing/${candidate.run.enquiryItemId ?? ""}`);
  redirect(`/sourcing/${candidate.run.enquiryItemId ?? ""}?deepCandidate=${candidate.id}`);
}

export async function approveResearchCandidateAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const candidateId = str(formData.get("candidateId"));
  const candidate = await db.researchCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) redirect("/sourcing?error=Supplier+candidate+not+found");
  if (candidate.status === "IRRELEVANT") {
    redirect(`/sourcing?error=This+candidate+was+marked+irrelevant`);
  }
  if (candidate.matchStatus !== "EXACT" && candidate.matchStatus !== "COMPATIBLE") {
    redirect(`/sourcing?error=Only+an+exact+or+compatible+candidate+can+be+approved`);
  }
  // A candidate sourced from the company's own supplier directory already has a
  // supplier record; approving it must not create a duplicate prospect or fail
  // merely because the internal record has no public website.
  if (candidate.supplierId) {
    await db.researchCandidate.update({ where: { id: candidate.id }, data: { status: "APPROVED" } });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "sourcing.deep_research.candidate_approved",
      entityType: "ResearchCandidate",
      entityId: candidate.id,
      meta: { supplierId: candidate.supplierId, name: candidate.canonicalName, existingSupplier: true },
    });
    revalidateOrgPath(user.organizationId, `/sourcing?deepCandidate=${candidate.id}`);
    redirect(`/sourcing?deepCandidate=${candidate.id}&approved=1`);
  }
  const sourceUrl = candidate.website ?? (candidate.domain ? `https://${candidate.domain}` : null);
  if (!sourceUrl) redirect(`/sourcing?error=This+candidate+has+no+official+website+to+verify`);
  const parsedContacts = parseJson<unknown>(candidate.contactJson, []);
  const contacts = Array.isArray(parsedContacts)
    ? (parsedContacts as Array<{ type: string; value: string; sourceUrl: string }>)
    : [];
  const prospect = await upsertProspectFromCandidate(
    {
      adapter: "DEEP_RESEARCH",
      supplierName: candidate.canonicalName,
      sourceUrl,
      title: candidate.canonicalName,
      snippet: candidate.description,
      retrievedAt: new Date(),
      evidence: {
        publicContacts: {
          emails: contacts.filter((entry) => entry.type === "EMAIL").map((entry) => entry.value),
          phones: contacts.filter((entry) => entry.type === "PHONE").map((entry) => entry.value),
          sourceUrl,
        },
        deepResearchCandidateId: candidate.id,
      },
    },
    null,
  );
  if (!prospect) redirect(`/sourcing?error=Could+not+create+the+supplier+record`);
  await db.researchCandidate.update({
    where: { id: candidate.id },
    data: { supplierId: prospect.supplierId, status: "APPROVED" },
  });
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.candidate_approved",
    entityType: "ResearchCandidate",
    entityId: candidate.id,
    meta: { supplierId: prospect.supplierId, name: candidate.canonicalName },
  });
  revalidateOrgPath(user.organizationId, `/sourcing?deepCandidate=${candidate.id}`);
  redirect(`/sourcing?deepCandidate=${candidate.id}&approved=1`);
}

export async function createResearchRfqAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const candidateId = str(formData.get("candidateId"));
  const candidate = await db.researchCandidate.findUnique({ where: { id: candidateId }, include: { run: true } });
  if (!candidate) redirect("/sourcing?error=Supplier+candidate+not+found");
  if (candidate.status !== "APPROVED" || !candidate.supplierId) {
    redirect(`/sourcing?error=Approve+the+supplier+before+preparing+an+RFQ`);
  }
  if (!candidate.run.enquiryItemId) redirect(`/sourcing?error=No+RFQ+line+is+linked+to+this+research`);
  const result = await createSupplierQuoteRequest({
    supplierId: candidate.supplierId,
    enquiryItemId: candidate.run.enquiryItemId,
    userId: user.id,
    actorLabel: user.name,
  });
  if (!result.ok) redirect(`/sourcing?error=${encodeURIComponent(result.error)}`);
  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "sourcing.deep_research.rfq_drafted",
    entityType: "SupplierQuote",
    entityId: result.quoteId,
    meta: { candidateId, supplierId: candidate.supplierId },
  });
  revalidateOrgPath(user.organizationId, `/sourcing/${candidate.run.enquiryItemId}`);
  redirect(`/suppliers/outreach/${result.quoteId}`);
}
