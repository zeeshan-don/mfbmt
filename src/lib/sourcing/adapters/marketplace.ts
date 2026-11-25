import type { AdapterResult, SearchAdapter } from "../types";

/**
 * B2B marketplace adapter.
 *
 * Marketplaces do not expose unrestricted price APIs. This adapter is a real
 * implementation seam: when a marketplace grants API access, implement search()
 * against their documented endpoints and register credentials in Settings.
 * Until then it reports NOT_CONFIGURED instead of pretending to search.
 */
export const marketplaceAdapter: SearchAdapter = {
  key: "B2B_MARKETPLACE",
  label: "B2B marketplace",
  available: () => false,
  unavailableReason: () =>
    "No B2B marketplace API is connected. An approved marketplace developer account, its API base URL and an API key are required; marketplace scraping is not used, so this source stays off until those credentials are supplied.",
  async search(queries): Promise<AdapterResult> {
    return {
      adapter: marketplaceAdapter.key,
      label: marketplaceAdapter.label,
      status: "NOT_CONFIGURED",
      note: marketplaceAdapter.unavailableReason?.(),
      queries: queries.map((query) => ({ query, status: "NOT_CONFIGURED" as const, resultCount: 0 })),
      candidates: [],
    };
  },
};
