import { describe, expect, it } from "vitest";
import { extractPublicContacts, normalizeDomain } from "../src/lib/sourcing/contacts";
import { rankSuppliersForRequest } from "../src/lib/suppliers/ranking";

describe("supplier contact extraction", () => {
  it("extracts only visible business contacts from public text", () => {
    const contacts = extractPublicContacts(
      "Sales: SALES@Gulf-Valves.example. Phone +971 4 555 0101. Abuse: no-reply@sentry.example",
      "https://www.gulf-valves.example/about",
      ["/contact", "/products", "https://www.gulf-valves.example/rfq"],
    );
    expect(contacts.emails).toEqual(["sales@gulf-valves.example"]);
    expect(contacts.phones[0]).toContain("+971");
    expect(contacts.contactLinks).toContain("https://www.gulf-valves.example/contact");
    expect(contacts.sourceUrl).toContain("gulf-valves.example");
    expect(contacts.retrievedAt).toBeInstanceOf(Date);
  });

  it("normalizes a domain and rejects a bare word", () => {
    expect(normalizeDomain("https://www.Example-Supplier.com/contact")).toBe("example-supplier.com");
    expect(normalizeDomain("example-supplier.com")).toBe("example-supplier.com");
    expect(normalizeDomain("not-a-domain")).toBeNull();
  });
});

describe("supplier ranking", () => {
  const base = {
    id: "1",
    name: "A",
    status: "ACTIVE",
    doNotContact: false,
    categories: JSON.stringify(["Valves"]),
    country: "UAE",
    bouncedAt: null,
  };

  it("prefers a category match with recorded replies over an unknown supplier", () => {
    const result = rankSuppliersForRequest(
      [
        { ...base, id: "unknown", name: "Unknown", categories: "[]", status: "UNVERIFIED" },
        { ...base, id: "known", name: "Known", responseRate: 80, verifiedPrices: 3 },
      ],
      "valves",
      "UAE",
    );
    expect(result[0].supplier.id).toBe("known");
    expect(result[0].reasons.join(" ")).toMatch(/reply rate/i);
  });

  it("never ranks a blocked supplier as usable", () => {
    const result = rankSuppliersForRequest(
      [
        { ...base, id: "blocked", name: "Blocked", doNotContact: true },
        { ...base, id: "open", name: "Open" },
      ],
      "valves",
    );
    expect(result[result.length - 1].supplier.id).toBe("blocked");
    expect(result[result.length - 1].score).toBeLessThan(0);
  });
});
