"use client";

import { useEffect, useState } from "react";
import { Button, Notice } from "./ui";

/**
 * Meta WhatsApp Embedded Signup (JS SDK, v4) launcher.
 *
 * The browser only receives the launch configuration, the authorisation code and
 * the asset ids Meta posts back. The token exchange, WABA verification and
 * credential storage happen server-side in /api/integrations/whatsapp.
 */
type Launch = { appId: string; configId: string; apiVersion: string; state: string };

type SignupMessage = {
  type?: string;
  event?: string;
  data?: {
    phone_number_id?: string;
    waba_id?: string;
    business_id?: string;
  };
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
  const [signupData, setSignupData] = useState<SignupMessage["data"] | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!/facebook\.com$/.test(new URL(event.origin).hostname) && event.origin !== "https://www.facebook.com") return;
      let payload: SignupMessage | null = null;
      try {
        payload = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as SignupMessage;
      } catch {
        return;
      }
      if (payload?.type === "WA_EMBEDDED_SIGNUP" && payload.event === "FINISH") {
        setSignupData(payload.data ?? {});
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
    setSignupData(null);
    try {
      const launch = (await post("initiate")) as unknown as Launch & { error?: string };
      if (launch.error) {
        setMessage({ tone: "danger", text: launch.error });
        return;
      }
      await loadSdk(launch.appId, launch.apiVersion);

      const authCode = await new Promise<string | null>((resolve) => {
        window.FB?.login(
          (response) => resolve(response.authResponse?.code ?? null),
          {
            config_id: launch.configId,
            response_type: "code",
            override_default_response_type: true,
            extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
          },
        );
      });

      if (!authCode) {
        setMessage({ tone: "warn", text: "The Meta signup window was closed before completing. Nothing was saved." });
        return;
      }

      // The asset ids normally arrive in the WA_EMBEDDED_SIGNUP message event.
      let data = signupData;
      if (!data?.waba_id) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        data = signupData;
      }

      const result = await post("complete", {
        code: authCode,
        state: launch.state,
        wabaId: data?.waba_id ?? "",
        phoneNumberId: data?.phone_number_id ?? null,
        businessId: data?.business_id ?? null,
        coexistence: !data?.phone_number_id,
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
            : "WhatsApp connected. Run “Test connection” to confirm the number.",
      });
      window.location.href = "/settings?wa=connected#whatsapp";
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Signup failed." });
    } finally {
      setBusy(null);
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
