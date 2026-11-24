import { afterEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "../src/lib/crypto";
import {
  MICROSOFT_READ_SCOPES,
  MICROSOFT_SEND_SCOPE,
  createMicrosoftOAuthState,
  microsoftAuthorizeUrl,
  microsoftConnectionState,
  microsoftOAuthErrorMessage,
  microsoftScopes,
  pkceChallenge,
  verifyMicrosoftOAuthState,
} from "../src/lib/email/oauth";
import { initialGraphDeltaUrl } from "../src/lib/email/sync";
import { downloadGraphAttachments, graphRetryDelayMs } from "../src/lib/email/graph";
import { graphClientState, groupGraphNotifications } from "../src/lib/email/routing";

const STATE_INPUT = { organizationId: "org_one", userId: "user_one", intent: "read" as const };

function validState() {
  return createMicrosoftOAuthState(STATE_INPUT);
}

describe("Microsoft OAuth", () => {
  it("requests read-only scopes initially and Mail.Send only when sending is enabled", () => {
    expect([...MICROSOFT_READ_SCOPES]).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.Read",
    ]);
    expect(microsoftScopes("read")).not.toContain(MICROSOFT_SEND_SCOPE);
    expect(microsoftScopes("send")).toContain(MICROSOFT_SEND_SCOPE);
    expect(microsoftScopes("send")).toEqual(expect.arrayContaining([...MICROSOFT_READ_SCOPES]));
  });

  it("derives the RFC 7636 S256 PKCE challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("binds the state to the initiating owner and organisation", () => {
    const created = validState();
    const verified = verifyMicrosoftOAuthState({
      cookieValue: created.cookieValue,
      returnedState: created.state,
      organizationId: STATE_INPUT.organizationId,
      userId: STATE_INPUT.userId,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.data.intent).toBe("read");
      expect(verified.data.verifier).toBe(created.verifier);
    }
  });

  it("rejects a state for another organisation, another user, a wrong state value, and tampering", () => {
    const created = validState();
    expect(
      verifyMicrosoftOAuthState({
        cookieValue: created.cookieValue,
        returnedState: created.state,
        organizationId: "org_two",
        userId: STATE_INPUT.userId,
      }).ok,
    ).toBe(false);
    expect(
      verifyMicrosoftOAuthState({
        cookieValue: created.cookieValue,
        returnedState: created.state,
        organizationId: STATE_INPUT.organizationId,
        userId: "user_two",
      }).ok,
    ).toBe(false);
    expect(
      verifyMicrosoftOAuthState({
        cookieValue: created.cookieValue,
        returnedState: "not-the-state",
        organizationId: STATE_INPUT.organizationId,
        userId: STATE_INPUT.userId,
      }).ok,
    ).toBe(false);
    expect(
      verifyMicrosoftOAuthState({
        cookieValue: `${created.cookieValue}tampered`,
        returnedState: created.state,
        organizationId: STATE_INPUT.organizationId,
        userId: STATE_INPUT.userId,
      }).ok,
    ).toBe(false);
  });

  it("rejects an expired state", () => {
    const expired = signPayload(
      {
        provider: "microsoft",
        organizationId: STATE_INPUT.organizationId,
        userId: STATE_INPUT.userId,
        nonce: "expired-state",
        verifier: "verifier",
        intent: "read",
      },
      -10,
    );
    const verified = verifyMicrosoftOAuthState({
      cookieValue: expired,
      returnedState: "expired-state",
      organizationId: STATE_INPUT.organizationId,
      userId: STATE_INPUT.userId,
    });
    expect(verified.ok).toBe(false);
  });

  it("builds an authorize URL with PKCE, consent and no send scope", () => {
    const created = validState();
    const url = new URL(
      microsoftAuthorizeUrl({
        state: created.state,
        codeChallenge: created.challenge,
        intent: "read",
        loginHint: "owner@example.com",
      }),
    );
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(created.challenge);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("owner@example.com");
    expect(url.searchParams.get("scope")?.split(" ")).not.toContain(MICROSOFT_SEND_SCOPE);
    expect(url.searchParams.get("scope")?.split(" ")).toContain("Mail.Read");
  });

  it("ignores an invalid login hint rather than trusting it as identity", () => {
    const url = new URL(
      microsoftAuthorizeUrl({
        state: "s",
        codeChallenge: "c",
        intent: "send",
        loginHint: "not-an-email<script>",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBeNull();
    expect(url.searchParams.get("scope")?.split(" ")).toContain(MICROSOFT_SEND_SCOPE);
  });

  it("explains admin-consent and cancellation failures in customer language", () => {
    expect(microsoftOAuthErrorMessage("AADSTS65001: consent required")).toMatch(/administrator/i);
    expect(microsoftOAuthErrorMessage("access_denied")).toMatch(/cancelled|not granted/i);
    expect(microsoftOAuthErrorMessage("totally-unknown")).not.toMatch(/AADSTS|trace|stack/i);
  });

  it("does not report sending as enabled unless both the flag and Mail.Send scope are present", () => {
    const withoutScope = microsoftConnectionState(
      JSON.stringify({ grantedScopes: [...MICROSOFT_READ_SCOPES], sendingEnabled: true, accountEmail: "a@b.com" }),
      "CONNECTED",
    );
    expect(withoutScope.sendingEnabled).toBe(false);

    const withScope = microsoftConnectionState(
      JSON.stringify({ grantedScopes: [...MICROSOFT_READ_SCOPES, MICROSOFT_SEND_SCOPE], sendingEnabled: true }),
      "CONNECTED",
    );
    expect(withScope.sendingEnabled).toBe(true);
  });

  it("keeps sending capability for a mailbox connected before scopes were recorded", () => {
    // The old flow requested Mail.Send as part of its only consent and stored no
    // scope list. Upgrading must not silently remove that capability.
    const legacy = microsoftConnectionState(JSON.stringify({ state: "old" }), "CONNECTED");
    expect(legacy.sendingEnabled).toBe(true);

    const disconnected = microsoftConnectionState(JSON.stringify({ state: "old" }), "DISCONNECTED");
    expect(disconnected.sendingEnabled).toBe(false);
  });
});

describe("Microsoft Graph sync", () => {
  it("builds a bounded initial delta using Microsoft's supported filter", () => {
    const url = initialGraphDeltaUrl("inbox", 30, new Date("2026-11-24T00:00:00.000Z"));
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1.0/me/mailFolders/inbox/messages/delta");
    expect(parsed.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-25T00:00:00.000Z");
    expect(parsed.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(parsed.searchParams.get("changeType")).toBe("created");
    expect(parsed.searchParams.get("$top")).toBe("50");
    expect(parsed.searchParams.get("$select")).toContain("receivedDateTime");
  });

  it("clamps the initial window to a sane range", () => {
    const url = new URL(initialGraphDeltaUrl("inbox", 9999, new Date("2026-11-24T00:00:00.000Z")));
    expect(url.searchParams.get("$filter")).toBe("receivedDateTime ge 2025-11-24T00:00:00.000Z");
  });

  it("honours Retry-After and falls back to bounded exponential backoff", () => {
    expect(graphRetryDelayMs({ headers: new Headers({ "Retry-After": "7" }) }, 0)).toBe(7_000);
    expect(graphRetryDelayMs({ headers: new Headers() }, 2)).toBe(4_000);
    expect(graphRetryDelayMs({ headers: new Headers({ "Retry-After": "99999" }) }, 0)).toBe(60_000);
  });
});

describe("Microsoft Graph attachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows pagination, skips inline files and reports unsupported attachment types", async () => {
    const pages: Record<string, unknown> = {
      "https://graph.microsoft.com/v1.0/me/messages/m1/attachments?$top=50": {
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "rfq.pdf",
            contentType: "application/pdf",
            size: 5,
            contentBytes: Buffer.from("%PDF-").toString("base64"),
          },
          {
            "@odata.type": "#microsoft.graph.itemAttachment",
            name: "forwarded-message",
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/next-page",
      },
      "https://graph.microsoft.com/next-page": {
        value: [
          { "@odata.type": "#microsoft.graph.fileAttachment", name: "logo.png", isInline: true, contentBytes: "AAAA" },
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "prices.csv",
            contentType: "text/csv",
            size: 4,
            contentBytes: Buffer.from("a,b\n").toString("base64"),
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = pages[url];
      if (!body) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadGraphAttachments("token", "m1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    expect(result.attachments.map((file) => file.filename)).toEqual(["rfq.pdf", "prices.csv"]);
    expect(result.attachments[0]?.buffer.toString()).toBe("%PDF-");
    expect(result.unsupported).toHaveLength(1);
    expect(result.skippedInline).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("retries a throttled attachment list and respects Retry-After", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("throttled", { status: 429, headers: { "Retry-After": "0" } });
        }
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }),
    );
    const result = await downloadGraphAttachments("token", "m2");
    expect(calls).toBe(2);
    expect(result.failures).toEqual([]);
  });
});

describe("Microsoft Graph webhook grouping", () => {
  const secret = "test-graph-client-state";

  it("groups notifications for several organisations without mixing them", async () => {
    const grouped = await groupGraphNotifications(
      [
        { subscriptionId: "sub-a", clientState: graphClientState("org_a", secret) },
        { subscriptionId: "sub-b", clientState: graphClientState("org_b", secret) },
        { subscriptionId: "sub-a-2", clientState: graphClientState("org_a", secret) },
      ],
      secret,
    );
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(grouped.groups).toHaveLength(2);
    const groupA = grouped.groups.find((group) => group.organizationId === "org_a");
    const groupB = grouped.groups.find((group) => group.organizationId === "org_b");
    expect(groupA?.notifications).toHaveLength(2);
    expect(groupA?.notifications.every((entry) => entry.subscriptionId?.startsWith("sub-a"))).toBe(true);
    expect(groupB?.notifications).toHaveLength(1);
  });

  it("rejects a notification with a forged client state", async () => {
    const grouped = await groupGraphNotifications(
      [{ subscriptionId: "sub-a", clientState: graphClientState("org_a", "wrong-secret") }],
      secret,
    );
    expect(grouped.ok).toBe(false);
    if (!grouped.ok) expect(grouped.status).toBe(401);
  });

  it("rejects a notification with no client state at all", async () => {
    const grouped = await groupGraphNotifications([{ subscriptionId: "sub-a" }], secret);
    expect(grouped.ok).toBe(false);
    if (!grouped.ok) expect(grouped.status).toBe(401);
  });
});
