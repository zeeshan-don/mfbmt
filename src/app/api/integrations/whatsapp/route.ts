import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { authorizeOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import {
  completeSignup,
  createSignupLaunch,
  disconnectWhatsApp,
  getWhatsAppConnection,
  testWhatsAppConnection,
} from "@/lib/integrations/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only this app's own origin may drive the connection flow. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetch from a server action has no Origin
  try {
    return new URL(origin).host === new URL(env.APP_URL).host;
  } catch {
    return false;
  }
}

export async function GET() {
  const user = await authorizeOwner();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const connection = await getWhatsAppConnection();
  return NextResponse.json({ connection });
}

/**
 * Embedded Signup actions. Every action requires an authenticated owner and a
 * same-origin request; the access token never leaves the server.
 */
export async function POST(request: Request) {
  const user = await authorizeOwner();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  if (action === "initiate") {
    try {
      const launch = createSignupLaunch(Boolean(body.coexistence));
      await writeAudit({
        actorId: user.id,
        actorLabel: user.name,
        action: "whatsapp.signup_started",
        entityType: "Integration",
        entityId: "WHATSAPP",
        meta: { coexistence: Boolean(body.coexistence) },
      });
      return NextResponse.json({ ok: true, ...launch });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "WhatsApp signup could not start." },
        { status: 503 },
      );
    }
  }

  if (action === "complete") {
    const result = await completeSignup({
      code: String(body.code ?? ""),
      wabaId: String(body.wabaId ?? ""),
      phoneNumberId: body.phoneNumberId ? String(body.phoneNumberId) : null,
      businessId: body.businessId ? String(body.businessId) : null,
      state: String(body.state ?? ""),
      event: body.event ? String(body.event) : null,
    });
    if (!result.ok) {
      await writeAudit({
        actorId: user.id,
        actorLabel: user.name,
        action: "whatsapp.signup_failed",
        entityType: "Integration",
        entityId: "WHATSAPP",
        meta: { error: result.error, code: result.code ?? null },
      });
      return NextResponse.json({ error: result.error, code: result.code }, { status: 400 });
    }
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "whatsapp.connected",
      entityType: "Integration",
      entityId: "WHATSAPP",
      meta: {
        phoneNumber: result.connection.phoneNumber,
        wabaId: result.connection.wabaId,
        coexistence: result.connection.coexistence,
      },
    });
    return NextResponse.json({ ok: true, connection: result.connection, notes: result.notes });
  }

  if (action === "test") {
    const result = await testWhatsAppConnection();
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "integration.tested",
      entityType: "Integration",
      entityId: "WHATSAPP",
      meta: { ok: result.ok, detail: result.detail },
    });
    const connection = await getWhatsAppConnection();
    return NextResponse.json({ ok: result.ok, detail: result.detail, connection });
  }

  if (action === "disconnect") {
    await disconnectWhatsApp(user.name);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "whatsapp.disconnected",
      entityType: "Integration",
      entityId: "WHATSAPP",
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
