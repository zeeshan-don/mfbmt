"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "./ui";

/**
 * Meta WhatsApp Embedded Signup (JS SDK, v4) launcher.
 *
 * The browser only receives the launch configuration, the authorisation code and
 * the asset ids Meta posts back. The token exchange, WABA verification and
 * credential storage happen server-side in /api/integrations/whatsapp.
 */
type Launch = { appId: string; configId: string; apiVersion: string; state: string };

type SignupSession = {
  code: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
  event: string | null;
  sessionInfoVersion: string | null;
};

type SignupMessage = {
  type?: string;
  event?: string;
  data?: {
    phone_number_id?: string;
    waba_id?: string;
    business_id?: string;
  };
  session_info_version?: string;
};

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (
        callback: (response: {
          authResponse?: { code?: string };
          status?: string;
        }) => void,
        options: Record<string, unknown>,
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function loadSdk(appId: string, apiVersion: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve();
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version: apiVersion });
      resolve();
    };
    const existing = document.getElementById("facebook-jssdk");
    if (existing) return;
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.async = true;
    script.defer = true;
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.onerror = () => reject(new Error("Facebook SDK could not be loaded. Check the network or an ad blocker."));
    document.body.appendChild(script);
  });
}

const FINISH_EVENTS = new Set([
  "FINISH",
  "FINISH_ONLY_WABA",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
]);

export function WhatsAppConnect({
  connected,
  businessName,
  phoneNumber,
  status,
  lastError,
  lastCheckedAt,
}: {
  connected: boolean;
  businessName: string | null;
  phoneNumber: string | null;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);

  // Single session state using refs to avoid React async state timing issues.
  // Both the postMessage handler and FB.login callback write to this ref.
  const sessionRef = useRef<SignupSession>({
    code: null,
    wabaId: null,
    phoneNumberId: null,
    businessId: null,
    event: null,
    sessionInfoVersion: null,
  });

  // Resolver that fires when both code and wabaId are available.
  const sessionResolverRef = useRef<((session: SignupSession) => void) | null>(null);
  const sessionRejecterRef = useRef<((error: Error) => void) | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Validate origin
      try {
        const hostname = new URL(event.origin).hostname;
        if (!hostname.endsWith("facebook.com") && !hostname.endsWith("facebook.net")) return;
      } catch {
        return;
      }

      let payload: SignupMessage | null = null;
      try {
        payload = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as SignupMessage;
      } catch {
        return;
      }

      if (payload?.type !== "WA_EMBEDDED_SIGNUP") return;

      const evt = payload.event ?? "";

      // Handle CANCEL
      if (evt === "CANCEL") {
        sessionRef.current.event = "CANCEL";
        if (sessionRejecterRef.current) {
          sessionRejecterRef.current(new Error("Signup was cancelled by the user."));
          sessionResolverRef.current = null;
          sessionRejecterRef.current = null;
        }
        return;
      }

      // Handle ERROR
      if (evt === "ERROR") {
        const errDetail = (payload as Record<string, unknown>).error ?? "Unknown error";
        sessionRef.current.event = "ERROR";
        if (sessionRejecterRef.current) {
          sessionRejecterRef.current(new Error(`Meta signup error: ${String(errDetail)}`));
          sessionResolverRef.current = null;
          sessionRejecterRef.current = null;
        }
        return;
      }

      // Handle FINISH events
      if (FINISH_EVENTS.has(evt)) {
        const data = payload.data ?? {};
        sessionRef.current.wabaId = data.waba_id ?? sessionRef.current.wabaId;
        sessionRef.current.phoneNumberId = data.phone_number_id ?? sessionRef.current.phoneNumberId;
        sessionRef.current.businessId = data.business_id ?? sessionRef.current.businessId;
        sessionRef.current.event = evt;
        sessionRef.current.sessionInfoVersion = payload.session_info_version ?? sessionRef.current.sessionInfoVersion;

        // If we already have the code, resolve now
        if (sessionRef.current.code && sessionRef.current.wabaId && sessionResolverRef.current) {
          sessionResolverRef.current({ ...sessionRef.current });
          sessionResolverRef.current = null;
          sessionRejecterRef.current = null;
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function post(action: string, body: Record<string, unknown> = {}) {
    const response = await fetch("/api/integrations/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async function connect() {
    setBusy("connect");
    setMessage(null);

    // Reset session
    sessionRef.current = {
      code: null,
      wabaId: null,
      phoneNumberId: null,
      businessId: null,
      event: null,
      sessionInfoVersion: null,
    };

    try {
      const launch = (await post("initiate", { coexistence: true })) as unknown as Launch & { error?: string };
      if (launch.error) {
        setMessage({ tone: "danger", text: launch.error });
        return;
      }
      await loadSdk(launch.appId, launch.apiVersion);

      // Create a promise that resolves when both code and wabaId are available
      const sessionPromise = new Promise<SignupSession>((resolve, reject) => {
        sessionResolverRef.current = resolve;
        sessionRejecterRef.current = reject;

        // Timeout after 5 minutes
        setTimeout(() => {
          if (sessionResolverRef.current) {
            sessionResolverRef.current = null;
            sessionRejecterRef.current = null;
            reject(new Error("Signup timed out. Please try again."));
          }
        }, 5 * 60 * 1000);
      });

      window.FB?.login(
        (response) => {
          const code = response.authResponse?.code ?? null;
          if (!code) {
            if (sessionRejecterRef.current) {
              sessionRejecterRef.current(new Error("The Meta signup window was closed before completing. Nothing was saved."));
              sessionResolverRef.current = null;
              sessionRejecterRef.current = null;
            }
            return;
          }
          sessionRef.current.code = code;

          // Resolve only when both code and wabaId are available
          if (sessionRef.current.code && sessionRef.current.wabaId && sessionResolverRef.current) {
            sessionResolverRef.current({ ...sessionRef.current });
            sessionResolverRef.current = null;
            sessionRejecterRef.current = null;
          }
        },
        {
          config_id: launch.configId,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
        },
      );

      // Wait for both code and wabaId
      const session = await sessionPromise;

      if (session.event === "CANCEL") {
        setMessage({ tone: "warn", text: "The Meta signup window was closed before completing. Nothing was saved." });
        return;
      }

      if (!session.code) {
        setMessage({ tone: "warn", text: "The Meta signup window was closed before completing. Nothing was saved." });
        return;
      }

      if (!session.wabaId) {
        setMessage({ tone: "danger", text: "Meta did not return a WhatsApp Business Account ID. Please try again." });
        return;
      }

      const result = await post("complete", {
        code: session.code,
        state: launch.state,
        wabaId: session.wabaId,
        phoneNumberId: session.phoneNumberId,
        businessId: session.businessId,
        event: session.event,
        coexistence: !session.phoneNumberId,
      });

      if (result.error) {
        setMessage({ tone: "danger", text: String(result.error) });
        return;
      }
      const notes = Array.isArray(result.notes) ? (result.notes as string[]) : [];
      setMessage({
        tone: notes.length > 0 ? "warn" : "ok",
        text:
          notes.length > 0
            ? `WhatsApp linked, but: ${notes.join(" ")}`
            : "WhatsApp connected. Run \"Test connection\" to confirm the number.",
      });
      window.location.href = "/settings?wa=connected#whatsapp";
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Signup failed." });
    } finally {
      setBusy(null);
      sessionResolverRef.current = null;
      sessionRejecterRef.current = null;
    }
  }

  async function test() {
    setBusy("test");
    setMessage(null);
    try {
      const result = await post("test");
      setMessage({
        tone: result.ok ? "ok" : "warn",
        text: String(result.detail ?? (result.ok ? "Connected." : "Test failed.")),
      });
      window.location.href = "/settings?wa=tested#whatsapp";
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect WhatsApp? Incoming messages will stop until it is reconnected.")) return;
    setBusy("disconnect");
    try {
      await post("disconnect");
      window.location.href = "/settings?wa=disconnected#whatsapp";
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="grid gap-1 text-xs text-soft">
        <p>
          <span className="text-muted">Status:</span>{" "}
          <span className="text-ink">
            {connected ? "Connected and tested" : status === "NEEDS_ATTENTION" ? "Needs attention" : status === "DISCONNECTED" ? "Disconnected" : "Not connected"}
          </span>
        </p>
        <p>
          <span className="text-muted">Business:</span> {businessName ?? "—"}
        </p>
        <p>
          <span className="text-muted">Number:</span> {phoneNumber ?? "—"}
        </p>
        <p>
          <span className="text-muted">Last test:</span> {lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : "Never"}
        </p>
        {lastError ? <p className="text-warn">{lastError}</p> : null}
      </div>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={connect} disabled={busy !== null}>
          {busy === "connect" ? "Waiting for Meta…" : connected ? "Reconnect WhatsApp" : "Connect WhatsApp"}
        </Button>
        <Button size="sm" onClick={test} disabled={busy !== null || !connected}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        {connected ? (
          <Button size="sm" variant="danger" onClick={disconnect} disabled={busy !== null}>
            Disconnect
          </Button>
        ) : null}
      </div>

      <p className="text-[11px] text-muted">
        Uses Meta&apos;s official Embedded Signup. No personal WhatsApp Web session, browser automation or scraped chat history is
        used. Only events Meta delivers for the selected business number are processed.
      </p>
    </div>
  );
}
