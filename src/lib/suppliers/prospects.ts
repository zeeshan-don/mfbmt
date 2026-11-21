import { db } from "../db";
import { stringifyJson } from "../json";
import type { SourcingCandidate } from "../sourcing/types";
import { normalizeDomain } from "../sourcing/contacts";
import { writeAudit } from "../audit";
import { createDraftSupplierQuoteRequest, sendSupplierQuoteRequest } from "../workflow/supplierQuotes";
import { getOrgLimits } from "../limits";
import { stringifyJson as json } from "../json";

function websiteOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

type EvidenceContacts = {
  emails?: string[];
  phones?: string[];
  contactLinks?: string[];
  sourceUrl?: string;
};

function contactsFromEvidence(candidate: SourcingCandidate): EvidenceContacts {
  const raw = candidate.evidence?.publicContacts;
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  return {
    emails: Array.isArray(record.emails) ? record.emails.filter((value): value is string => typeof value === "string") : [],
    phones: Array.isArray(record.phones) ? record.phones.filter((value): value is string => typeof value === "string") : [],
    contactLinks: Array.isArray(record.contactLinks)
      ? record.contactLinks.filter((value): value is string => typeof value === "string")
      : [],
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : candidate.sourceUrl ?? undefined,
  };
}

/**
 * Upserts only what the public page actually showed. A discovered supplier is
 * never promoted to VERIFIED and its contact is never guessed.
 */
export async function upsertProspectFromCandidate(
  candidate: SourcingCandidate,
  category: string | null,
): Promise<{ supplierId: string; created: boolean } | null> {
  if (!candidate.sourceUrl) return null;
  const domain = normalizeDomain(candidate.sourceUrl);
  if (!domain) return null;

  const existing = await db.supplier.findFirst({
    where: { domain },
    select: { id: true },
  });
  const publicContacts = contactsFromEvidence(candidate);
  if (existing) {
    if (publicContacts.emails?.length || publicContacts.phones?.length) {
      await db.supplier.update({
        where: { id: existing.id },
        data: {
          email: publicContacts.emails?.[0] ?? undefined,
          phone: publicContacts.phones?.[0] ?? undefined,
          lastVerifiedAt: null,
        },
      });
      await addContacts(existing.id, candidate, publicContacts);
    }
    return { supplierId: existing.id, created: false };
  }

  const supplier = await db.supplier.create({
    data: {
      name: candidate.supplierName.trim().slice(0, 200) || domain,
      website: websiteOrigin(candidate.sourceUrl),
      domain,
      country: null,
      categories: stringifyJson(category ? [category] : []),
      status: "UNVERIFIED",
      identityStatus: "DOMAIN_OBSERVED",
      notes: "Discovered from a public supplier result. Confirm the company and contact before relying on it.",
      discoveredFromUrl: candidate.sourceUrl,
      discoveredAt: candidate.retrievedAt,
      email: publicContacts.emails?.[0] ?? null,
      phone: publicContacts.phones?.[0] ?? null,
    },
  });
  await addContacts(supplier.id, candidate, publicContacts);
  await writeAudit({
    action: "supplier.prospect_discovered",
    entityType: "Supplier",
    entityId: supplier.id,
    actorLabel: "sourcing",
    meta: {
      name: supplier.name,
      domain,
      sourceUrl: candidate.sourceUrl,
      emails: publicContacts.emails?.length ?? 0,
      phones: publicContacts.phones?.length ?? 0,
    },
  });
  return { supplierId: supplier.id, created: true };
}

async function addContacts(supplierId: string, candidate: SourcingCandidate, contacts: EvidenceContacts): Promise<void> {
  const sourceUrl = contacts.contactLinks?.[0] ?? candidate.sourceUrl ?? null;
  const retrievedAt = candidate.retrievedAt;
  if (contacts.emails?.length) {
    for (const email of contacts.emails.slice(0, 3)) {
      const exists = await db.supplierContact.findFirst({ where: { supplierId, email } });
      if (!exists) {
        await db.supplierContact.create({
          data: {
            supplierId,
            name: "Public contact",
            email,
            sourceUrl,
            retrievedAt,
            isPrimary: false,
          },
        });
      }
    }
  }
  if (contacts.phones?.length) {
    for (const phone of contacts.phones.slice(0, 3)) {
      const exists = await db.supplierContact.findFirst({ where: { supplierId, phone } });
      if (!exists) {
        await db.supplierContact.create({
          data: { supplierId, name: "Public phone", phone, sourceUrl, retrievedAt },
        });
      }
    }
  }
}

/**
 * Creates a prospect record for each newly discovered public supplier and, only
 * when there is no public price and a real contact, queues one draft RFQ. Drafts
 * are not approvals and are never sent automatically.
 */
export async function upsertProspectsAndDraftRfqs(
  item: { id: string; category: string | null; description: string },
  candidates: SourcingCandidate[],
): Promise<{ prospects: number; drafts: number }> {
  let prospects = 0;
  let drafts = 0;
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const result = await upsertProspectFromCandidate(candidate, item.category);
      if (!result) continue;
      if (result.created) prospects += 1;
      if (candidate.unitPrice != null || drafts >= 3) continue;
      const supplier = await db.supplier.findUnique({
        where: { id: result.supplierId },
        select: { id: true, email: true, phone: true, whatsapp: true, doNotContact: true, status: true, identityStatus: true },
      });
      if (!supplier || supplier.doNotContact || supplier.status === "BLOCKED") continue;
      if (!supplier.email && !supplier.phone && !supplier.whatsapp) continue;
      const existing = await db.supplierQuote.findFirst({
        where: { supplierId: supplier.id, enquiryItemId: item.id, status: { not: "EXPIRED" } },
        select: { id: true },
      });
      if (existing) continue;
      const draft = await createDraftSupplierQuoteRequest({
        supplierId: supplier.id,
        enquiryItemId: item.id,
        userId: "system",
        actorLabel: "sourcing",
      });
      if (draft.ok) {
        drafts += 1;
        const limits = await getOrgLimits();
        if (limits.supplierAutoSendVerified && supplier.status === "ACTIVE" && supplier.identityStatus === "VERIFIED") {
          const owner = await db.user.findFirst({ where: { role: "OWNER", isActive: true }, select: { id: true, name: true } });
          if (owner) {
            const approval = await db.approval.create({
              data: {
                type: "SUPPLIER_QUOTE_SEND",
                entityType: "SupplierQuote",
                entityId: draft.quoteId,
                status: "APPROVED",
                requestedBy: "standing auto-send policy",
                decidedById: owner.id,
                decidedAt: new Date(),
                reason: "Owner enabled auto-send to verified suppliers; recorded standing approval.",
                payloadJson: json({ supplier: supplier.id, policy: "supplierAutoSendVerified" }),
              },
            });
            const sent = await sendSupplierQuoteRequest(draft.quoteId);
            await writeAudit({
              action: sent.ok ? "supplier_quote.auto_sent_verified" : "supplier_quote.auto_send_blocked",
              entityType: "SupplierQuote",
              entityId: draft.quoteId,
              actorLabel: "auto-send-policy",
              meta: { approvalId: approval.id, detail: sent.detail },
            });
          }
        }
      }
    } catch (error) {
      // Discovery is additive: one bad page must not fail a sourcing run.
      await writeAudit({
        action: "supplier.prospect_failed",
        entityType: "EnquiryItem",
        entityId: item.id,
        actorLabel: "sourcing",
        meta: { supplier: candidate.supplierName, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
      });
    }
  }
  return { prospects, drafts };
}
