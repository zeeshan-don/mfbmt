import { describe, expect, it } from "vitest";
import { extractEnquiry, type SourceDocument } from "../src/lib/ai/extract";
import {
  extractCustomerContext,
  hasProductEvidence,
  isClearlyNonProductText,
  stripInternalWording,
} from "../src/lib/ai/segmentation";

const GREETING = "Hi, I need these items urgently in 3 days.";

function productPdf(): SourceDocument {
  return {
    filename: "customer-list.pdf",
    kind: "pdf",
    text: "[page 1]\nLong radius elbow, carbon steel, ASTM A234 WPB, 0.5in, 90 pcs",
    pages: [
      {
        page: 1,
        text: "Long radius elbow, carbon steel, ASTM A234 WPB, 0.5in, 90 pcs",
        ocr: false,
      },
    ],
  };
}

describe("semantic segmentation guardrails", () => {
  it("never treats a greeting or delivery instruction as a product", () => {
    expect(isClearlyNonProductText("Hi")).toBe(true);
    expect(isClearlyNonProductText("Hi, I need these items urgently in 3 days.")).toBe(true);
    expect(isClearlyNonProductText("Please process this urgently.")).toBe(true);
    expect(isClearlyNonProductText("Need delivery within 3 days.")).toBe(true);
    expect(isClearlyNonProductText("Dear supplier, please confirm availability.")).toBe(true);
    expect(isClearlyNonProductText("Best regards,")).toBe(true);
    expect(isClearlyNonProductText("0.5in - MS")).toBe(true);
    expect(isClearlyNonProductText("ASTM A105 Class 150")).toBe(true);
  });

  it("recognises a real product request and its specifications", () => {
    expect(hasProductEvidence("Please quote 90 pieces of ASTM A105 flanges.")).toBe(true);
    expect(hasProductEvidence("Long-radius elbow, carbon steel, ASTM A234 WPB")).toBe(true);
    expect(hasProductEvidence("2 pcs gate valve SS316 Class 150")).toBe(true);
  });

  it("captures urgency, delivery timeframe and instructions separately from products", () => {
    const context = extractCustomerContext({
      body:
        "Hi team,\nPlease process this urgently.\nWe need delivery within 3 days.\n" +
        "Please quote 90 pcs long radius elbow ASTM A234 WPB.\nBest regards,\nAli",
    });
    expect(context.greeting).toMatch(/Hi team/i);
    expect(context.urgency).toMatch(/urgent/i);
    expect(context.requestedDeliveryTimeframe).toMatch(/3 days/i);
    expect(context.instructions.join(" ")).toMatch(/process this urgently/i);
    expect(context.instructions.join(" ")).not.toMatch(/elbow/i);
  });

  it("removes internal catalogue wording from supplier-facing text", () => {
    const cleaned = stripInternalWording(
      "Elbow carbon steel — catalogue-derived product line — Confirm exact item — Catalogue Details row 27 https://ogs.example/catalogue/12",
    );
    expect(cleaned).toMatch(/elbow/i);
    expect(cleaned).not.toMatch(/catalogue-derived/i);
    expect(cleaned).not.toMatch(/confirm exact item/i);
    expect(cleaned).not.toMatch(/row 27/i);
    expect(cleaned).not.toMatch(/https?:\/\//i);
  });
});

describe("enquiry extraction with greetings and attachments", () => {
  it("extracts the PDF product, not the email greeting", async () => {
    const result = await extractEnquiry(
      { text: GREETING, subject: "Urgent RFQ", documents: [productPdf()] },
      { allowAi: false },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/long radius elbow/i);
    expect(result.items[0].description).not.toMatch(/^hi\b/i);
    expect(result.items[0].quantity).toBe(90);
    expect(result.items[0].sourceRef).toMatch(/customer-list\.pdf page 1/i);
    expect(result.extraction.customerContext?.urgency).toMatch(/urgent/i);
    expect(result.extraction.customerContext?.requestedDeliveryTimeframe).toMatch(/3 days/i);
  });

  it("extracts products from a pasted body table and ignores the greeting", async () => {
    const result = await extractEnquiry(
      {
        text:
          "Hi team,\nPlease quote the following:\n" +
          "1. 90 pcs Long radius elbow ASTM A234 WPB\n" +
          "2. 40 pcs Gate valve 2 inch SS316 Class 150",
        documents: [],
      },
      { allowAi: false },
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.description).join(" | ")).not.toMatch(/hi team/i);
    expect(result.items.map((item) => item.quantity)).toEqual([90, 40]);
  });

  it("reads a product stated only in the subject", async () => {
    const result = await extractEnquiry(
      {
        subject: "Urgent RFQ: 90 pcs long radius elbow ASTM A234 WPB",
        text: "Hi, please process this quickly.",
        documents: [],
      },
      { allowAi: false },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/long radius elbow/i);
    expect(result.items[0].sourceRef).toBe("Email subject");
  });

  it("keeps the body product when an attachment is present", async () => {
    const result = await extractEnquiry(
      {
        text: "Hi,\nPlease quote 10 pcs gate valve 2 inch SS316 Class 150.\nSee the attached list for the other item.",
        documents: [productPdf()],
      },
      { allowAi: false },
    );

    const descriptions = result.items.map((item) => item.description.toLowerCase());
    expect(descriptions.some((entry) => entry.includes("gate valve"))).toBe(true);
    expect(descriptions.some((entry) => entry.includes("long radius elbow"))).toBe(true);
  });

  it("returns no product at all for an urgency-only message instead of inventing one", async () => {
    const result = await extractEnquiry(
      { text: "Hi, I need these items urgently in 3 days. Please process.", documents: [] },
      { allowAi: false },
    );

    expect(result.items).toHaveLength(0);
    expect(result.extraction.customerContext?.urgency).toMatch(/urgent/i);
    expect(result.extraction.customerContext?.requestedDeliveryTimeframe).toMatch(/3 days/i);
    expect(result.extraction.notes).toMatch(/needs review|no product/i);
  });

  it("does not create a product from a loose specification fragment", async () => {
    const result = await extractEnquiry(
      {
        text: "Please find details below.\n0.5in - MS\nASTM A105 Class 150\nThanks",
        documents: [],
      },
      { allowAi: false },
    );
    expect(result.items).toHaveLength(0);
  });
});

describe("multi-source provenance and duplicate handling", () => {
  it("reads multiple spreadsheet worksheets with sheet/row provenance", async () => {
    const result = await extractEnquiry(
      {
        text: "Dear team, please quote these.",
        documents: [
          {
            filename: "request.xlsx",
            kind: "excel",
            text:
              "Sheet: Valves\n40 pcs Gate valve 2 inch SS316 Class 150 [Valves row 4]\n\n" +
              "Sheet: Fittings\n90 pcs Long radius elbow ASTM A234 WPB [Fittings row 7]",
          },
        ],
      },
      { allowAi: false },
    );

    expect(result.items).toHaveLength(2);
    const refs = result.items.map((item) => item.sourceRef);
    expect(refs.some((ref) => /request\.xlsx.*Valves row 4/i.test(ref ?? ""))).toBe(true);
    expect(refs.some((ref) => /request\.xlsx.*Fittings row 7/i.test(ref ?? ""))).toBe(true);
  });

  it("does not duplicate a product list present in both body and attachment", async () => {
    const body =
      "Hi,\nLong radius elbow, carbon steel, ASTM A234 WPB, 0.5in, 90 pcs\nPlease quote.";
    const document: SourceDocument = {
      filename: "list.pdf",
      kind: "pdf",
      text: "[page 1]\nLong radius elbow, carbon steel, ASTM A234 WPB, 0.5in, 90 pcs",
      pages: [{ page: 1, text: "Long radius elbow, carbon steel, ASTM A234 WPB, 0.5in, 90 pcs" }],
    };

    const result = await extractEnquiry({ text: body, documents: [document] }, { allowAi: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps separate legitimate quantities and rows", async () => {
    const result = await extractEnquiry(
      {
        text: "50 pcs Gate valve 2 inch SS316\n80 pcs Gate valve 2 inch SS316",
        documents: [],
      },
      { allowAi: false },
    );
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.quantity).sort()).toEqual([50, 80]);
  });

  it("ignores OCR headers and footers around a genuine product", async () => {
    const result = await extractEnquiry(
      {
        text: "Please read the attached scan.",
        documents: [
          {
            filename: "scan.pdf",
            kind: "pdf",
            text:
              "[page 1]\n*** SCANNED BY ACME OCR ***\nPage 1 of 3\n" +
              "Long radius elbow, carbon steel, ASTM A234 WPB, 90 pcs\nConfidential footer",
            pages: [
              {
                page: 1,
                text:
                  "*** SCANNED BY ACME OCR ***\nPage 1 of 3\nLong radius elbow, carbon steel, ASTM A234 WPB, 90 pcs\nConfidential footer",
                ocr: true,
              },
            ],
          },
        ],
      },
      { allowAi: false },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/long radius elbow/i);
    expect(result.items[0].sourceRef).toMatch(/scan\.pdf page 1/i);
  });

  it("handles mixed Arabic and English content without turning the greeting into a product", async () => {
    const result = await extractEnquiry(
      {
        text: "مرحبا،\n20 pcs gate valve 2 inch SS316 Class 150\nشكرا",
        documents: [],
      },
      { allowAi: false },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toMatch(/gate valve/i);
    expect(result.items[0].quantity).toBe(20);
  });
});
