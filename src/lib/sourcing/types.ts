/** Contract shared by every supplier discovery adapter. */

export type AdapterStatus = "OK" | "FAILED" | "SKIPPED" | "RATE_LIMITED" | "NOT_CONFIGURED";

export type QueryRun = {
  query: string;
  status: AdapterStatus;
  resultCount: number;
  error?: string;
};

export type SourcingCandidate = {
  adapter: string;
  sourceUrl?: string | null;
  supplierId?: string | null;
  supplierName: string;
  title: string;
  snippet?: string | null;
  priceText?: string | null;
  unitPrice?: number | null;
  currency?: string | null;
  moq?: number | null;
  availability?: string | null;
  leadTimeDays?: number | null;
  evidence?: Record<string, unknown>;
  retrievedAt: Date;
  isDemo?: boolean;
};

export type AdapterResult = {
  adapter: string;
  label: string;
  status: AdapterStatus;
  note?: string;
  queries: QueryRun[];
  candidates: SourcingCandidate[];
};

export type AdapterContext = {
  /** Normalized requested specification, used to reject bad candidates. */
  request: {
    description: string;
    quantity: number;
    unit: string;
    category?: string | null;
    material?: string | null;
    size?: string | null;
    grade?: string | null;
    pressureRating?: string | null;
    schedule?: string | null;
    standard?: string | null;
    brand?: string | null;
  };
  /** True when a public page may be fetched for evidence. */
  fetchPages: boolean;
};

export interface SearchAdapter {
  key: string;
  label: string;
  /** Whether the adapter has what it needs to run (credentials, etc). */
  available(): boolean;
  unavailableReason?(): string;
  search(queries: string[], context: AdapterContext): Promise<AdapterResult>;
}

export type CoverageEntry = {
  adapter: string;
  label: string;
  status: AdapterStatus;
  queries: number;
  results: number;
  note?: string;
};
