import { describe, expect, it } from "vitest";
import { correlateSupplierReply, extractSupplierQuoteTerms } from "../src/lib/workflow/supplierReply";

const baseCandidate = {
  quoteId: "quote-1",
  supplierId: "supplier-1",
  supplierEmail: "sales@valves.example",
  sentTo: "sales@valves.example",
  status: "SENT",
  correlationToken: "A1B2C3D4",
  subject: "Quotation request ENQ-2026-0001 — OGS [RFQ-A1B2C3D4]",
  publicRef: "ENQ-2026-0001",
  sentAt: Date.now() - 60_000,
  providerThreadId: "thread-abc",
  providerMessageId: "message-abc",
};

describe("supplier reply correlation", () => {
  it("matches an exact provider thread", () => {
    const result = correlateSupplierReply(
      {
        fromAddress: "sales@valves.example",
        subject: "Re: Quotation request",
        providerThreadId: "thread-abc",
      },
      [baseCandidate],
    );
    expect(result.status).toBe("MATCHED");
    expect(result.quoteId).toBe("quote-1");
    expect(result.method).toBe("provider_thread");
  });

  it("matches In-Reply-To against the stored provider message id", () => {
    const result = correlateSupplierReply(
      {
        fromAddress: "sales@valves.example",
        subject: "Re: RFQ",
        inReplyTo: "<message-abc@example>",
      },
      [baseCandidate],
    );
    expect(result.status).toBe("MATCHED");
    expect(result.method).toBe("message_id_header");
  });

  it("matches the opaque RFQ token embedded in the subject", () => {
    const result = correlateSupplierReply(
      {
        fromAddress: "sales@valves.example",
        subject: "Quote [RFQ-A1B2C3D4]",
      },
      [baseCandidate],
    );
    expect(result.status).toBe("MATCHED");
    expect(result.quoteId).toBe("quote-1");
    expect(result.method).toBe("rfq_token");
  });

  it("does not auto-attach on sender identity alone", () => {
    const result = correlateSupplierReply(
      {
        fromAddress: "sales@valves.example",
        subject: "Re: Quotation request ENQ-2026-0001",
      },
      [baseCandidate],
    );
    // The enquiry reference (weaker than a token) still needs review.
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.quoteId).toBeNull();
    expect(result.possible.map((entry) => entry.quoteId)).toContain("quote-1");
  });

  it("does not auto-attach an email from another sender that merely quotes the enquiry reference", () => {
    const result = correlateSupplierReply(
      { fromAddress: "other@elsewhere.example", subject: "Quotation request ENQ-2026-0001" },
      [baseCandidate],
    );
    // A stored reference is contextual evidence, not proof: the owner decides.
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.quoteId).toBeNull();
    expect(result.possible).toHaveLength(1);
  });

  it("marks multiple weak matches for owner review instead of guessing", () => {
    const second = { ...baseCandidate, quoteId: "quote-2", correlationToken: "ZZZZ9999", providerThreadId: null, providerMessageId: null };
    const result = correlateSupplierReply(
      { fromAddress: "sales@valves.example", subject: "Re: ENQ-2026-0001" },
      [{ ...baseCandidate, providerThreadId: null, providerMessageId: null }, second],
    );
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.possible.length).toBeGreaterThan(1);
  });
});

describe("supplier quote term extraction", () => {
  it("extracts stated commercial terms without inventing missing charges", () => {
    const terms = extractSupplierQuoteTerms(
      "Dear Procurement,\nUnit price: AED 12.50/pc\nMOQ: 100 pcs\nLead time: 7 days\nPayment terms: 30 days\nValidity: 14 days\nRegards",
      "Re: RFQ",
    );
    expect(terms.unitPrice).toBe(12.5);
    expect(terms.currency).toBe("AED");
    expect(terms.moq).toBe(100);
    expect(terms.leadTimeDays).toBe(7);
    expect(terms.paymentTerms).toBe("30 days");
    expect(terms.validityDays).toBe(14);
    // Unknown values stay null: never treated as zero.
    expect(terms.shippingCost).toBeNull();
    expect(terms.taxes).toBeNull();
    expect(terms.otherCharges).toBeNull();
    expect(terms.missingCommercial).toEqual(expect.arrayContaining(["Shipping cost", "Taxes"]));
  });

  it("does not promote a document total to a unit price", () => {
    const terms = extractSupplierQuoteTerms("Total: AED 1,500.00\nThank you", "Quotation");
    expect(terms.unitPrice).toBeNull();
    expect(terms.missingCommercial).toContain("Unit price");
  });

  it("keeps a VAT percentage as an unknown amount", () => {
    const terms = extractSupplierQuoteTerms("Price AED 20 per pc\nVAT 5% extra\nFreight: AED 50", "Quote");
    expect(terms.unitPrice).toBe(20);
    expect(terms.taxes).toBeNull();
    expect(terms.shippingCost).toBe(50);
    expect(terms.missingCommercial.join(" ")).toMatch(/percentage/i);
  });

  it("recognises delivery, origin and certification evidence", () => {
    const terms = extractSupplierQuoteTerms(
      "CIF Dubai\nCountry of origin: India\nEN 10204 3.1 mill certificate supplied\nPrice: USD 4.5/pc",
      "Offer",
    );
    expect(terms.deliveryTerms).toBe("CIF");
    expect(terms.countryOfOrigin).toMatch(/India/i);
    expect(terms.certifications).toContain("EN 10204 3.1");
    expect(terms.currency).toBe("USD");
    expect(terms.unitPrice).toBe(4.5);
  });
});
