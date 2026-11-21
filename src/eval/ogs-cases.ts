/**
 * Synthetic OGS evaluation corpus. Every name, quantity and message is invented
 * for testing. No real customer, supplier, price or contact is included.
 *
 * The rules corpus is text-based; `sourceKind` records whether the synthetic
 * source is a message, Excel row or scanned PDF transcription so the harness can
 * report coverage without pretending binary OCR was exercised.
 */
export type EvalExpected = {
  rfq: boolean;
  quantity?: number;
  category?: string;
};

export type EvalCase = {
  id: string;
  sourceKind: "WHATSAPP" | "EMAIL" | "EXCEL" | "TEXT_PDF" | "SCANNED_PDF";
  text: string;
  expected: EvalExpected;
};

type RfqSpec = [category: string, quantity: number, line: string, sourceKind?: EvalCase["sourceKind"]];

const RFQ_SPECS: RfqSpec[] = [
  // Pipes (8)
  ["Pipes", 20, "20 pcs 6 inch SCH 40 SS316 seamless pipe ASTM A312 bevelled end please quote"],
  ["Pipes", 10, "10 pcs 2 inch SCH 80 carbon steel pipe ASTM A106 grade B please quote", "EXCEL"],
  ["Pipes", 6, "6 pcs 4 inch SCH 10 SS304 ERW pipe ASTM A312 plain end please quote", "TEXT_PDF"],
  ["Pipes", 12, "12 pcs 3 inch SCH 40 galvanized carbon steel pipe ASTM A53 please quote"],
  ["Pipes", 8, "8 pcs 8 inch API 5L X52 seamless pipe SCH 20 bevelled end please quote", "SCANNED_PDF"],
  ["Pipes", 25, "25 pcs 1 inch SCH 80 SS316L seamless pipe NACE MR0175 please quote"],
  ["Pipes", 4, "4 pcs 10 inch SCH 40 carbon steel pipe ASTM A106 grade B double random please quote"],
  ["Pipes", 15, "15 pcs 1.5 inch SCH 40 SS304 pipe ASTM A312 please quote"],
  // Valves (8)
  ["Valves", 4, "4 pcs 2 inch Class 150 gate valve SS316 flanged API 598 please quote"],
  ["Valves", 6, "6 pcs 1 inch Class 300 ball valve carbon steel threaded please quote", "EXCEL"],
  ["Valves", 2, "2 pcs 6 inch Class 150 butterfly valve ductile iron wafer please quote"],
  ["Valves", 3, "3 pcs 3 inch Class 600 globe valve SS316 butt weld please quote", "TEXT_PDF"],
  ["Valves", 10, "10 pcs 1/2 inch Class 150 check valve SS316 threaded please quote"],
  ["Valves", 1, "1 pcs 4 inch Class 300 gate valve API 600 handwheel please quote", "SCANNED_PDF"],
  ["Valves", 5, "5 pcs 2 inch Class 150 ball valve SS316 full port please quote"],
  ["Valves", 8, "8 pcs 3 inch Class 150 butterfly valve EPDM lever please quote"],
  // Flanges (8)
  ["Flanges", 20, "20 pcs 6 inch Class 150 weld neck flange RF ASTM A105 please quote"],
  ["Flanges", 12, "12 pcs 2 inch Class 300 slip on flange RF SS316 please quote", "EXCEL"],
  ["Flanges", 8, "8 pcs 4 inch Class 150 blind flange FF carbon steel please quote"],
  ["Flanges", 16, "16 pcs 1 inch Class 600 weld neck flange RTJ ASTM A105 please quote", "TEXT_PDF"],
  ["Flanges", 10, "10 pcs 8 inch Class 150 lap joint flange SS316 please quote"],
  ["Flanges", 6, "6 pcs 3 inch Class 300 socket weld flange RF ASTM A105 please quote", "SCANNED_PDF"],
  ["Flanges", 24, "24 pcs 1/2 inch Class 150 threaded flange SS316 please quote"],
  ["Flanges", 5, "5 pcs 12 inch Class 150 weld neck flange RF ASTM A105 please quote"],
  // Fittings (8)
  ["Fittings", 30, "30 pcs 2 inch SCH 40 SS316 elbow 90 degree butt weld please quote"],
  ["Fittings", 18, "18 pcs 3 inch SCH 40 carbon steel tee equal ASTM A234 WPB please quote", "EXCEL"],
  ["Fittings", 12, "12 pcs 4 inch SCH 80 SS304 reducer concentric please quote"],
  ["Fittings", 20, "20 pcs 1 inch SCH 40 SS316 coupling socket weld please quote", "TEXT_PDF"],
  ["Fittings", 10, "10 pcs 6 inch SCH 20 carbon steel elbow 45 degree butt weld please quote"],
  ["Fittings", 8, "8 pcs 2 inch SCH 40 SS316 cap butt weld please quote", "SCANNED_PDF"],
  ["Fittings", 14, "14 pcs 1.5 inch SCH 80 carbon steel union threaded please quote"],
  ["Fittings", 22, "22 pcs 3 inch SCH 40 SS304 tee reducing please quote"],
  // Gaskets (6)
  ["Gaskets", 40, "40 pcs 6 inch Class 150 spiral wound gasket SS316 graphite filler ASME B16.20 please quote"],
  ["Gaskets", 25, "25 pcs 2 inch Class 300 spiral wound gasket SS316 PTFE filler please quote", "EXCEL"],
  ["Gaskets", 15, "15 pcs 4 inch Class 150 sheet gasket non asbestos please quote"],
  ["Gaskets", 10, "10 pcs 8 inch Class 600 ring type joint gasket soft iron please quote", "TEXT_PDF"],
  ["Gaskets", 12, "12 pcs 1 inch Class 150 metal jacketed gasket SS316 graphite please quote"],
  ["Gaskets", 20, "20 pcs 3 inch Class 300 spiral wound gasket SS316 graphite please quote", "SCANNED_PDF"],
  // Bolting (6)
  ["Industrial Fasteners", 100, "100 pcs M10 x 100 mm ASTM A193 B7 stud bolt with A194 2H nuts zinc plated please quote"],
  ["Industrial Fasteners", 50, "50 pcs M12 x 80 mm ASTM A193 B7M stud bolt with A194 2HM nuts PTFE coated please quote", "EXCEL"],
  ["Industrial Fasteners", 200, "200 pcs M8 x 50 mm hex bolt stainless steel A2-70 please quote"],
  ["Industrial Fasteners", 80, "80 pcs M16 x 120 mm ASTM A193 B8M stud bolt with A194 8M nuts please quote", "TEXT_PDF"],
  ["Industrial Fasteners", 60, "60 pcs 3/8-16 UNC x 1 1/2 inch hex bolt A4-80 please quote"],
  ["Industrial Fasteners", 30, "30 pcs M20 x 150 mm U-bolt ASTM A193 B7 zinc plated please quote", "SCANNED_PDF"],
  // Chemicals (5)
  ["Chemicals", 1000, "1000 kg caustic soda flakes technical grade 99% in 25 kg bag please quote"],
  ["Chemicals", 20, "20 drums hydrochloric acid 33% industrial grade please quote", "EXCEL"],
  ["Chemicals", 500, "500 kg citric acid monohydrate food grade 99.5% in 25 kg bag please quote"],
  ["Chemicals", 10, "10 drums sodium hypochlorite 12% solution please quote", "TEXT_PDF"],
  ["Chemicals", 200, "200 kg calcium chloride flakes 94% industrial grade please quote"],
  // Spares (4)
  ["Industrial Spares", 4, "4 pcs mechanical seal part number MS-220 for pump model P-101 please quote"],
  ["Industrial Spares", 10, "10 pcs bearing part number 6205-2RS SKF please quote", "EXCEL"],
  ["Industrial Spares", 2, "2 pcs impeller part number IMP-44 for pump KSB Etanorm please quote"],
  ["Industrial Spares", 6, "6 pcs seal kit model SK-90 for valve actuator please quote"],
  // Services (3)
  ["Services", 2, "2 pcs machining of flange face to RTJ profile please quote", "TEXT_PDF"],
  ["Services", 5, "5 pcs hydrotest of valves to API 598 please quote"],
  ["Services", 3, "3 pcs PMI positive material identification on SS316 welds please quote", "SCANNED_PDF"],
];

const NON_RFQ: Array<[string, EvalCase["sourceKind"], string]> = [
  ["PERSONAL", "WHATSAPP", "Happy birthday bro see you at dinner"],
  ["BUSINESS_OTHER", "EMAIL", "Please send the invoice for last month"],
  ["FOLLOW_UP", "EMAIL", "Thanks for the delivery yesterday"],
  ["SUPPLIER", "EMAIL", "We can supply SS316 valves ex-stock from our Dubai warehouse"],
];

export const OGS_EVAL_CASES: EvalCase[] = [
  ...RFQ_SPECS.map(([category, quantity, text, sourceKind], index) => ({
    id: `ogs-rfq-${String(index + 1).padStart(3, "0")}`,
    sourceKind: sourceKind ?? (index % 3 === 0 ? "WHATSAPP" : "EMAIL"),
    text,
    expected: { rfq: true, quantity, category },
  })),
  ...NON_RFQ.map(([classification, sourceKind, text], index) => ({
    id: `ogs-nonrfq-${String(index + 1).padStart(3, "0")}`,
    sourceKind,
    text,
    expected: { rfq: false, classification } as EvalExpected & { classification: string },
  })),
];

export const OGS_EXPECTED_RFQ_COUNT = RFQ_SPECS.length;
