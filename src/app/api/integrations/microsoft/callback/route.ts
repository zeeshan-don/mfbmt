import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/auth";
import { exchangeCode } from "@/lib/email/oauth";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requireOwner();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${env.APP_URL}/settings?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${env.APP_URL}/settings?error=${encodeURIComponent("Missing authorisation code.")}`);
  }

  const store = await cookies();
  const expected = store.get("oauth_state_microsoft")?.value;
  store.delete("oauth_state_microsoft");
  if (!expected || expected !== state) {
    return NextResponse.redirect(`${env.APP_URL}/settings?error=${encodeURIComponent("Authorisation state did not match. Try again.")}`);
  }

  const result = await exchangeCode("microsoft", code, state);
  if (!result.ok) {
    return NextResponse.redirect(`${env.APP_URL}/settings?error=${encodeURIComponent(result.error)}`);
  }

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: "integration.oauth_connected",
    entityType: "Integration",
    entityId: "MICROSOFT365",
  });

  return NextResponse.redirect(`${env.APP_URL}/settings?saved=1#integrations`);
}
