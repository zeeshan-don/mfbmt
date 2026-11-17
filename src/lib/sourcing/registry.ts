import type { SearchAdapter } from "./types";
import { internalSupplierAdapter } from "./adapters/internal";
import { webSearchAdapter } from "./adapters/web";
import { marketplaceAdapter } from "./adapters/marketplace";

/** Register new discovery sources here only — the engine never hardcodes them. */
export function getSearchAdapters(): SearchAdapter[] {
  return [internalSupplierAdapter, webSearchAdapter, marketplaceAdapter];
}
