import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/auth";
import {
  createMicrosoftOAuthState,
  microsoftAuthorizeUrl,
  microsoftConfigured,
  type MicrosoftOAuthIntent,
} from "@/lib/email/oauth";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-click Outlook connection.
 *
 * `intent=send` is the optional, separate consent for outbound email. Anything
 * else starts the read-only connection (Mail.Read only).
 */
export async function GET(request: Request) {
  const user = await requireOwner();
  const url = new URL(request.url);

  if (!microsoftConfigured()) {
    return NextResponse.redirect(
      `${env.APP_URL}/settings?error=${encodeURIComponent(
        "Outlook sign-in is not available yet. The platform administrator must configure the Microsoft application.",
      )}#integrations`,
    );
  }

  const intent: MicrosoftOAuthIntent = url.searchParams.get("intent") === "send" ? "send" : "read";
  const { state, cookieValue, challenge } = createMicrosoftOAuthState({
    organizationId: user.organizationId,
    userId: user.id,
    intent,
  });

  const store = await cookies();
  store.set("oauth_state_microsoft", cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(
    microsoftAuthorizeUrl({
      state,
      codeChallenge: challenge,
      intent,
      loginHint: url.searchParams.get("login_hint"),
    }),
  );
}
