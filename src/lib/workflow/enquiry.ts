import { db } from "../db";
import { writeAudit, notifyOwner } from "../audit";
import { parseJson, stringifyJson } from "../json";
import { classifyMessage } from "../ai/classify";
import { extractEnquiry, type SourceDocument } from "../ai/extract";
import { extractDocument } from "../intake/documents";
import { assertAllowedUpload, saveAttachment, readAttachment, sniffType } from "../storage";
import { applyInventoryCheck } from "../inventory/check";
import { enqueueJob } from "./jobs";
import { JOB_TYPES } from "../constants";
import { normalizeUnit } from "../catalog/normalize";

export function normalizeIdentifier(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? `+${digits.slice(-15)}` : trimmed;
}

export async function nextEnquiryRef(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await db.enquiry.count({ where: { publicRef: { startsWith: `ENQ-${year}-` } } });
  return `ENQ-${year}-${String(count + 1).padStart(4, "0")}`;
}

async function findExclusion(identifiers: string[]) {
  const candidates = identifiers.filter(Boolean);
  if (candidates.length === 0) return null;
  return db.excludedContact.findFirst({ where: { identifier: { in: candidates } } });
}

export type IngestInput = {
  channel: "WHATSAPP" | "EMAIL" | "MANUAL" | "DEMO";
  externalMessageId: string;
  from: string;
  fromName?: string | null;
  to?: string | null;
  subject?: string | null;
  body: string;
  receivedAt?: Date;
  conversationExternalId?: string | null;
  attachments?: Array<{ filename: string; buffer: Buffer }>;
};

export type IngestResult = {
  messageId: string;
  duplicate: boolean;
  ignored: boolean;
  warnings: string[];
};

/**
 * Entry point for every inbound message. Stores the message exactly once,
 * respects contact exclusions, saves validated attachments and queues
 * processing. Nothing external happens inside this request.
 */
export async function ingestInboundMessage(input: IngestInput): Promise<IngestResult> {
  const existing = await db.message.findUnique({ where: { externalMessageId: input.externalMessageId } });
  if (existing) {
    return { messageId: existing.id, duplicate: true, ignored: false, warnings: [] };
  }

  const identifiers = [normalizeIdentifier(input.from)];
  const contactMatch = await db.contact.findFirst({
    where: {
      OR: [
        { phone: { contains: identifiers[0].replace(/^\+/, "").slice(-9) || identifiers[0] } },
        { email: input.from.toLowerCase() },
      ],
    },
  });
  if (contactMatch?.email) identifiers.push(normalizeIdentifier(contactMatch.email));
  if (contactMatch?.phone) identifiers.push(normalizeIdentifier(contactMatch.phone));

  const exclusion = await findExclusion(identifiers);
  const retainBody = !(
    exclusion &&
    ["FAMILY", "PERSONAL", "OTHER"].includes(exclusion.category)
  );

  let contact = contactMatch;
  if (!contact) {
    contact = await db.contact.create({
      data: {
        name: input.fromName ?? null,
        phone: input.channel === "WHATSAPP" ? input.from : null,
        email: input.channel === "EMAIL" ? input.from.toLowerCase() : null,
        kind: exclusion?.category ?? "UNKNOWN",
      },
    });
  } else if (exclusion && contact.kind !== exclusion.category) {
    contact = await db.contact.update({ where: { id: contact.id }, data: { kind: exclusion.category } });
  }

  const conversationKey =
    input.conversationExternalId ??
    (input.channel === "WHATSAPP" ? input.from : input.from.toLowerCase());

  const conversation =
    (await db.conversation.findUnique({
      where: { channel_externalId: { channel: input.channel, externalId: conversationKey } },
    })) ??
    (await db.conversation.create({
      data: {
        channel: input.channel,
        externalId: conversationKey,
        contactId: contact.id,
        subject: input.subject ?? null,
      },
    }));

  const ignored = !retainBody;
  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      channel: input.channel,
      externalMessageId: input.externalMessageId,
      fromAddress: input.from,
      fromName: input.fromName ?? null,
      toAddress: input.to ?? null,
      subject: input.subject ?? null,
      body: retainBody ? input.body.slice(0, 20_000) : null,
      bodyRetained: retainBody,
      receivedAt: input.receivedAt ?? new Date(),
      processingStatus: ignored ? "IGNORED" : "QUEUED",
      rawMeta: stringifyJson({ channel: input.channel, excludedCategory: exclusion?.category ?? null }),
    },
  });

  const warnings: string[] = [];
  if (retainBody) {
    for (const file of input.attachments ?? []) {
      const check = assertAllowedUpload(file.buffer, file.filename);
      if (!check.ok) {
        warnings.push(`${file.filename}: ${check.error}`);
        continue;
      }
      const stored = await saveAttachment(file.buffer, check.filename);
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
  }

  if (!ignored) {
    await enqueueJob({
      type: JOB_TYPES.INGEST_MESSAGE,
      payload: { messageId: message.id },
      idempotencyKey: `ingest:${input.externalMessageId}`,
    });
  } else {
    await writeAudit({
      action: "message.ignored_personal",
      entityType: "Message",
      entityId: message.id,
      actorLabel: "system",
      meta: { category: exclusion?.category, retained: false },
    });
  }

  return { messageId: message.id, duplicate: false, ignored, warnings };
}

/** Classifies a stored message and creates an enquiry only for genuine RFQs. */
export async function processInboundMessage(messageId: string): Promise<{ outcome: string; enquiryId?: string }> {
  const message = await db.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { contact: true } }, attachments: true, enquiry: true },
  });
  if (!message) throw new Error("Message not found");
  if (message.processingStatus === "PROCESSED" || message.processingStatus === "IGNORED") {
    return { outcome: message.processingStatus.toLowerCase() };
  }
  if (message.enquiryId) return { outcome: "enquiry_exists", enquiryId: message.enquiryId };

  const contact = message.conversation.contact;
  const identifiers = [
    normalizeIdentifier(message.fromAddress),
    normalizeIdentifier(contact?.phone),
    normalizeIdentifier(contact?.email),
  ];
  const exclusion = await findExclusion(identifiers);

  const classification = await classifyMessage({
    text: message.body ?? "",
    subject: message.subject,
    channel: message.channel,
    hasAttachments: message.attachments.length > 0,
    senderKind: contact?.kind,
    excludedCategory: exclusion?.category ?? null,
  });

  const isExcludedPersonal =
    exclusion && ["FAMILY", "PERSONAL", "OTHER"].includes(exclusion.category);

  await db.message.update({
    where: { id: message.id },
    data: {
      classification: classification.result.classification,
      classificationConfidence: classification.result.confidence,
      classificationReason: classification.result.reason,
    },
  });

  if (isExcludedPersonal) {
    await db.message.update({
      where: { id: message.id },
      data: { processingStatus: "IGNORED", body: null, bodyRetained: false },
    });
    return { outcome: "ignored_personal" };
  }

  const cls = classification.result.classification;

  if (cls === "RFQ" || (cls === "UNCLEAR" && message.attachments.length > 0)) {
    const requiresReview =
      cls === "UNCLEAR" ||
      classification.needsReview ||
      classification.result.confidence < 0.65;

    const enquiry = await db.enquiry.create({
      data: {
        publicRef: await nextEnquiryRef(),
        channel: message.channel,
        contactId: contact?.id ?? null,
        conversationId: message.conversationId,
        customerName: contact?.name ?? message.fromName ?? null,
        customerPhone: contact?.phone ?? (message.channel === "WHATSAPP" ? message.fromAddress : null),
        customerEmail: contact?.email ?? (message.channel === "EMAIL" ? message.fromAddress : null),
        rawText: message.body ?? "",
        classification: cls,
        classificationConfidence: classification.result.confidence,
        status: requiresReview && cls === "UNCLEAR" ? "NEEDS_REVIEW" : "EXTRACTING",
        requiresReview: requiresReview && cls === "UNCLEAR",
        reviewReason:
          cls === "UNCLEAR"
            ? `The system could not confirm this is a quotation request. ${classification.result.reason}`
            : classification.aiError
              ? "Read without AI assistance; please check the extracted products."
              : null,
        isDemo: false,
      },
    });

    await db.message.update({
      where: { id: message.id },
      data: {
        enquiryId: enquiry.id,
        processingStatus: cls === "UNCLEAR" ? "NEEDS_REVIEW" : "PROCESSING",
      },
    });

    if (cls === "RFQ") {
      await enqueueJob({
        type: JOB_TYPES.EXTRACT_ENQUIRY,
        payload: { enquiryId: enquiry.id },
        idempotencyKey: `extract:${enquiry.id}`,
      });
    } else {
      await notifyOwner({
        type: "ENQUIRY_REVIEW",
        title: "A message needs your review",
        body: "The system could not tell whether this is a quotation request.",
        link: `/enquiries/${enquiry.id}`,
      });
    }

    return { outcome: "enquiry_created", enquiryId: enquiry.id };
  }

  const reviewOutcome = cls === "AVAILABILITY" || cls === "UNCLEAR";
  if (reviewOutcome) {
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: await nextEnquiryRef(),
        channel: message.channel,
        contactId: contact?.id ?? null,
        conversationId: message.conversationId,
        customerName: contact?.name ?? null,
        customerPhone: contact?.phone ?? null,
        customerEmail: contact?.email ?? null,
        rawText: message.body ?? "",
        classification: cls,
        classificationConfidence: classification.result.confidence,
        status: "NEEDS_REVIEW",
        requiresReview: true,
        reviewReason:
          cls === "AVAILABILITY"
            ? "This asks about availability rather than asking for a quotation. Confirm if you want to prepare a quotation."
            : "The system could not tell whether this is a quotation request.",
      },
    });
    await db.message.update({
      where: { id: message.id },
      data: { enquiryId: enquiry.id, processingStatus: "NEEDS_REVIEW" },
    });
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
    data: { processingStatus: "PROCESSED", classificationReason: classification.result.reason },
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
  for (const attachment of enquiry.attachments) {
    if (!attachment.textExtract) {
      try {
        const buffer = await readAttachment(attachment.storagePath);
        const doc = await extractDocument(buffer, attachment.filename);
        await db.attachment.update({
          where: { id: attachment.id },
          data: {
            textExtract: doc.text.slice(0, 60_000),
            pageCount: doc.pageCount,
            extractionStatus: doc.status,
            extractionNote: doc.note,
            detectedMime: sniffType(buffer).mime,
          },
        });
        if (doc.text) {
          documents.push({
            filename: attachment.filename,
            kind: attachment.mimeType.includes("pdf") ? "pdf" : attachment.mimeType.includes("image") ? "image" : "excel",
            text: doc.text,
            pageCount: doc.pageCount,
            unreadable: doc.unreadable,
          });
        } else if (doc.unreadable) {
          documents.push({
            filename: attachment.filename,
            kind: "other",
            text: "",
            pageCount: doc.pageCount,
            unreadable: true,
          });
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
    } else if (attachment.textExtract) {
      documents.push({
        filename: attachment.filename,
        kind: attachment.mimeType.includes("pdf") ? "pdf" : attachment.mimeType.includes("image") ? "image" : "excel",
        text: attachment.textExtract,
        pageCount: attachment.pageCount,
        unreadable: attachment.extractionStatus === "NEEDS_REVIEW",
      });
    }
  }

  if (enquiry.items.length > 0) {
    // Idempotent: extraction already produced items. Re-check stock, then make
    // sure the enquiry leaves the "reading" state.
    for (const item of enquiry.items) {
      if (item.inventoryStatus === "UNCHECKED") await applyInventoryCheck(item.id);
    }
    const refreshed = await db.enquiryItem.findMany({ where: { enquiryId: enquiry.id } });
    const stillMissing = refreshed.some((item) => parseJson<string[]>(item.missingFields, []).length > 0);
    const unreadableFiles = enquiry.attachments.filter(
      (attachment) => attachment.extractionStatus === "NEEDS_REVIEW" || attachment.extractionStatus === "FAILED",
    ).length;
    const needsReview = stillMissing || unreadableFiles > 0 || refreshed.length === 0;
    await db.enquiry.update({
      where: { id: enquiry.id },
      data: {
        status: needsReview ? "NEEDS_REVIEW" : "READY",
        requiresReview: needsReview,
        reviewReason: needsReview
          ? enquiry.reviewReason ??
            (unreadableFiles > 0
              ? "Some pages or files could not be read. Please check the products against the original document."
              : "Some product details are missing. Please complete them before suppliers are searched.")
          : null,
      },
    });
    return { items: refreshed.length, requiresReview: needsReview };
  }

  const sourceMessage = await db.message.findUnique({ where: { enquiryId: enquiry.id } });
  const extraction = await extractEnquiry({
    text: enquiry.rawText,
    subject: sourceMessage?.subject ?? null,
    documents,
  });

  const unreadable = extraction.extraction.unreadableParts ?? [];
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
      },
    });
    await applyInventoryCheck(created.id);
  }

  const items = await db.enquiryItem.findMany({ where: { enquiryId: enquiry.id } });
  const needsClarification = items.some((item) => parseJson<string[]>(item.missingFields, []).length > 0);
  const requiresReview =
    needsClarification || unreadable.length > 0 || extraction.source === "rule" || items.length === 0;

  const lowConfidence = items.some((item) => {
    const missing = parseJson<string[]>(item.missingFields, []);
    return missing.length > 0;
  });

  await db.enquiry.update({
    where: { id: enquiry.id },
    data: {
      status: requiresReview ? "NEEDS_REVIEW" : "READY",
      requiresReview,
      extractionConfidence: extraction.extraction.classificationConfidence,
      extractedJson: stringifyJson(extraction.extraction),
      reviewReason: requiresReview
        ? unreadable.length > 0
          ? "Some pages or files could not be read. Please check the products against the original document."
          : lowConfidence
            ? "Some product details are missing. Please complete them before suppliers are searched."
            : extraction.aiError
              ? "Products were read without AI assistance. Please check them before sourcing."
              : "Please check the extracted products."
        : null,
    },
  });

  // Queue sourcing only for items that are complete enough to search.
  for (const item of items) {
    const missing = parseJson<string[]>(item.missingFields, []);
    if (missing.length === 0 && item.quantityToSource > 0) {
      await enqueueJob({
        type: JOB_TYPES.RUN_SOURCING,
        payload: { enquiryItemId: item.id },
        idempotencyKey: `sourcing:${item.id}`,
      });
    }
  }

  if (items.length > 0) {
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
