import { sha256 } from "../crypto";

/**
 * Opaque reply-correlation references.
 *
 * Tokens are derived from the record id, so they are stable across retries and
 * contain no customer, supplier or tenant data. They are printed in the outgoing
 * subject and matched deterministically on the way back in. A token is evidence
 * of which document was answered, never authorisation to change its terms.
 */
export type CorrelationKind = "QTN" | "PO";

export function correlationTokenFor(kind: CorrelationKind, id: string): string {
  return sha256(`${kind}:${id}`).slice(0, 12).toUpperCase();
}

export function extractCorrelationToken(kind: CorrelationKind, text: string | null | undefined): string | null {
  return extractCorrelationTokens(kind, text)[0] ?? null;
}

/**
 * All matching references, not just the first. A subject such as
 * "Purchase order PO-2026-0001 [PO-AB12CD34EF56]" contains both the human PO
 * number and the opaque token; only the opaque one can correlate reliably.
 */
export function extractCorrelationTokens(kind: CorrelationKind, text: string | null | undefined): string[] {
  if (!text) return [];
  const pattern = new RegExp(`\\b${kind}-([A-Z0-9]{8,24})\\b`, "gi");
  const tokens = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    if (match[1]) tokens.add(match[1].toUpperCase());
  }
  return [...tokens];
}

export function correlationReference(kind: CorrelationKind, token: string): string {
  return `${kind}-${token}`;
}
