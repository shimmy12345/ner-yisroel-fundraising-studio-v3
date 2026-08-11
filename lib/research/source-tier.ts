import type { SourceTier } from "./types.ts";

// Centralized, structural LinkedIn safety boundary. Any code path that
// might ever perform a direct URL fetch (there are none in Stage A --
// ManualSearchProvider does no I/O at all) MUST call assertFetchAllowed()
// first. A public LinkedIn URL may still be stored and displayed as Tier 5
// evidence -- what's forbidden is Fundraising OS ever requesting the page
// itself, which would mean scraping LinkedIn or touching its anti-bot
// measures. Matches the exact domain and any subdomain of it.
export const NEVER_FETCH_DOMAINS = ["linkedin.com", "www.linkedin.com"];

export function isNeverFetchDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return NEVER_FETCH_DOMAINS.some((blocked) => lower === blocked || lower.endsWith(`.${blocked}`));
}

export function assertFetchAllowed(url: string): void {
  const domain = new URL(url).hostname.toLowerCase();
  if (isNeverFetchDomain(domain)) throw new Error(`Refusing to fetch a NEVER_FETCH_DOMAINS host: ${domain}`);
}

// A light, deliberately narrow suggestion only -- social/profile-directory
// platforms (LinkedIn foremost) are the one class of domain confidently
// classifiable as Tier 5 from the hostname alone. Everything else (is this
// domain a nonprofit's own site? a wire service? a newsroom?) is for the
// fundraiser entering the evidence to say, not a heuristic to guess --
// guessing wrongly here would misrepresent how strong a claim's evidence
// actually is.
const SOCIAL_OR_DIRECTORY_DOMAINS = ["linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com"];

export function suggestSourceTier(domain: string): SourceTier | undefined {
  const lower = domain.toLowerCase();
  if (SOCIAL_OR_DIRECTORY_DOMAINS.some((known) => lower === known || lower.endsWith(`.${known}`))) return "public_search_result";
  return undefined;
}
