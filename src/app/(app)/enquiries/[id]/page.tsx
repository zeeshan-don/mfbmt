import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePermission, canSeeSupplierCosts } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { buildSpecSummary } from "@/lib/catalog/normalize";
import { fastenerSpecSummary, parseFastenerSpecJson, lengthApplies, FASTENER_TYPE_LABELS } from "@/lib/fasteners/spec";
import { INDUSTRIAL_SCHEMAS, parseIndustrialSpecJson } from "@/lib/catalog/industrialSpec";
import {
  ENQUIRY_STATUS_LABELS,
  INVENTORY_STATUS_LABELS,
  MATCH_STATUS_LABELS,
  SOURCING_STATUS_LABELS,
  CLASSIFICATIONS,
  label,
} from "@/lib/constants";
import { formatDateTime, formatMoney, formatQty, timeAgo, truncate } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Notice, PageHeader, statusTone, inputClass } from "@/components/ui";
import {
  updateItemAction,
  recheckStockAction,
  runSourcingAction,
  retryExtractionAction,
  markAsRfqAction,
  closeEnquiryAction,
  buildQuotationAction,
} from "@/app/actions/enquiries";
import { FileText, Image as ImageIcon, MessageSquare, Paperclip, Search } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function EnquiryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; queued?: string; stock?: string }>;
}) {
  const user = await requirePermission("enquiries.view");
  const canViewCosts = canSeeSupplierCosts(user);
  const { id } = await params;
  const flags = await searchParams;

  const enquiry = await db.enquiry.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { lineNo: "asc" },
        include: {
          offers: true,
          searchSessions: { orderBy: { startedAt: "desc" }, take: 1 },
        },
      },
      attachments: true,
      quotations: { orderBy: { version: "desc" } },
      approvals: { where: { status: "PENDING" } },
    },
  });

  if (!enquiry) notFound();

  const messages = await db.message.findMany({
    where: { enquiryId: enquiry.id },
    orderBy: { receivedAt: "asc" },
  });

  const supplierNames = await db.supplier.findMany({ select: { id: true, name: true } });
  const supplierById = new Map(supplierNames.map((supplier) => [supplier.id, supplier.name]));

  const approvedCount = enquiry.items.filter((item) => item.approvedOfferId).length;
  const allCovered = enquiry.items.length > 0 && enquiry.items.every((item) => item.quantityToSource === 0 || item.approvedOfferId);
  const canBuildQuotation = user.role === "OWNER" && approvedCount > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${enquiry.publicRef} · ${enquiry.channel.toLowerCase()}${enquiry.isDemo ? " · sample data" : ""}`}
        title={enquiry.customerName || enquiry.customerPhone || "Customer enquiry"}
        description={`Received ${formatDateTime(messages[0]?.receivedAt ?? enquiry.createdAt)}`}
        actions={
          <>
            <ButtonLink href={`/enquiries`} variant="ghost" size="sm">
              Back to enquiries
            </ButtonLink>
            <Badge tone={statusTone(enquiry.status)} dot>
              {label(ENQUIRY_STATUS_LABELS, enquiry.status)}
            </Badge>
          </>
        }
      />

      {flags.error ? (
        <Notice tone="danger" title="Could not complete that action">
          {flags.error}
        </Notice>
      ) : null}
      {flags.saved ? <Notice tone="ok">Saved.</Notice> : null}
      {flags.queued ? <Notice tone="info">Supplier search queued. Results will appear here shortly.</Notice> : null}
      {flags.stock ? <Notice tone="info">Stock has been checked again.</Notice> : null}

      {enquiry.requiresReview && enquiry.reviewReason ? (
        <Notice tone="warn" title="This request needs a check">
          {enquiry.reviewReason}
          {enquiry.status === "NEEDS_REVIEW" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <form action={markAsRfqAction}>
                <input type="hidden" name="enquiryId" value={enquiry.id} />
                <Button size="sm" variant="primary">
                  Treat as a quotation request
                </Button>
              </form>
              <form action={closeEnquiryAction}>
                <input type="hidden" name="enquiryId" value={enquiry.id} />
                <input type="hidden" name="status" value="IGNORED" />
                <Button size="sm">Not a quotation request</Button>
              </form>
            </div>
          ) : null}
        </Notice>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Requested products</h2>
            <div className="flex items-center gap-2">
              <form action={recheckStockAction}>
                <input type="hidden" name="enquiryId" value={enquiry.id} />
                <Button size="sm">Check stock again</Button>
              </form>
            </div>
          </div>

          {enquiry.items.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search size={18} aria-hidden />}
                title="No products read yet"
                description="The request has not been turned into product lines. You can run the reading again or add the products by hand."
                action={
                  <form action={retryExtractionAction}>
                    <input type="hidden" name="enquiryId" value={enquiry.id} />
                    <Button size="sm" variant="primary">
                      Read the request again
                    </Button>
                  </form>
                }
              />
            </Card>
          ) : (
            enquiry.items.map((item) => {
              const missing = parseJson<string[]>(item.missingFields, []);
              const fastener = parseFastenerSpecJson(item.fastenerSpecJson);
              const industrial = parseIndustrialSpecJson(item.industrialSpecJson);
              const industrialSchema = industrial ? INDUSTRIAL_SCHEMAS[industrial.category] : null;
              const inline = parseJson<{ candidates?: unknown[]; note?: string | null }>(item.matchedStockJson, {});
              const offers = item.offers;
              const eligible = offers.filter((offer) => offer.isEligible);
              const best = eligible
                .map((offer) => {
                  const snapshot = parseJson<{ landed?: { total?: number | null }; evaluation?: { rank?: number | null } }>(
                    offer.landedCostJson,
                    {},
                  );
                  return { offer, total: snapshot.landed?.total ?? null, rank: snapshot.evaluation?.rank ?? 999 };
                })
                .sort((a, b) => a.rank - b.rank)[0];
              const savedOffer = offers.find((offer) => offer.id === item.approvedOfferId);

              return (
                <Card key={item.id} className="overflow-hidden">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wide text-muted">Line {item.lineNo}</p>
                      <h3 className="text-sm font-semibold text-ink">{item.description}</h3>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {buildSpecSummary({
                          description: "",
                          size: item.size,
                          material: item.material,
                          grade: item.grade,
                          pressureRating: item.pressureRating,
                          schedule: item.schedule,
                          standard: item.standard,
                          brand: item.brand,
                        }) || "No further specification recorded"}
                        {item.sourceRef ? ` · from ${item.sourceRef}` : ""}
                      </p>
                      {fastener ? (
                        <div className="mt-2 rounded-control border border-line bg-elevated/50 px-2.5 py-2">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
                            Fastener specification · {item.specSource === "MANUAL" ? "reviewed by owner" : item.specSource === "SUPPLIER_CONFIRMED" ? "supplier confirmed" : "extracted — confirm before sourcing"}
                            {item.specConfirmedAt ? ` · ${new Date(item.specConfirmedAt).toLocaleDateString("en-GB")}` : ""}
                          </p>
                          <p className="mt-1 text-xs text-ink">
                            {fastenerSpecSummary({
                              ...fastener,
                              lengthMm: missing.includes("Length") ? null : fastener.lengthMm,
                            })}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {([
                              ["Type", fastener.type ? FASTENER_TYPE_LABELS[fastener.type] : null],
                              ["Diameter", fastener.diameter],
                              ["Thread", fastener.threadSeries],
                              ["Pitch", fastener.pitchMm != null ? `${fastener.pitchMm} mm` : null],
                              [
                                "Length",
                                lengthApplies(fastener.type)
                                  ? missing.includes("Length")
                                    ? null
                                    : fastener.lengthMm != null
                                      ? `${fastener.lengthMm} mm`
                                      : null
                                  : null,
                              ],
                              ["Material", fastener.material],
                              ["Class", fastener.propertyClass],
                              ["Finish", fastener.finish],
                              ["Standard", fastener.standard],
                            ] as const)
                              .filter(([labelText]) => labelText !== "Length" || lengthApplies(fastener.type))
                              .map(([labelText, value]) => (
                              <span
                                key={labelText}
                                className={`rounded border px-1.5 py-0.5 text-[10px] ${value ? "border-line text-soft" : "border-warn/40 bg-warn/5 text-warn"}`}
                              >
                                {labelText}: {value ?? "missing"}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {industrial && industrialSchema ? (
                        <div className="mt-2 rounded-control border border-line bg-elevated/50 px-2.5 py-2">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
                            {industrial.category} specification ·{" "}
                            {industrial.source === "MANUAL"
                              ? "reviewed by owner"
                              : industrial.source === "SUPPLIER_CONFIRMED"
                                ? "supplier confirmed"
                                : item.specSource === "MANUAL"
                                  ? "corrected — confirm before sourcing"
                                  : "extracted — confirm before sourcing"}
                            {item.specConfirmedAt ? ` · ${new Date(item.specConfirmedAt).toLocaleDateString("en-GB")}` : ""}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {industrialSchema.map((attribute) => {
                              const value = industrial.attributes[attribute.key];
                              return (
                                <span
                                  key={attribute.key}
                                  className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                    value ? "border-line text-soft" : attribute.required ? "border-warn/40 bg-warn/5 text-warn" : "border-line text-muted"
                                  }`}
                                >
                                  {attribute.label}: {value ?? (attribute.required ? "missing" : "not stated")}
                                </span>
                              );
                            })}
                          </div>
                          {industrial.missingRequired.length > 0 ? (
                            <p className="mt-1 text-[11px] text-warn">
                              Required before an exact match: {industrial.missingRequired.join(", ")}.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={statusTone(item.inventoryStatus)}>
                        {label(INVENTORY_STATUS_LABELS, item.inventoryStatus)}
                      </Badge>
                      <Badge tone={statusTone(item.sourcingStatus)}>
                        {label(SOURCING_STATUS_LABELS, item.sourcingStatus)}
                      </Badge>
                      {item.approvedOfferId ? <Badge tone="ok">Supplier approved</Badge> : null}
                    </div>
                  </div>

                  <div className="grid gap-4 px-4 py-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[11px] text-muted">Customer needs</p>
                      <p className="text-sm font-medium tabular text-ink">{formatQty(item.quantity, item.unit)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted">From your stock</p>
                      <p className="text-sm font-medium tabular text-ink">{formatQty(item.quantityFromStock, item.unit)}</p>
                      {item.stockIsStale ? (
                        <p className="mt-0.5 text-[11px] text-warn">Stock information may be old.</p>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-[11px] text-muted">To buy from a supplier</p>
                      <p className="text-sm font-medium tabular text-ink">{formatQty(item.quantityToSource, item.unit)}</p>
                    </div>
                  </div>

                  {missing.length > 0 ? (
                    <div className="border-t border-warn/20 bg-warn/5 px-4 py-3">
                      <p className="text-xs font-medium text-ink">Missing details</p>
                      <p className="mt-0.5 text-xs text-soft">{item.clarificationQuestion ?? `Missing: ${missing.join(", ")}`}</p>
                      <p className="mt-1 text-[11px] text-muted">
                        Suppliers are not searched until these details are confirmed, so a wrong product is never bought on price alone.
                      </p>
                    </div>
                  ) : null}

                  {inline.note ? <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{inline.note}</p> : null}

                  <div className="border-t border-line px-4 py-3">
                    {savedOffer ? (
                      <div className="mb-2 rounded-card border border-ok/30 bg-ok/5 px-3 py-2 text-xs text-soft">
                        Approved supplier: <span className="font-medium text-ink">{savedOffer.supplierName}</span>
                        {canViewCosts && savedOffer.unitPrice != null
                          ? ` · ${formatMoney(savedOffer.unitPrice, savedOffer.currency ?? "AED")} per ${item.unit}`
                          : ""}
                        <span className="block text-[11px] text-muted">
                          Approval to use this sourcing option. No purchase order has been issued.
                        </span>
                      </div>
                    ) : null}

                    {offers.length > 0 ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-soft">
                          {offers.length} supplier option{offers.length === 1 ? "" : "s"} found ·{" "}
                          {eligible.length} eligible
                          {canViewCosts && best?.total != null ? (
                            <>
                              {" "}· best eligible total{" "}
                              <span className="font-medium tabular text-ink">
                                {formatMoney(best.total, "AED")}
                              </span>
                            </>
                          ) : null}
                        </p>
                        <ButtonLink href={`/sourcing/${item.id}`} size="sm" variant="primary">
                          Compare suppliers
                        </ButtonLink>
                      </div>
                    ) : item.quantityToSource > 0 && missing.length === 0 ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-muted">
                          {item.sourcingStatus === "SEARCHING" || item.sourcingStatus === "QUEUED"
                            ? "Searching connected supplier sources…"
                            : item.sourcingStatus === "NO_RESULTS"
                              ? "No verifiable supplier offer was found for this item yet."
                              : "No supplier search has run for this item."}
                        </p>
                        <form action={runSourcingAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="enquiryId" value={enquiry.id} />
                          <Button size="sm">Search suppliers</Button>
                        </form>
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        {missing.length > 0
                          ? "Add the missing details before a supplier search or stock promise can be made."
                          : item.quantityToSource === 0
                            ? "Covered by your stock — no supplier search needed."
                            : "Add the missing details to start a supplier search."}
                      </p>
                    )}
                  </div>

                  <details className="group border-t border-line">
                    <summary className="cursor-pointer list-none px-4 py-2 text-xs font-medium text-soft hover:text-ink">
                      Correct the product details
                    </summary>
                    <form action={updateItemAction} className="space-y-3 border-t border-line px-4 py-3">
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="enquiryId" value={enquiry.id} />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="block text-xs text-soft">
                          Description
                          <input name="description" defaultValue={item.description} className={`${inputClass} mt-1`} />
                        </label>
                        <label className="block text-xs text-soft">
                          Category
                          <input name="category" defaultValue={item.category ?? ""} className={`${inputClass} mt-1`} />
                        </label>
                        <label className="block text-xs text-soft">
                          Quantity
                          <input name="quantity" defaultValue={String(item.quantity)} className={`${inputClass} mt-1 tabular`} inputMode="decimal" />
                        </label>
                        <label className="block text-xs text-soft">
                          Unit
                          <input name="unit" defaultValue={item.unit} className={`${inputClass} mt-1`} />
                        </label>
                        <label className="block text-xs text-soft">
                          Size
                          <input name="size" defaultValue={item.size ?? ""} className={`${inputClass} mt-1`} placeholder="1 inch / DN25" />
                        </label>
                        <label className="block text-xs text-soft">
                          Material
                          <input name="material" defaultValue={item.material ?? ""} className={`${inputClass} mt-1`} placeholder="SS316" />
                        </label>
                        <label className="block text-xs text-soft">
                          Grade
                          <input name="grade" defaultValue={item.grade ?? ""} className={`${inputClass} mt-1`} />
                        </label>
                        <label className="block text-xs text-soft">
                          Pressure rating
                          <input name="pressureRating" defaultValue={item.pressureRating ?? ""} className={`${inputClass} mt-1`} placeholder="Class 150" />
                        </label>
                        <label className="block text-xs text-soft">
                          Schedule
                          <input name="schedule" defaultValue={item.schedule ?? ""} className={`${inputClass} mt-1`} placeholder="Sch 40" />
                        </label>
                        <label className="block text-xs text-soft">
                          Standard
                          <input name="standard" defaultValue={item.standard ?? ""} className={`${inputClass} mt-1`} />
                        </label>
                        <label className="block text-xs text-soft">
                          Brand
                          <input name="brand" defaultValue={item.brand ?? ""} className={`${inputClass} mt-1`} />
                        </label>
                      </div>
                      <fieldset className="rounded-control border border-line px-3 py-2">
                        <legend className="px-1 text-[11px] font-medium text-muted">Fastener specification (when applicable)</legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block text-xs text-soft">
                            Fastener type
                            <select name="fastenerType" defaultValue={item.fastenerType ?? fastener?.type ?? ""} className={`${inputClass} mt-1`}>
                              <option value="">Not set</option>
                              {Object.entries(FASTENER_TYPE_LABELS).map(([value, text]) => (
                                <option key={value} value={value}>{text}</option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-xs text-soft">
                            Diameter
                            <input name="fastenerDiameter" defaultValue={fastener?.diameter ?? item.diameter ?? ""} placeholder="M10 / 3/8" className={`${inputClass} mt-1`} />
                          </label>
                          <label className="block text-xs text-soft">
                            Thread system
                            <select name="threadSeries" defaultValue={item.threadSeries ?? fastener?.threadSeries ?? ""} className={`${inputClass} mt-1`}>
                              <option value="">Not set</option>
                              {["METRIC_COARSE", "METRIC_FINE", "UNC", "UNF", "BSP", "NPT"].map((value) => (
                                <option key={value} value={value}>{value.replaceAll("_", " ").toLowerCase()}</option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-xs text-soft">
                            Pitch (mm)
                            <input name="pitchMm" defaultValue={item.pitchMm != null ? String(item.pitchMm) : ""} inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
                          </label>
                          <label className="block text-xs text-soft">
                            Length (mm)
                            <input name="lengthMm" defaultValue={item.lengthMm != null ? String(item.lengthMm) : ""} inputMode="decimal" className={`${inputClass} mt-1 tabular`} />
                          </label>
                          <label className="block text-xs text-soft">
                            Property class
                            <input name="propertyClass" defaultValue={item.propertyClass ?? fastener?.propertyClass ?? ""} placeholder="8.8 / 10.9 / A2-70" className={`${inputClass} mt-1`} />
                          </label>
                          <label className="block text-xs text-soft">
                            Finish
                            <input name="finish" defaultValue={item.finish ?? fastener?.finish ?? ""} placeholder="ZINC_PLATED / HOT_DIP_GALVANIZED" className={`${inputClass} mt-1`} />
                          </label>
                          <label className="flex items-center gap-2 self-end pb-2 text-xs text-soft">
                            <input type="checkbox" name="confirm" value="1" />
                            I have checked these details against the customer request
                          </label>
                        </div>
                      </fieldset>
                      {industrialSchema && industrial ? (
                        <fieldset className="rounded-control border border-line px-3 py-2">
                          <legend className="px-1 text-[11px] font-medium text-muted">
                            {industrial.category} attributes (OGS industrial specification)
                          </legend>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {industrialSchema.map((attribute) => (
                              <label key={attribute.key} className="block text-xs text-soft">
                                {attribute.label}
                                {attribute.required ? " *" : ""}
                                <input
                                  name={`industrial_${attribute.key}`}
                                  defaultValue={industrial.attributes[attribute.key] ?? ""}
                                  className={`${inputClass} mt-1`}
                                />
                              </label>
                            ))}
                          </div>
                          <p className="mt-1 text-[11px] text-muted">
                            Only what the customer or supplier stated is stored. Leave a field blank when it is unknown — it is never guessed.
                          </p>
                        </fieldset>
                      ) : null}
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-muted">Saving rechecks stock and asks the supplier search to use the corrected details.</p>
                        <Button size="sm" variant="primary">
                          Save details
                        </Button>
                      </div>
                    </form>
                  </details>
                </Card>
              );
            })
          )}

          {enquiry.items.length > 0 ? (
            <Card>
              <CardHeader title="Customer quotation" description="Prepared from approved sourcing, then approved separately before sending." />
              <div className="space-y-3 px-4 py-3">
                {enquiry.quotations.length === 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted">
                      {approvedCount === 0
                        ? "Approve a supplier option first, then a quotation can be prepared."
                        : `${approvedCount} of ${enquiry.items.length} products have an approved supplier.`}
                    </p>
                    {canBuildQuotation ? (
                      <form action={buildQuotationAction}>
                        <input type="hidden" name="enquiryId" value={enquiry.id} />
                        <Button size="sm" variant="primary">
                          Prepare customer quotation
                        </Button>
                      </form>
                    ) : null}
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {enquiry.quotations.map((quotation) => (
                      <li key={quotation.id} className="flex items-center justify-between gap-3 py-2">
                        <div>
                          <Link href={`/quotations/${quotation.id}`} className="text-sm font-medium text-ink hover:text-accent">
                            {quotation.quoteNumber}
                          </Link>
                          <p className="text-[11px] text-muted">
                            Version {quotation.version} · {formatMoney(quotation.total, quotation.currency)} ·{" "}
                            {quotation.status.replaceAll("_", " ").toLowerCase()}
                          </p>
                        </div>
                        <ButtonLink href={`/quotations/${quotation.id}`} size="sm">
                          Open
                        </ButtonLink>
                      </li>
                    ))}
                  </ul>
                )}
                {!allCovered && enquiry.items.length > 0 ? (
                  <p className="text-[11px] text-muted">
                    Some products have no approved supplier yet. The quotation can still be prepared and priced manually.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Original request" description="Exactly what the customer sent." />
            <div className="space-y-3 px-4 py-3">
              <div className="rounded-card border border-line bg-bg p-3">
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                  {messages[0]?.body ?? enquiry.rawText ?? "No message text."}
                </p>
                <p className="mt-2 text-[11px] text-muted">
                  {enquiry.channel} · {formatDateTime(messages[0]?.receivedAt ?? enquiry.createdAt)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">What the system understood</p>
                <p className="mt-1 text-xs text-soft">
                  {CLASSIFICATIONS[enquiry.classification as keyof typeof CLASSIFICATIONS] ?? enquiry.classification}
                  {enquiry.classificationConfidence ? ` · ${Math.round(enquiry.classificationConfidence * 100)}% confidence` : ""}
                </p>
              </div>

              {enquiry.attachments.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Attachments</p>
                  {enquiry.attachments.map((attachment) => (
                    <div key={attachment.id} className="rounded-card border border-line p-2">
                      <div className="flex items-center gap-2">
                        {attachment.mimeType.startsWith("image/") ? (
                          <ImageIcon size={14} className="text-muted" aria-hidden />
                        ) : (
                          <FileText size={14} className="text-muted" aria-hidden />
                        )}
                        <a
                          href={`/api/files/${attachment.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-xs text-accent hover:underline"
                        >
                          {attachment.filename}
                        </a>
                        <span className="text-[10px] text-muted">{Math.round(attachment.sizeBytes / 1024)} KB</span>
                      </div>
                      {attachment.mimeType.startsWith("image/") ? (
                        <a href={`/api/files/${attachment.id}`} target="_blank" rel="noreferrer" className="mt-2 block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/files/${attachment.id}`}
                            alt={`Attachment ${attachment.filename}`}
                            className="max-h-48 w-full rounded border border-line object-contain"
                          />
                        </a>
                      ) : null}
                      {attachment.extractionStatus === "NEEDS_REVIEW" || attachment.extractionStatus === "FAILED" ? (
                        <p className="mt-1 text-[11px] text-muted">Check this file against the extracted lines.</p>
                      ) : null}
                      {attachment.pageCount ? (
                        <p className="mt-1 text-[10px] text-muted">{attachment.pageCount} page(s)</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Paperclip size={12} aria-hidden /> No attachments
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Customer" />
            <dl className="space-y-2 px-4 py-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Name</dt>
                <dd className="text-right text-ink">{enquiry.customerName ?? "Not provided"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Phone</dt>
                <dd className="text-right text-ink">{enquiry.customerPhone ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Email</dt>
                <dd className="text-right break-all text-ink">{enquiry.customerEmail ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Delivery location</dt>
                <dd className="text-right text-ink">{enquiry.deliveryLocation ?? "Not stated"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Needed by</dt>
                <dd className="text-right text-ink">{enquiry.deliveryDate ? formatDateTime(enquiry.deliveryDate) : "Not stated"}</dd>
              </div>
            </dl>
          </Card>

          {enquiry.approvals.length > 0 ? (
            <Card>
              <CardHeader title="Waiting for you" />
              <ul className="divide-y divide-line">
                {enquiry.approvals.map((approval) => (
                  <li key={approval.id} className="px-4 py-3">
                    <Link href={`/approvals/${approval.id}`} className="text-xs font-medium text-accent hover:underline">
                      {approval.type === "SOURCING"
                        ? "Supplier option approval"
                        : approval.type === "CUSTOMER_QUOTATION"
                          ? "Customer quotation approval"
                          : "Supplier message approval"}
                    </Link>
                    <p className="text-[11px] text-muted">Requested {timeAgo(approval.createdAt)}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Source conversation" />
            <ul className="divide-y divide-line">
              {messages.map((message) => (
                <li key={message.id} className="px-4 py-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted">
                    <MessageSquare size={11} aria-hidden /> {message.channel.toLowerCase()} · {timeAgo(message.receivedAt)}
                  </p>
                  <p className="mt-0.5 text-xs text-soft">
                    {message.bodyRetained ? truncate(message.body ?? "", 140) : "Message text not retained (personal contact)."}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
