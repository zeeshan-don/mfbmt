import { db } from "../db";
import { writeAudit } from "../audit";
import { sha256 } from "../crypto";
import { parseJson, stringifyJson } from "../json";
import { classifyMessage } from "../ai/classify";
import { extractEnquiry, type SourceDocument } from "../ai/extract";
import { extractDocument } from "../intake/documents";
import {
  assertAllowedUpload,
  saveAttachmentForOrganization,
  readAttachment,
  sniffType,
  storageReadiness,
} from "../storage";
import { requireTenantId } from "../tenant";
import { getCurrentOrganization } from "../organization";
import { applyInventoryCheck } from "../inventory/check";
import { getOrgLimits } from "../limits";
import { enqueueJob } from "./jobs";
import { nextEnquiryRef } from "./sequences";
import { JOB_TYPES } from "../constants";
import { normalizeUnit } from "../catalog/normalize";
import {
  canonicalPhone,
  findExclusion,
  identify,
  isPrivateCategory,
  isUnknownSender,
  parseEmailAddress,
  parseEmailDisplayName,
} from "../intake/identity";
import { downloadWhatsAppMediaWithRetry, type WhatsAppMediaRef } from "../intake/whatsapp";
import { env } from "../env";

export type IngestInput = {
  channel: "WHATSAPP" | "EMAIL" | "MANUAL" | "DEMO";
  externalMessageId: string;
  from: string;
  fromName?: string | null;
  to?: string | null;
  toPhoneNumberId?: string | null;
  subject?: string | null;
  body: string;
  receivedAt?: Date;
  conversationExternalId?: string | null;
  attachments?: Array<{ filename: string; buffer: Buffer }>;
  /** WhatsApp media that has not been downloaded yet. Resolved by the worker. */
  mediaRefs?: WhatsAppMediaRef[];
};

export type IngestResult = {
  messageId: string;
  duplicate: boolean;
  ignored: boolean;
  warnings: string[];
};

/**
 * True when the sender is on the exclusion list. Callers use this BEFORE
 * downloading media or reading a request body so an excluded contact's content
 * is never fetched, let alone stored.
 */
export async function isSenderExcluded(input: {
  channel: string;
  from: string;
}): Promise<{ excluded: boolean; category: string | null; identifier: string | null }> {
  const identity = identify({ channel: input.channel, from: input.from });
  const match = await findExclusion(identity.candidates);
  return {
    excluded: Boolean(match && isPrivateCategory(match.category)),
    category: match?.category ?? null,
    identifier: match?.identifier ?? null,
  };
}

async function resolveContact(input: {
  channel: IngestInput["channel"];
  phone: string;
  email: string;
  fromName?: string | null;
  identityLabel?: string | null;
}) {
  const or = [
    ...(input.phone ? [{ phone: input.phone }] : []),
    ...(input.email ? [{ email: input.email }] : []),
  ];
  const existing = or.length > 0 ? await db.contact.findFirst({ where: { OR: or } }) : null;
  if (existing) {
    const patch: Record<string, string> = {};
    if (input.phone && !existing.phone) patch.phone = input.phone;
    if (input.email && !existing.email) patch.email = input.email;
    if (Object.keys(patch).length === 0) return existing;
    return db.contact.update({ where: { id: existing.id }, data: patch });
  }
  return db.contact.create({
    data: {
      name: input.identityLabel ?? input.fromName ?? null,
      phone: input.phone || null,
      email: input.email || null,
      kind: "UNKNOWN",
    },
  });
}

/**
 * Entry point for every inbound message.
 *
 * Order matters: identity is normalized, the exclusion list is consulted, and
 * only then is anything written. An excluded contact's body and attachments are
 * never persisted, never queued, and never sent to an AI provider.
 */
export async function ingestInboundMessage(input: IngestInput): Promise<IngestResult> {
  const existing = await db.message.findFirst({ where: { externalMessageId: input.externalMessageId } });
  if (existing) {
    return { messageId: existing.id, duplicate: true, ignored: existing.processingStatus === "IGNORED", warnings: [] };
  }

  const identity = identify({ channel: input.channel, from: input.from });
  const exclusion = await findExclusion(identity.candidates);
  const excluded = Boolean(exclusion && isPrivateCategory(exclusion.category));

  const fromName =
    input.fromName ??
    (input.channel === "EMAIL" ? parseEmailDisplayName(input.from) : null) ??
    null;

  const contact = await resolveContact({
    channel: input.channel,
    phone: identity.phone,
    email: identity.email,
    fromName,
    identityLabel: excluded ? (exclusion?.label ?? null) : null,
  });
  if (exclusion && contact.kind !== exclusion.category) {
    await db.contact.update({ where: { id: contact.id }, data: { kind: exclusion.category } });
  }

  const conversationKey =
    input.conversationExternalId ??
    identity.email ??
    (identity.phone || input.from).toLowerCase();

  // Concurrent messages from the same sender must share one conversation. A
  // read-then-create is not safe under a burst (two workers both see nothing),
  // so let the database resolve the unique key atomically.
  const conversationOrganizationId = await requireTenantId();
  const conversationWhere = {
    organizationId_channel_externalId: {
      organizationId: conversationOrganizationId,
      channel: input.channel,
      externalId: conversationKey,
    },
  };
  // The tenant guard adds an extra filter to `where`, which makes Prisma fall
  // back to a read-then-write upsert. If two senders race, the loser gets P2002;
  // the winner's row is already committed, so resolve it rather than failing.
  const conversation = await db.conversation
    .upsert({
      where: conversationWhere,
      update: {},
      create: {
        channel: input.channel,
        externalId: conversationKey,
        contactId: contact.id,
        subject: excluded ? null : (input.subject ?? null),
      },
    })
    .catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code !== "P2002") throw error;
      return db.conversation.findUniqueOrThrow({ where: conversationWhere });
    });

  const bodyText = excluded ? "" : input.body.slice(0, 20_000);

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      channel: input.channel,
      externalMessageId: input.externalMessageId,
      fromAddress: identity.email || identity.phone || input.from,
      fromName: excluded ? null : fromName,
      toAddress: excluded ? null : (input.to ?? null),
      toPhoneNumberId: input.toPhoneNumberId ?? null,
      subject: excluded ? null : (input.subject ?? null),
      body: excluded ? null : bodyText,
      bodyRetained: !excluded,
      bodyHash: excluded ? null : sha256(bodyText),
      skipReason: excluded ? `Excluded contact (${exclusion?.category}). Content not stored.` : null,
      receivedAt: input.receivedAt ?? new Date(),
      processingStatus: excluded ? "IGNORED" : "QUEUED",
      rawMeta: stringifyJson({
        channel: input.channel,
        excludedCategory: excluded ? (exclusion?.category ?? null) : null,
        pendingMedia: excluded ? [] : (input.mediaRefs ?? []),
      }),
    },
  });

  if (excluded) {
    await writeAudit({
      action: "message.excluded_before_storage",
      entityType: "Message",
      entityId: message.id,
      actorLabel: "system",
      meta: { category: exclusion?.category ?? null, channel: input.channel, bodyStored: false, attachmentsStored: 0 },
    });
    return {
      messageId: message.id,
      duplicate: false,
      ignored: true,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  // Fail closed: a misconfigured storage driver must never write a file to
  // ephemeral disk and pretend it is saved.
  const organizationId = await requireTenantId();
  const readiness = storageReadiness();
  const hasIncomingFiles = (input.attachments?.length ?? 0) > 0 || (input.mediaRefs?.length ?? 0) > 0;
  if (hasIncomingFiles && !readiness.ok) {
    warnings.push(`Files could not be stored: ${readiness.detail}`);
    await writeAudit({
      action: "storage.unavailable",
      entityType: "Message",
      entityId: message.id,
      actorLabel: "system",
      meta: { detail: readiness.detail, files: (input.attachments?.length ?? 0) + (input.mediaRefs?.length ?? 0) },
    });
  }
  for (const file of input.attachments ?? []) {
    if (!readiness.ok) break;
    const check = assertAllowedUpload(file.buffer, file.filename);
    if (!check.ok) {
      warnings.push(`${file.filename}: ${check.error}`);
      continue;
    }
    const stored = await saveAttachmentForOrganization(file.buffer, check.filename, organizationId);
    try {
      await db.attachment.create({
        data: {
          messageId: message.id,
          filename: check.filename,
          storedName: stored.storedName,
          mimeType: check.mime,
          detectedMime: check.mime,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storagePath: stored.storagePath,
        },
      });
    } catch {
      warnings.push(`${file.filename} was already received with this message.`);
    }
  }

  await enqueueJob({
    type: JOB_TYPES.INGEST_MESSAGE,
    payload: { messageId: message.id },
    idempotencyKey: `ingest:${input.externalMessageId}`,
  });

  return { messageId: message.id, duplicate: false, ignored: false, warnings };
}

/**
 * Downloads WhatsApp media that was recorded during durable intake. A transient
 * failure throws so the job retries; a permanent one is recorded and flagged for
 * review instead of silently dropping the attachment.
 */
async function resolvePendingMedia(message: {
  id: string;
  rawMeta: string | null;
}): Promise<{ downloaded: number; failures: string[] }> {
  const meta = parseJson<{ pendingMedia?: WhatsAppMediaRef[] }>(message.rawMeta, {});
  const pending = meta.pendingMedia ?? [];
  if (pending.length === 0) return { downloaded: 0, failures: [] };

  const readiness = storageReadiness();
  if (!readiness.ok) {
    return { downloaded: 0, failures: [readiness.detail] };
  }
  const organizationId = await requireTenantId();

  const failures: string[] = [];
  let downloaded = 0;
  const remaining: WhatsAppMediaRef[] = [];

  for (const ref of pending) {
    const result = await downloadWhatsAppMediaWithRetry(ref.id);
    if (!result.ok) {
      if (!result.permanent) {
        // Keep the reference so the retried job can try again.
        remaining.push(ref);
        throw new Error(`Attachment download failed: ${result.error}`);
      }
      failures.push(`${ref.filename ?? ref.id}: ${result.error}`);
      continue;
    }
    const filename =
      ref.filename ??
      `whatsapp-${ref.id}.${ref.mimeType.includes("pdf") ? "pdf" : (ref.mimeType.split("/")[1] ?? "bin").split(";")[0]}`;
    const check = assertAllowedUpload(result.buffer, filename);
    if (!check.ok) {
      failures.push(`${filename}: ${check.error}`);
      continue;
    }
    const stored = await saveAttachmentForOrganization(result.buffer, check.filename, organizationId);
    try {
      await db.attachment.create({
        data: {
          messageId: message.id,
          filename: check.filename,
          storedName: stored.storedName,
          mimeType: check.mime,
          detectedMime: check.mime,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storagePath: stored.storagePath,
        },
      });
      downloaded += 1;
    } catch {
      failures.push(`${filename}: already received.`);
    }
  }

  await db.message.update({
    where: { id: message.id },
    data: { rawMeta: stringifyJson({ ...meta, pendingMedia: remaining, mediaFailures: failures }) },
  });
  return { downloaded, failures };
}

/** Classifies a stored message and creates an enquiry only for genuine RFQs. */
export async function processInboundMessage(messageId: string): Promise<{ outcome: string; enquiryId?: string }> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { contact: true } }, attachments: true, enquiry: true },
  });
  if (!message) throw new Error("Message not found");
  if (message.processingStatus === "IGNORED") return { outcome: "ignored" };
  if (message.processingStatus === "PROCESSED" && message.enquiryId) {
    return { outcome: "processed", enquiryId: message.enquiryId };
  }
  if (message.enquiryId) return { outcome: "enquiry_exists", enquiryId: message.enquiryId };

  const contact = message.conversation.contact;
  const identifiers = [
    canonicalPhone(message.fromAddress),
    canonicalPhone(contact?.phone),
    parseEmailAddress(contact?.email) || parseEmailAddress(message.fromAddress),
  ].filter(Boolean);

  // The exclusion list can change between receipt and processing.
  const exclusion = await findExclusion(identifiers);
  if (exclusion && isPrivateCategory(exclusion.category)) {
    await db.attachment.deleteMany({ where: { messageId: message.id } });
    await db.message.update({
      where: { id: message.id },
      data: {
        processingStatus: "IGNORED",
        body: null,
        bodyRetained: false,
        bodyHash: null,
        subject: null,
        fromName: null,
        skipReason: `Excluded contact (${exclusion.category}).`,
      },
    });
    await writeAudit({
      action: "message.excluded_before_ai",
      entityType: "Message",
      entityId: message.id,
      actorLabel: "system",
      meta: { category: exclusion.category },
    });
    return { outcome: "ignored_personal" };
  }

  const media = await resolvePendingMedia(message);
  if (media.failures.length > 0) {
    await writeAudit({
      action: "message.attachment_failed",
      entityType: "Message",
      entityId: message.id,
      actorLabel: "system",
      meta: { failures: media.failures },
    });
  }

  const attachmentCount = await db.attachment.count({ where: { messageId: message.id } });

  const unknownSender = await isUnknownSender({
    phone: canonicalPhone(contact?.phone ?? message.fromAddress),
    email: parseEmailAddress(contact?.email) || parseEmailAddress(message.fromAddress),
    contactKind: contact?.kind,
  });
  const allowAi = !unknownSender || env.AI_FOR_UNKNOWN_SENDERS === "true";

  const classification = await classifyMessage({
    text: message.body ?? "",
    subject: message.subject,
    channel: message.channel,
    hasAttachments: attachmentCount > 0,
    senderKind: contact?.kind,
    excludedCategory: null,
    allowAi,
  });

  await db.message.update({
    where: { id: message.id },
    data: {
      classification: classification.result.classification,
      classificationSource: classification.source,
      classificationConfidence: classification.result.confidence,
      classificationReason: classification.result.reason,
    },
  });

  const cls = classification.result.classification;
  const uncertain = classification.result.confidence < 0.65 || cls === "UNCLEAR";
  const attachmentTrouble = media.failures.length > 0;

  const baseForReview = (reason: string) =>
    db.enquiry.create({
      data: {
        publicRef: "",
        channel: message.channel,
        contactId: contact?.id ?? null,
        conversationId: message.conversationId,
        customerName: contact?.name ?? message.fromName ?? null,
        customerPhone: contact?.phone ?? (message.channel === "WHATSAPP" ? canonicalPhone(message.fromAddress) : null),
        customerEmail:
          contact?.email ?? (message.channel === "EMAIL" ? parseEmailAddress(message.fromAddress) : null),
        rawText: message.body ?? "",
        classification: cls,
        classificationConfidence: classification.result.confidence,
        status: "NEEDS_REVIEW",
        requiresReview: true,
        reviewReason: reason,
      },
    });

  if (cls === "RFQ" || (cls === "UNCLEAR" && attachmentCount > 0)) {
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: await nextEnquiryRef(),
        channel: message.channel,
        contactId: contact?.id ?? null,
        conversationId: message.conversationId,
        customerName: contact?.name ?? message.fromName ?? null,
        customerPhone: contact?.phone ?? (message.channel === "WHATSAPP" ? canonicalPhone(message.fromAddress) : null),
        customerEmail:
          contact?.email ?? (message.channel === "EMAIL" ? parseEmailAddress(message.fromAddress) : null),
        rawText: message.body ?? "",
        classification: cls,
        classificationConfidence: classification.result.confidence,
        status: cls === "UNCLEAR" ? "NEEDS_REVIEW" : "EXTRACTING",
        requiresReview: cls === "UNCLEAR" || uncertain || attachmentTrouble || unknownSender,
        reviewReason:
          attachmentTrouble
            ? "An attachment could not be downloaded from WhatsApp. Ask the customer to re-send it or upload it manually."
            : unknownSender
              ? "First message from an unknown sender: classified locally, not sent to an AI service. Confirm it is a quotation request."
              : cls === "UNCLEAR"
                ? `The system could not confirm this is a quotation request. ${classification.result.reason}`
                : classification.aiError
                  ? "Read without AI assistance; please check the extracted products."
                  : null,
      },
    });

    await db.message.update({
      where: { id: message.id },
      data: {
        enquiryId: enquiry.id,
        processingStatus: cls === "UNCLEAR" ? "NEEDS_REVIEW" : "PROCESSING",
      },
    });
    await db.attachment.updateMany({
      where: { messageId: message.id },
      data: { enquiryId: enquiry.id },
    });

    if ((cls === "RFQ" || (cls === "UNCLEAR" && attachmentCount > 0)) && !attachmentTrouble) {
      await enqueueJob({
        type: JOB_TYPES.EXTRACT_ENQUIRY,
        payload: { enquiryId: enquiry.id },
        idempotencyKey: `extract:${enquiry.id}`,
      });
    }
    return { outcome: "enquiry_created", enquiryId: enquiry.id };
  }

  if (cls === "AVAILABILITY" || cls === "UNCLEAR") {
    const enquiry = await baseForReview(
      cls === "AVAILABILITY"
        ? "This asks about availability rather than asking for a quotation. Confirm if you want to prepare a quotation."
        : "The system could not tell whether this is a quotation request.",
    );
    await db.message.update({
      where: { id: message.id },
      data: { enquiryId: enquiry.id, processingStatus: "NEEDS_REVIEW" },
    });
    await db.attachment.updateMany({
      where: { messageId: message.id },
      data: { enquiryId: enquiry.id },
    });
    const { notifyOwner } = await import("../audit");
    await notifyOwner({
      type: "ENQUIRY_REVIEW",
      title: "A message needs your review",
      body: "It may be a product question rather than a quotation request.",
      link: `/enquiries/${enquiry.id}`,
    });
    return { outcome: "needs_review", enquiryId: enquiry.id };
  }

  await db.message.update({
    where: { id: message.id },
    data: { processingStatus: "PROCESSED" },
  });
  return { outcome: "not_rfq" };
}

/** Reads attachments, extracts line items, checks stock and queues sourcing. */
export async function extractEnquiryById(enquiryId: string): Promise<{ items: number; requiresReview: boolean }> {
  const enquiry = await db.enquiry.findUnique({
    where: { id: enquiryId },
    include: { attachments: true, items: true },
  });
  if (!enquiry) throw new Error("Enquiry not found");

  await db.enquiry.update({ where: { id: enquiry.id }, data: { status: "EXTRACTING" } });

  const documents: SourceDocument[] = [];
  const newlyExtractedDocs: SourceDocument[] = [];
  for (const attachment of enquiry.attachments) {
    if (!attachment.textExtract) {
      try {
        const buffer = await readAttachment(attachment.storagePath);
        const doc = await extractDocument(buffer, attachment.filename);
        await db.attachment.update({
          where: { id: attachment.id },
          data: {
            textExtract: doc.text.slice(0, 80_000),
            pageCount: doc.pageCount,
            extractionStatus: doc.status,
            extractionNote: doc.note,
            detectedMime: sniffType(buffer).mime,
          },
        });
        if (doc.text || doc.unreadable) {
          const sourceDoc = {
            filename: attachment.filename,
            kind: attachment.mimeType.includes("pdf")
              ? "pdf"
              : attachment.mimeType.includes("image")
                ? "image"
                : attachment.mimeType.includes("sheet") || attachment.mimeType.includes("excel") || attachment.mimeType.includes("csv")
                  ? "excel"
                  : "text",
            text: doc.text,
            pageCount: doc.pageCount,
            unreadable: doc.unreadable,
            images: doc.images,
          } as SourceDocument;
          documents.push(sourceDoc);
          newlyExtractedDocs.push(sourceDoc);
        }
      } catch (error) {
        await db.attachment.update({
          where: { id: attachment.id },
          data: {
            extractionStatus: "FAILED",
            extractionNote: error instanceof Error ? error.message.slice(0, 300) : "Could not read the file.",
          },
        });
      }
    } else {
      documents.push({
        filename: attachment.filename,
        kind: attachment.mimeType.includes("pdf")
          ? "pdf"
          : attachment.mimeType.includes("image")
            ? "image"
            : attachment.mimeType.includes("sheet") || attachment.mimeType.includes("excel") || attachment.mimeType.includes("csv")
              ? "excel"
              : "text",
        text: attachment.textExtract,
        pageCount: attachment.pageCount,
        unreadable: attachment.extractionStatus === "NEEDS_REVIEW",
      });
    }
  }

  // Only a failed read holds the request back. A file that was read with a
  // caveat (OCR used, layout guessed) is not a failed extraction.
  const unreadableFiles = await db.attachment.count({
    where: { enquiryId: enquiry.id, extractionStatus: "FAILED" },
  });

  if (enquiry.items.length > 0 && newlyExtractedDocs.length === 0) {
    for (const item of enquiry.items) {
      if (item.inventoryStatus === "UNCHECKED") await applyInventoryCheck(item.id);
    }
    const refreshed = await db.enquiryItem.findMany({ where: { enquiryId: enquiry.id } });
    // Missing attributes are shown on the individual line, so they no longer
    // flag the whole request; only an unreadable file or an empty result does.
    const needsReview = unreadableFiles > 0 || refreshed.length === 0;
    await db.enquiry.update({
      where: { id: enquiry.id },
      data: {
        status: needsReview ? "NEEDS_REVIEW" : "READY",
        requiresReview: needsReview,
        reviewReason: needsReview
          ? (enquiry.reviewReason ??
            (unreadableFiles > 0
              ? "Some pages or files could not be read. Please check the products against the original document."
              : "No product lines could be found in this request. Please add them or check the original document."))
          : null,
      },
    });
    return { items: refreshed.length, requiresReview: needsReview };
  }

  const sourceMessage = await db.message.findUnique({ where: { enquiryId: enquiry.id } });
  const organization = await getCurrentOrganization();
  const industrialSpecs = organization?.procurementProfile === "INDUSTRIAL";
  const limits = await getOrgLimits();
  const extractionText = enquiry.items.length > 0 ? "" : enquiry.rawText;
  const extractionDocuments = enquiry.items.length > 0 ? newlyExtractedDocs : documents;
  let extraction = await extractEnquiry(
    {
      text: extractionText,
      subject: sourceMessage?.subject ?? null,
      documents: extractionDocuments,
    },
    { industrial: industrialSpecs },
  );

  // Optional second AI pass for low-confidence extractions. Only runs when the
  // owner has enabled it; the pass is kept only if it reduces missing fields.
  if (limits.lowConfidenceSecondPass && extraction.source === "ai") {
    const missingCount = (result: typeof extraction) =>
      (result.items ?? []).reduce((sum, item) => sum + (item.missingFields?.length ?? 0), 0);
    const hasGaps = missingCount(extraction) > 0;
    if (hasGaps) {
      try {
        const second = await extractEnquiry(
          {
            text: enquiry.rawText,
            subject: sourceMessage?.subject ?? null,
            documents,
          },
          { industrial: industrialSpecs, secondPass: true },
        );
        if (second.source === "ai" && missingCount(second) < missingCount(extraction)) {
          extraction = second;
        }
      } catch {
        // The first pass result is retained.
      }
    }
  }
  let lineNo = 1;
  for (const item of extraction.items) {
    const created = await db.enquiryItem.create({
      data: {
        enquiryId: enquiry.id,
        lineNo: lineNo++,
        description: item.description,
        rawText: item.sourceRef ?? null,
        category: item.category ?? null,
        brand: item.brand ?? null,
        size: item.size ?? null,
        material: item.material ?? null,
        grade: item.grade ?? null,
        pressureRating: item.pressureRating ?? null,
        schedule: item.schedule ?? null,
        standard: item.standard ?? null,
        unit: normalizeUnit(item.unit),
        quantity: item.quantity ?? 0,
        missingFields: stringifyJson(item.missingFields ?? []),
        confidence: stringifyJson(item.confidence ?? {}),
        sourceRef: item.sourceRef ?? null,
        clarificationQuestion: item.clarificationQuestion,
        reviewStatus: item.clarificationQuestion ? "NEEDS_CLARIFICATION" : "PENDING",
        extractedJson: stringifyJson(item),
        industrialSpecJson: item.industrialSpec ? stringifyJson(item.industrialSpec) : null,
        fastenerSpecJson: item.fastenerSpec ? stringifyJson(item.fastenerSpec) : null,
        fastenerType: item.fastenerSpec?.type ?? null,
        diameter: item.fastenerSpec?.diameter ?? null,
        threadSeries: item.fastenerSpec?.threadSeries ?? null,
        pitchMm: item.fastenerSpec?.pitchMm ?? null,
        lengthMm: item.fastenerSpec?.lengthMm ?? null,
        propertyClass: item.fastenerSpec?.propertyClass ?? null,
        finish: item.fastenerSpec?.finish ?? null,
        specSource: "EXTRACTED",
      },
    });
    await applyInventoryCheck(created.id);
  }

  const items = await db.enquiryItem.findMany({ where: { enquiryId: enquiry.id } });
  // Incomplete attributes stay on their line (they already carry a clarification
  // question and are never sourced). Flagging the whole request for them made
  // every ordinary quotation look broken.
  const requiresReview = items.length === 0 || unreadableFiles > 0 || extraction.source === "rule";

  await db.enquiry.update({
    where: { id: enquiry.id },
    data: {
      status: requiresReview ? "NEEDS_REVIEW" : "READY",
      requiresReview,
      extractionConfidence: extraction.extraction.classificationConfidence,
      extractedJson: stringifyJson(extraction.extraction),
      reviewReason: requiresReview
        ? unreadableFiles > 0
          ? "Some attachments could not be read. Please check the products against the original document."
          : items.length === 0
            ? "No product lines could be found. Please add them or check the original document."
            : extraction.aiError
              ? "Products were read without AI assistance. Please check them before sourcing."
              : "Please check the extracted products."
        : null,
    },
  });

  let sourcingSlots = limits.maxItemsPerEnquiry;
  let cappedItems = 0;
  for (const item of items) {
    const missing = parseJson<string[]>(item.missingFields, []);
    if (missing.length === 0 && item.quantityToSource > 0) {
      if (sourcingSlots <= 0) {
        cappedItems += 1;
        continue;
      }
      sourcingSlots -= 1;
      await enqueueJob({
        type: JOB_TYPES.RUN_SOURCING,
        payload: { enquiryItemId: item.id },
        idempotencyKey: `sourcing:${item.id}`,
      });
    }
  }
  if (cappedItems > 0) {
    const { notifyOwner } = await import("../audit");
    await notifyOwner({
      type: "SOURCING_LIMIT",
      title: "Sourcing limit reached for an enquiry",
      body: `${cappedItems} extra item${cappedItems === 1 ? " was" : "s were"} kept for review but not sourced automatically. The configured limit is ${limits.maxItemsPerEnquiry} items per enquiry.`,
      link: `/enquiries/${enquiry.id}`,
    });
  }

  if (items.length > 0) {
    const { notifyOwner } = await import("../audit");
    await notifyOwner({
      type: requiresReview ? "ENQUIRY_REVIEW" : "ENQUIRY_READY",
      title: requiresReview ? "A new enquiry needs your review" : "A new enquiry is ready",
      body: `${items.length} product${items.length === 1 ? "" : "s"} read from the request.`,
      link: `/enquiries/${enquiry.id}`,
    });
  }

  return { items: items.length, requiresReview };
}

/** Manual re-run of the inventory comparison for every line. */
export async function checkEnquiryInventory(enquiryId: string) {
  const items = await db.enquiryItem.findMany({ where: { enquiryId } });
  for (const item of items) {
    await applyInventoryCheck(item.id);
  }
  return items.length;
}

/** Kept for callers that used the old helper name. */
export const normalizeIdentifier = (value: string | null | undefined): string =>
  value && value.includes("@") ? (parseEmailAddress(value) || value.trim().toLowerCase()) : canonicalPhone(value);
