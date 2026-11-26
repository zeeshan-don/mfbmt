import { describe, expect, it } from "vitest";
import { compareAcceptanceToQuotation, type QuotationSnapshot } from "../src/lib/orders/salesOrder";

const base: QuotationSnapshot = {
  id: "quotation-1",
  quoteNumber: "QT-1",
  version: 1,
  currency: "AED",
  status: "SENT",
  subtotal: 1000,
  taxAmount: 0,
  total: 1000,
  terms: "This quotation is valid for 14 days. Availability and taxes are subject to confirmation. Payment terms to be agreed separately.",
  paymentTerms: null,
  deliveryTerms: null,
  deliveryAddress: null,
  validityDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  customerName: "Customer",
  items: [
    {
      id: "item-1",
      description: "Gate valve",
      specs: null,
      quantity: 1,
      unit: "pcs",
      unitPrice: 1000,
      lineTotal: 1000,
      stockQuantity: 0,
      procureQuantity: 1,
      supplierOfferId: null,
      enquiryItemId: null,
    },
  ],
};

describe("structured quotation terms", () => {
  it("never compares a customer payment term against generic boilerplate", () => {
    const result = compareAcceptanceToQuotation(base, { quotationId: base.id, paymentTerms: "30 days" });
    expect(result.discrepancies.map((entry) => entry.code)).toContain("NOT_COMPARABLE");
    expect(result.discrepancies.map((entry) => entry.code)).not.toContain("PAYMENT_TERMS");
    expect(result.discrepancies.find((entry) => entry.code === "NOT_COMPARABLE")?.message).toMatch(/did not record structured payment terms/i);
  });

  it("accepts a matching structured payment term", () => {
    const result = compareAcceptanceToQuotation({ ...base, paymentTerms: "30 days from invoice" }, { quotationId: base.id, paymentTerms: "30 days from invoice" });
    expect(result.discrepancies.map((entry) => entry.code)).not.toContain("PAYMENT_TERMS");
    expect(result.discrepancies.map((entry) => entry.code)).not.toContain("NOT_COMPARABLE");
  });

  it("flags a real payment-term change against the structured value", () => {
    const result = compareAcceptanceToQuotation({ ...base, paymentTerms: "30 days" }, { quotationId: base.id, paymentTerms: "60 days" });
    const discrepancy = result.discrepancies.find((entry) => entry.code === "PAYMENT_TERMS");
    expect(discrepancy?.quoted).toBe("30 days");
    expect(discrepancy?.requested).toBe("60 days");
  });

  it("keeps a delivery place separate from an Incoterm", () => {
    const result = compareAcceptanceToQuotation(
      { ...base, deliveryTerms: "DAP", deliveryAddress: "Jebel Ali, Dubai" },
      { quotationId: base.id, deliveryTerms: "DAP", deliveryAddress: "Jebel Ali, Dubai" },
    );
    expect(result.discrepancies.map((entry) => entry.code)).not.toContain("DELIVERY_TERMS");
  });

  it("marks legacy delivery terms as not comparable instead of falsely different", () => {
    const result = compareAcceptanceToQuotation(base, { quotationId: base.id, deliveryTerms: "CIF Jebel Ali" });
    expect(result.discrepancies.map((entry) => entry.code)).toContain("NOT_COMPARABLE");
    expect(result.discrepancies.map((entry) => entry.code)).not.toContain("DELIVERY_TERMS");
  });

  it("flags an actual structured delivery-term change", () => {
    const result = compareAcceptanceToQuotation({ ...base, deliveryTerms: "DAP" }, { quotationId: base.id, deliveryTerms: "CIF" });
    const discrepancy = result.discrepancies.find((entry) => entry.code === "DELIVERY_TERMS");
    expect(discrepancy?.field).toBe("deliveryTerms");
    expect(discrepancy?.quoted).toBe("DAP");
  });
});
