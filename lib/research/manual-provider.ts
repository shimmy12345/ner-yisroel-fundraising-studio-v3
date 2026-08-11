import type { ResearchSearchProvider, SearchQuery, SearchResultItem } from "./types.ts";

// The Stage A provider: zero network I/O, zero API keys. Wraps whatever
// SearchResultItem[] a fundraiser (or a test fixture) already supplied --
// it never fetches, crawls, or queries anything itself. Fundraiser-entered
// evidence (URL, title, snippet, published date) reaches
// donor_research_pending_evidence directly through the API route in the
// real product flow; this class exists so that path, and any future live
// provider, share the exact same downstream pipeline and can be tested
// against the same interface with fictional fixture data.
export class ManualSearchProvider implements ResearchSearchProvider {
  readonly name = "manual";
  private readonly results: SearchResultItem[];

  constructor(results: SearchResultItem[] = []) {
    this.results = results;
  }

  async search(_query: SearchQuery): Promise<SearchResultItem[]> {
    return this.results;
  }
}
