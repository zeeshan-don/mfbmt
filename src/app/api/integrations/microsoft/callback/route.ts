import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/auth";
import {
  exchangeMicrosoftCode,
  microsoftOAuthErrorMessage,
  verifyMicrosoftOAuthState,
} from "@/lib/email/oauth";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/workflow/jobs";
import { JOB_TYPES } from "@/lib/constants";
import { runWithTenant } from "@/lib/tenant";
import { saveIntegration } from "@/lib/integrations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(error: string, extra = ""): NextResponse {
  return NextResponse.redirect(
    `${env.APP_URL}/settings?error=${encodeURIComponent(error)}${extra}#integrations`,
  );
}

export async function GET(request: Request) {
  const user = await requireOwner();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  const store = await cookies();
  const cookieValue = store.get("oauth_state_microsoft")?.value;
  // Single use: remove the state before anything else can read it again.
  store.delete("oauth_state_microsoft");

  if (oauthError) {
    const message = microsoftOAuthErrorMessage(oauthError);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "integration.oauth_failed",
      entityType: "Integration",
      entityId: "MICROSOFT365",
      meta: { stage: "authorise" },
    });
    return back(message);
  }

  if (!code || !state) return back("Microsoft did not return an authorisation code. Please start again.");

  const verified = verifyMicrosoftOAuthState({
    cookieValue,
    returnedState: state,
    organizationId: user.organizationId,
    userId: user.id,
  });
  if (!verified.ok) {
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "integration.oauth_failed",
      entityType: "Integration",
      entityId: "MICROSOFT365",
      meta: { stage: "state" },
    });
    return back(verified.error);
  }

  let result: Awaited<ReturnType<typeof exchangeMicrosoftCode>>;
  try {
    result = await exchangeMicrosoftCode({
      code,
      codeVerifier: verified.data.verifier,
      intent: verified.data.intent,
    });
  } catch {
    return back("Microsoft could not be reached. Check the connection and try again.");
  }

  if (!result.ok) {
    await writeAudit({
      actorId: user.id,
      actorLabel: user.name,
      action: "integration.oauth_failed",
      entityType: "Integration",
      entityId: "MICROSOFT365",
      meta: { stage: "exchange", needsAdminConsent: result.needsAdminConsent ?? false },
    });
    return back(result.error);
  }

  const grantingSending = verified.data.intent === "send";
  let syncQueued = false;
  if (!grantingSending) {
    try {
      await runWithTenant(
        { organizationId: user.organizationId, userId: user.id, source: "internal" },
        () =>
          enqueueJob({
            type: JOB_TYPES.SYNC_EMAIL,
            payload: { trigger: "initial" },
            // Unique per connection attempt so a reconnect always scans promptly.
            idempotencyKey: `email-initial:${result.graphUserId}:${verified.data.nonce}`,
            maxAttempts: 5,
          }),
      );
      syncQueued = true;
    } catch {
      await saveIntegration({
        key: "MICROSOFT365",
        lastError:
          "Outlook is connected, but the first mailbox scan could not be queued. It will run on the next scheduled sync.",
        config: { syncStatus: "CONNECTING" },
      });
    }
  }

  await writeAudit({
    actorId: user.id,
    actorLabel: user.name,
    action: grantingSending ? "integration.email_sending_enabled" : "integration.oauth_connected",
    entityType: "Integration",
    entityId: "MICROSOFT365",
    meta: {
      mailbox: result.accountEmail,
      displayName: result.displayName,
      grantedScopes: result.grantedScopes,
      initialSyncQueued: syncQueued,
      initialSyncDays: env.EMAIL_INITIAL_SYNC_DAYS,
    },
  });

  return NextResponse.redirect(
    `${env.APP_URL}/settings?saved=1&mailbox=${encodeURIComponent(result.accountEmail)}&${
      grantingSending ? "sending=1" : "connected=1"
    }#integrations`,
  );
}
