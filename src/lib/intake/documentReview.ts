import { db } from "../db";
import { parseJson, stringifyJson } from "../json";
import { writeAudit } from "../audit";

/**
 * Owner review action for a page that could not be read automatically.
 * It records the flag without deleting or rewriting the original extraction;
 * the text stays available for comparison and the package returns to review.
 */
export async function markAttachmentPageUnreadable(input: {
  attachmentId: string;
  page: number;
  actorId: string;
  actorLabel: string;
}): Promise<void> {
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > 10_000) {
    throw new Error("Enter a valid page number.");
  }
  const attachment = await db.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!attachment) throw new Error("Attachment not found.");
  const metadata = parseJson<Record<string, unknown>>(attachment.metadataJson ?? "{}", {});
  const existing = Array.isArray(metadata.unreadablePages)
    ? metadata.unreadablePages.filter((page): page is number => typeof page === "number")
    : [];
  const unreadablePages = [...new Set([...existing, input.page])].sort((a, b) => a - b);
  const note = `Page ${input.page} was marked unreadable by ${input.actorLabel}. Compare it with the original.`;

  await db.attachment.update({
    where: { id: attachment.id },
    data: {
      metadataJson: stringifyJson({ ...metadata, unreadablePages }),
      processingStatus: "NEEDS_REVIEW",
      extractionNote: [attachment.extractionNote, note].filter(Boolean).join(" ").slice(0, 1000),
    },
  });
  await writeAudit({
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: "attachment.page_marked_unreadable",
    entityType: "Attachment",
    entityId: attachment.id,
    meta: { page: input.page },
  });
}
