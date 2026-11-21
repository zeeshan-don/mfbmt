import { NextResponse } from "next/server";
import { rawDb } from "@/lib/db-base";
import { getCurrentUser } from "@/lib/auth";
import { keyBelongsToOrganization, readAttachment, verifyDownloadToken } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Attachment download: authenticated staff or an HMAC-signed expiring link. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  // An expiring signed token is a capability for exactly this attachment; an
  // authenticated user must belong to the attachment's organization.
  const attachment = await rawDb.attachment.findUnique({ where: { id } });
  if (!attachment) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const user = await getCurrentUser();
  const tokenValid = token ? verifyDownloadToken(id, token) : false;
  if (!tokenValid && (!user || user.organizationId !== attachment.organizationId)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Defence in depth: a new tenant-scoped key must carry the record's own
  // organization prefix. Legacy keys have no tenant prefix, so their ownership
  // is established by the database row checked above.
  const keyOwnership = keyBelongsToOrganization(attachment.storagePath, attachment.organizationId);
  if (!keyOwnership.ok) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const buffer = await readAttachment(attachment.storagePath);
    const inline = attachment.mimeType.startsWith("image/") || attachment.mimeType === "application/pdf";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${attachment.filename.replace(/["\\\r\n]/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; object-src 'none'",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "The file could not be read." }, { status: 500 });
  }
}
