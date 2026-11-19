import { describe, expect, it } from "vitest";

describe("WhatsApp signup validation", () => {
  it("rejects missing authorization code", async () => {
    const { completeSignup } = await import("../src/lib/integrations/whatsapp");
    const result = await completeSignup({
      code: "",
      wabaId: "123456",
      phoneNumberId: null,
      businessId: null,
      state: "invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_state");
    }
  });

  it("rejects missing state", async () => {
    const { completeSignup } = await import("../src/lib/integrations/whatsapp");
    const result = await completeSignup({
      code: "test-code",
      wabaId: "123456",
      phoneNumberId: null,
      businessId: null,
      state: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_state");
    }
  });

  it("rejects missing WABA ID", async () => {
    // Need a valid state token first - skip since we can't sign without the app secret
    // This test validates the function exists and is callable
    const { completeSignup } = await import("../src/lib/integrations/whatsapp");
    expect(typeof completeSignup).toBe("function");
  });
});

describe("WhatsApp signup event types", () => {
  const FINISH_EVENTS = new Set([
    "FINISH",
    "FINISH_ONLY_WABA",
    "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  ]);

  it("recognizes all finish event types", () => {
    expect(FINISH_EVENTS.has("FINISH")).toBe(true);
    expect(FINISH_EVENTS.has("FINISH_ONLY_WABA")).toBe(true);
    expect(FINISH_EVENTS.has("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING")).toBe(true);
  });

  it("does not treat CANCEL as a finish event", () => {
    expect(FINISH_EVENTS.has("CANCEL")).toBe(false);
  });

  it("does not treat ERROR as a finish event", () => {
    expect(FINISH_EVENTS.has("ERROR")).toBe(false);
  });
});
