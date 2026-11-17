import Link from "next/link";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { MATCH_STATUS_LABELS, label } from "@/lib/constants";
import { formatMoney, timeAgo, truncate } from "@/lib/format";
import { Badge, ButtonLink, Card, CardHeader, DataTable, EmptyState, Notice, PageHeader, Td, Th, statusTone } from "@/components/ui";
import { BadgeCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string }>;
}) {
  await requireOwner();
  const flags = await searchParams;

  const approvals = await db.approval.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      enquiry: { select: { id: true, publicRef: true, customerName: true } },
    },
  });

  const decided = await db.approval.findMany({
    where: { status: { not: "PENDING" } },
    orderBy: { decidedAt: "desc" },
    take: 8,
    include: { enquiry: { select: { id: true, publicRef: true } }, decidedBy: { select: { name: true } } },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        description="Decisions that only you can make: choosing a supplier option, sending a supplier request and releasing a customer quotation."
      />

      {flags.decided ? <Notice tone="ok">Decision recorded.</Notice> : null}

      <Notice tone="info" title="What approval means">
        Approving a supplier allows that sourcing option to be used in a customer quotation. It does not place a purchase order,
        transfer money or confirm the customer&apos;s order. Those remain separate actions.
      </Notice>

      <Card>
        <CardHeader title="Waiting for your decision" description="Oldest first." />
        {approvals.length === 0 ? (
          <EmptyState
            icon={<BadgeCheck size={18} aria-hidden />}
            title="Nothing needs approval"
            description="When supplier options or customer quotations are ready, they appear here."
          />
        ) : (
          <DataTable minWidth={840}>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Enquiry</Th>
                <Th>What is being approved</Th>
                <Th>Requested</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => {
                const payload = parseJson<{
                  description?: string;
                  supplierName?: string;
                  quoteNumber?: string;
                  total?: number;
                  currency?: string;
                  offers?: Array<{ supplierName: string; unitPrice: number | null; isEligible: boolean }>;
                  body?: string;
                }>(approval.payloadJson, {});
                const eligible = payload.offers?.filter((offer) => offer.isEligible) ?? [];
                return (
                  <tr key={approval.id} className="hover:bg-elevated/60">
                    <Td>
                      <Badge tone="accent">
                        {approval.type === "SOURCING"
                          ? "Supplier option"
                          : approval.type === "CUSTOMER_QUOTATION"
                            ? "Customer quotation"
                            : "Supplier message"}
                      </Badge>
                    </Td>
                    <Td>
                      <Link href={`/enquiries/${approval.enquiryId}`} className="text-xs text-soft hover:text-accent">
                        {approval.enquiry?.publicRef ?? "—"}
                      </Link>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {approval.enquiry?.customerName ?? ""}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-ink">
                        {truncate(payload.description ?? payload.quoteNumber ?? payload.body ?? "Approval", 70)}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {approval.type === "SOURCING"
                          ? `${payload.offers?.length ?? 0} offer(s), ${eligible.length} eligible`
                          : approval.type === "CUSTOMER_QUOTATION"
                            ? `${payload.quoteNumber ?? ""} · ${formatMoney(payload.total ?? null, payload.currency ?? "AED")}`
                            : payload.supplierName ?? ""}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-xs text-soft">{timeAgo(approval.createdAt)}</span>
                    </Td>
                    <Td>
                      <ButtonLink href={`/approvals/${approval.id}`} size="sm" variant="primary">
                        Review
                      </ButtonLink>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent decisions" description="Permanent record of who decided what and why." />
        {decided.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted">No decisions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {decided.map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div>
                  <p className="text-xs text-ink">
                    {approval.type === "SOURCING"
                      ? "Supplier option"
                      : approval.type === "CUSTOMER_QUOTATION"
                        ? "Customer quotation"
                        : "Supplier message"}{" "}
                    · {approval.enquiry?.publicRef ?? "—"}
                  </p>
                  <p className="text-[11px] text-muted">
                    {approval.decidedBy?.name ?? "Owner"} · {timeAgo(approval.decidedAt)} {approval.reason ? `· “${truncate(approval.reason, 80)}”` : ""}
                  </p>
                </div>
                <Badge tone={statusTone(approval.status)}>{approval.status.replaceAll("_", " ").toLowerCase()}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
