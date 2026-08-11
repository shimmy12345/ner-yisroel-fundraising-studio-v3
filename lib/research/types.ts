// Provider-agnostic Donor Research types. Nothing here assumes a specific
// vendor's response shape -- SearchResultItem is the lowest common
// denominator any future search backend could supply (see
// manual-provider.ts, the only implementation Stage A ships with).

export type ResearchQueryHint = "person" | "organization" | "news" | "philanthropy_event" | "general";

export type SearchQuery = {
  text: string;
  hint?: ResearchQueryHint;
  dateFrom?: string;
  dateTo?: string;
};

export type SearchResultItem = {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  domain: string;
};

export interface ResearchSearchProvider {
  readonly name: string;
  search(query: SearchQuery): Promise<SearchResultItem[]>;
}

export type FindingCategory = "professional" | "boards_affiliations" | "public_philanthropy" | "recent_mentions" | "possible_connections" | "notes_ambiguities";
export type FindingStatus = "current" | "superseded" | "removed_not_found" | "unverified";
export type SourceTier = "primary_institutional" | "press_release" | "reputable_news" | "event_program" | "public_search_result";
export type RunStatus = "open" | "completed" | "discarded";
export type IdentityCandidateStatus = "pending" | "confirmed" | "rejected";

export const FINDING_CATEGORIES: FindingCategory[] = ["professional", "boards_affiliations", "public_philanthropy", "recent_mentions", "possible_connections", "notes_ambiguities"];
export const SOURCE_TIERS: SourceTier[] = ["primary_institutional", "press_release", "reputable_news", "event_program", "public_search_result"];

// Professional and Boards & Affiliations claims cannot become Confirmed
// ("current") on Tier 5 evidence alone -- they're downgraded to
// "unverified" instead. See lib/research/pipeline.ts.
export const TIER_REQUIRES_CORROBORATION: FindingCategory[] = ["professional", "boards_affiliations"];
export const WEAKEST_UNCORROBORATED_TIER: SourceTier = "public_search_result";
