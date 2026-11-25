import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { formatDateTime, formatMoney, timeAgo, truncate } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Notice, statusTone } from "@/components/ui";
import {
  approveResearchCandidateAction,
  cancelDeepResearchAction,
  createResearchRfqAction,
  markResearchCandidateAction,
  resumeDeepResearchAction,
  startDeepResearchAction,
} from "@/app/actions/research";
import type { CoverageEntry } from "@/lib/sourcing/types";
import type { ResearchQualification } from "@/lib/validation/research";
import { ExternalLink, FlaskConical, GitBranch, Globe2 } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Waiting to start",
  PLANNING: "Planning the research",
  SEARCHING: "Searching connected sources",
  INVESTIGATING: "Reading supplier websites",
  ANALYZING: "Qualifying supplier evidence",
  FOLLOW_UP: "Searching unresolved gaps",
  COMPLETED: "Research complete",
  PARTIAL: "Research partly complete",
  FAILED: "Research failed",
  CANCELLED: "Research cancelled",
};

const MATCH_LABEL: Record<string, string> = {
  EXACT: "Exact match",
  COMPATIBLE: "Compatible",
  POSSIBLE: "Possible — evidence missing",
  UNVERIFIED: "Unverified",
  NO_MATCH: "No match",
};

export async function DeepResearchPanel({ itemId, isOwner }: { itemId: string; isOwner: boolean }) {
  const run = await db.researchRun.findFirst({
    where: { enquiryItemId: itemId },
    orderBy: { createdAt: "desc" },
    include: {
      candidates: {
        orderBy: [{ matchStatus: "asc" }, { confidence: "desc" }],
        include: { evidence: { orderBy: { createdAt: "asc" }, take: 30 } },
      },
      queries: { orderBy: [{ iteration: "asc" }, { createdAt: "asc" }] },
      pages: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });

  const coverage = parseJson<CoverageEntry[]>(run?.coverageJson ?? "[]", []);
  const summary = parseJson<Record<string, number>>(run?.summaryJson ?? "{}", {});
  const plan = parseJson<{ product?: { productName?: string; unknownSpecifications?: string[] } }>(run?.planJson ?? "{}", {});
  const active = run ? ["QUEUED", "PLANNING", "SEARCHING", "INVESTIGATING", "ANALYZING", "FOLLOW_UP"].includes(run.status) : false;

  return (
    <Card>
      <CardHeader
        title="Supplier research"
        description="Quick Search returns leads. Deep Research follows evidence across supplier websites, catalogues and PDFs, then tells you why each supplier matches and what is still unknown."
        action={
          isOwner && !active ? (
            <form action={startDeepResearchAction}>
              <input type="hidden" name="itemId" value={itemId} />
              <Button size="sm" variant="primary">
                <FlaskConical size={14} aria-hidden /> {run ? "Research deeper" : "Start deep research"}
              </Button>
            </form>
          ) : undefined
        }
      />

      {!run ? (
        <div className="space-y-3 px-4 py-4 text-sm text-soft">
          <p>
            The existing quick search is still available from the supplier comparison below. Deep Research is
            bounded and costs more because it opens supplier pages and reads catalogues.
          </p>
          <p className="text-[11px] text-muted">
            It never treats a search-result snippet as a verified specification, never invents missing attributes and
            never sends a supplier message. The owner approves every RFQ.
          </p>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(run.status)} dot>{STATUS_LABEL[run.status] ?? run.status}</Badge>
                <Badge tone="neutral">Round {run.iteration || 0}</Badge>
                <span className="text-[11px] text-muted">Started {timeAgo(run.startedAt)}</span>
              </div>
              <p className="mt-1 text-xs text-soft">
                {plan.product?.productName ? `Researching: ${plan.product.productName}. ` : ""}
                {summary.candidates ?? 0} unique supplier candidate{(summary.candidates ?? 0) === 1 ? "" : "s"} ·{" "}
                {summary.suppliersWithEvidence ?? 0} with relevant evidence · {summary.exact ?? 0} exact ·{" "}
                {summary.compatible ?? 0} compatible · {summary.possible ?? 0} possible ·{" "}
                {summary.unverified ?? 0} unverified.
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {run.searchRequests} search request{run.searchRequests === 1 ? "" : "s"} · {run.pageFetches} page
                {run.pageFetches === 1 ? "" : "s"} read · {run.documentsProcessed} document
                {run.documentsProcessed === 1 ? "" : "s"} · {run.aiCalls} AI reading call
                {run.aiCalls === 1 ? "" : "s"} · estimated cost {formatMoney(run.estimatedCostUsd, "USD")}
                {run.budgetAed != null ? ` (budget ${formatMoney(run.budgetAed, "AED")})` : ""}.
              </p>
            </div>
            {isOwner ? (
              <div className="flex flex-wrap gap-2">
                {active ? (
                  <form action={cancelDeepResearchAction}>
                    <input type="hidden" name="runId" value={run.id} />
                    <Button size="sm" variant="ghost">Cancel research</Button>
                  </form>
                ) : run.status === "PARTIAL" || run.status === "FAILED" ? (
                  <form action={resumeDeepResearchAction}>
                    <input type="hidden" name="runId" value={run.id} />
                    <Button size="sm">Resume remaining research</Button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>

          {run.error ? <Notice tone="warn" title="Research stopped early">{run.error}</Notice> : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-card border border-line p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <Globe2 size={12} aria-hidden /> Sources actually searched
              </p>
              {coverage.length === 0 ? (
                <p className="text-xs text-muted">No source coverage recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {coverage.map((entry) => (
                    <li key={entry.adapter} className="flex items-start justify-between gap-2 text-[11px]">
                      <span className="text-soft">
                        {entry.label}: {entry.queries} quer{entry.queries === 1 ? "y" : "ies"}, {entry.results} result
                        {entry.results === 1 ? "" : "s"}
                        {entry.note ? ` — ${truncate(entry.note, 140)}` : ""}
                      </span>
                      <Badge tone={statusTone(entry.status)}>
                        {entry.status === "OK" ? "Searched" : entry.status === "PARTIAL" ? "Partly searched" : entry.status === "NOT_CONFIGURED" ? "Not connected" : entry.status.toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-card border border-line p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <GitBranch size={12} aria-hidden /> Research trail
              </p>
              <ul className="space-y-1.5">
                {[...run.events].reverse().map((event) => (
                  <li key={event.id} className="text-[11px] text-soft">
                    <span className="text-muted">{formatDateTime(event.createdAt)}</span> — {event.message}
                  </li>
                ))}
                {run.events.length === 0 ? <li className="text-xs text-muted">Waiting for the first research step.</li> : null}
              </ul>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Queries and why they ran</p>
            <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-card border border-line p-2">
              {run.queries.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted">No queries executed yet.</p>
              ) : (
                run.queries.map((query) => (
                  <div key={query.id} className="rounded-control border border-line/70 px-2 py-1.5 text-[11px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">{query.query}</span>
                      <Badge tone={statusTone(query.status)}>{query.status.toLowerCase()}</Badge>
                    </div>
                    <p className="text-muted">
                      {query.category?.replaceAll("_", " ").toLowerCase()} · {query.objective}
                      {query.provider ? ` · ${query.provider}` : ""}
                      {query.resultCount ? ` · ${query.resultCount} result(s)` : ""}
                    </p>
                    {query.reason ? <p className="text-muted">Why: {query.reason}</p> : null}
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Evidence-backed supplier candidates</p>
            {run.candidates.length === 0 ? (
              <p className="text-xs text-muted">
                No candidate has been qualified yet. Raw search results are not supplier counts, and this does not prove
                that no supplier exists.
              </p>
            ) : (
              <div className="space-y-2">
                {run.candidates.map((candidate) => {
                  const qualification = parseJson<Partial<ResearchQualification>>(candidate.matchJson, {});
                  const parsedContacts = parseJson<unknown>(candidate.contactJson, []);
                  const contacts = Array.isArray(parsedContacts)
                    ? (parsedContacts as Array<{ type: string; value: string; sourceUrl: string }>)
                    : [];
                  return (
                    <details key={candidate.id} className="rounded-card border border-line px-3 py-2">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="text-sm font-medium text-ink">{candidate.canonicalName}</span>
                            <span className="ml-2 text-[11px] text-muted">
                              {candidate.domain ?? "no website"} · {candidate.classification?.toLowerCase() ?? "unknown type"}
                              {candidate.country ? ` · ${candidate.country}` : ""}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={candidate.matchStatus === "EXACT" ? "ok" : candidate.matchStatus === "NO_MATCH" ? "danger" : "warn"}>
                              {MATCH_LABEL[candidate.matchStatus] ?? candidate.matchStatus}
                            </Badge>
                            {candidate.status === "APPROVED" ? <Badge tone="ok">Approved supplier</Badge> : null}
                            {candidate.status === "IRRELEVANT" ? <Badge tone="neutral">Marked irrelevant</Badge> : null}
                          </div>
                        </div>
                      </summary>
                      <div className="mt-2 space-y-2 border-t border-line pt-2 text-[11px] text-soft">
                        {qualification.explanation ? <p>{qualification.explanation}</p> : null}
                        {qualification.matchingAttributes?.length ? (
                          <p className="text-ok">
                            Supported: {qualification.matchingAttributes.map((entry) => `${entry.label} ${entry.offered}`).join(", ")}.
                          </p>
                        ) : null}
                        {qualification.missingAttributes?.length ? (
                          <p className="text-warn">
                            Still unknown: {qualification.missingAttributes.map((entry) => entry.label).join(", ")}. These are not assumed.
                          </p>
                        ) : null}
                        {qualification.conflictingAttributes?.length ? (
                          <p className="text-danger">
                            Conflict: {qualification.conflictingAttributes.map((entry) => `${entry.label} requested ${entry.requested}, published ${entry.offered}`).join("; ")}.
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-3">
                          {candidate.website ? (
                            <a href={candidate.website} target="_blank" rel="noreferrer nofollow" className="inline-flex items-center gap-1 text-accent hover:underline">
                              Supplier website <ExternalLink size={10} aria-hidden />
                            </a>
                          ) : null}
                          {contacts.slice(0, 3).map((contact) => (
                            <a key={`${contact.type}-${contact.value}`} href={contact.type === "EMAIL" ? `mailto:${contact.value}` : `tel:${contact.value}`} className="text-accent hover:underline">
                              {contact.value}
                            </a>
                          ))}
                        </div>
                        <p className="text-muted">
                          {candidate.evidenceCount} evidence claim{candidate.evidenceCount === 1 ? "" : "s"} · {candidate.pageCount} relevant page
                          {candidate.pageCount === 1 ? "" : "s"} · confidence {Math.round(candidate.confidence * 100)}%.
                        </p>
                        {candidate.evidence.length > 0 ? (
                          <details className="rounded-control border border-line/70 px-2 py-1.5">
                            <summary className="cursor-pointer list-none text-[11px] font-medium text-soft">
                              Field-level evidence and provenance ({candidate.evidence.length})
                            </summary>
                            <ul className="mt-1.5 space-y-1.5">
                              {candidate.evidence.map((entry) => (
                                <li key={entry.id} className="text-[11px] text-soft">
                                  <span className="font-medium text-ink">{entry.field}</span>
                                  {entry.value ? `: ${entry.value}` : ""}
                                  <span className="text-muted">
                                    {" "}· {entry.sourceType.toLowerCase()} · {entry.verificationStatus.toLowerCase()}
                                    {entry.pageNumber ? ` · page ${entry.pageNumber}` : ""}
                                    {entry.sheetName && entry.rowNumber ? ` · ${entry.sheetName} row ${entry.rowNumber}` : ""}
                                  </span>
                                  {/^https?:/i.test(entry.sourceUrl) ? (
                                    <a href={entry.sourceUrl} target="_blank" rel="noreferrer nofollow" className="ml-1 text-accent hover:underline">
                                      source
                                    </a>
                                  ) : null}
                                  {entry.excerpt ? <p className="mt-0.5 text-muted">{truncate(entry.excerpt, 220)}</p> : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {isOwner ? (
                          <div className="flex flex-wrap gap-2 pt-1">
                            {candidate.status !== "APPROVED" ? (
                              <form action={approveResearchCandidateAction}>
                                <input type="hidden" name="candidateId" value={candidate.id} />
                                <Button size="sm" variant="primary" disabled={!["EXACT", "COMPATIBLE"].includes(candidate.matchStatus)}>
                                  Approve for supplier directory
                                </Button>
                              </form>
                            ) : null}
                            {candidate.status === "APPROVED" ? (
                              <form action={createResearchRfqAction}>
                                <input type="hidden" name="candidateId" value={candidate.id} />
                                <Button size="sm">Prepare RFQ draft</Button>
                              </form>
                            ) : null}
                            {candidate.status !== "IRRELEVANT" ? (
                              <form action={markResearchCandidateAction}>
                                <input type="hidden" name="candidateId" value={candidate.id} />
                                <input type="hidden" name="decision" value="IRRELEVANT" />
                                <Button size="sm" variant="ghost">Mark irrelevant</Button>
                              </form>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-muted">Only the owner can approve a supplier or prepare an RFQ.</p>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </div>

          {run.pages.length > 0 ? (
            <details className="rounded-card border border-line px-3 py-2">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-soft">
                Pages and documents investigated ({run.pages.length})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {run.pages.map((page) => (
                  <li key={page.id} className="text-[11px] text-soft">
                    <span className="text-muted">{page.status.toLowerCase()}</span> · {page.pageType.toLowerCase()} ·{" "}
                    <a href={page.finalUrl ?? page.url} target="_blank" rel="noreferrer nofollow" className="text-accent hover:underline">
                      {truncate(page.title ?? page.url, 100)}
                    </a>
                    {page.pageCount ? ` · ${page.pageCount} pages` : ""}
                    {page.documentLocation ? ` · ${page.documentLocation}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {plan.product?.unknownSpecifications?.length ? (
            <p className="text-[11px] text-warn">
              Customer specification gaps: {plan.product.unknownSpecifications.join(", ")}. Research can look for published
              values, but it will not invent an answer or treat an unknown attribute as a match.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
