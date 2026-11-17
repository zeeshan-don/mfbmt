import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { requireOwner } from "@/lib/auth";
import { buildAuthUrl } from "@/lib/email/oauth";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.pathname.includes("gmail") ? "gmail" : "microsoft";
  await requireOwner();

  const authUrl = buildAuthUrl(provider, "");
  if (!authUrl) {
    return NextResponse.redirect(
      `${env.APP_URL}/settings?error=${encodeURIComponent(
        provider === "gmail"
          ? "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET."
          : "Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.",
      )}`,
    );
  }

  const state = `${provider}.${randomBytes(16).toString("base64url")}`;
  const store = await cookies();
  store.set(`oauth_state_${provider}`, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const withState = new URL(authUrl);
  withState.searchParams.set("state", state);
  return NextResponse.redirect(withState.toString());
}
