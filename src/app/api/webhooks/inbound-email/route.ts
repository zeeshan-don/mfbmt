import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rawDb } from "@/lib/db-base";
import { timingSafeEqual } from "@/lib/crypto";
import { ingestInboundMessage } from "@/lib/workflow/enquiry";
import { runWithTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ForwardedEmail = {
  messageId: string;
  from: string;
  fromName?: string;
  subject?: string;
  text: string;
  receivedAt?: string;
  threadId?: string;
  organizationSlug?: string;
  attachments?: Array<{ filename: string; contentBase64: string }>;
};

/**
 * Inbound-email forwarding endpoint for providers that post JSON.
 *
 * Authentication is a shared platform secret. Because more than one company can
 * forward mail, the target workspace must be named explicitly with the
 * `x-organization-slug` header (or `organizationSlug` in the payload). The
 * message is then ingested entirely inside that organization's context; a
 * missing or unknown workspace is rejected rather than guessed.
 */
export async function POST(request: Request) {
  if (!env.INBOUND_EMAIL_SECRET) {
    return NextResponse.json({ error: "Inbound email forwarding is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("x-inbound-secret") ?? "";
  if (!timingSafeEqual(provided, env.INBOUND_EMAIL_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: ForwardedEmail;
  try {
    payload = (await request.json()) as ForwardedEmail;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload?.messageId || !payload.from || typeof payload.text !== "string") {
    return NextResponse.json({ error: "messageId, from and text are required." }, { status: 422 });
  }

  const slug = (request.headers.get("x-organization-slug") ?? payload.organizationSlug ?? "").trim().toLowerCase();
  if (!slug) {
    return NextResponse.json(
      { error: "Missing workspace. Send x-organization-slug (for example: mfbmt)." },
      { status: 422 },
    );
  }
  const organization = await rawDb.organization.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!organization || organization.status !== "ACTIVE") {
    return NextResponse.json({ error: "Unknown or inactive workspace." }, { status: 422 });
  }

  const attachments: Array<{ filename: string; buffer: Buffer }> = [];
  for (const attachment of (payload.attachments ?? []).slice(0, 10)) {
    try {
      attachments.push({
        filename: attachment.filename,
        buffer: Buffer.from(attachment.contentBase64, "base64"),
      });
    } catch {
      // Malformed attachment is skipped; the message itself is still processed.
    }
  }

  const result = await runWithTenant({ organizationId: organization.id, source: "webhook" }, () =>
    ingestInboundMessage({
      channel: "EMAIL",
      externalMessageId: payload.messageId,
      from: payload.from,
      fromName: payload.fromName ?? null,
      subject: payload.subject ?? null,
      body: payload.text,
      receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : new Date(),
      conversationExternalId: payload.threadId ?? null,
      attachments,
    }),
  );

  return NextResponse.json({ ok: true, duplicate: result.duplicate, ignored: result.ignored, warnings: result.warnings });
}
