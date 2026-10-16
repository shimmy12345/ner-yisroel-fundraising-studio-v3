// Ask Fundraising OS -- the two SQL statements that decide WHICH donor a
// conversational or search-based reference is allowed to resolve to
// (independent review, "Final Production Safety Review for Ask AI",
// 2026-10-16). Pulled out of lib/assistant/conversation.ts and
// lib/assistant/capabilities.ts into their own pure module (no
// `cloudflare:workers` import) for the same reason
// lib/assistant/fundraising-progress.ts's own SQL constants are: so a
// Node test can execute these EXACT, literal queries against a real
// synthetic multi-user SQLite database and prove isolation directly,
// rather than only asserting that the source text happens to contain the
// string "owner_user_id".
//
// Both statements are the ENTIRE authorization boundary for every donor
// the assistant can ever resolve a name, an ordinal ("the second one"),
// or a search against -- there is no other path. Both require
// owner_user_id to equal the authenticated request's own userId; neither
// ever trusts a donor id supplied by the client (conversation state) or
// produced by the model without re-checking it against this exact
// ownership condition first.

// Used by lib/assistant/conversation.ts's resolveDonorReference for an
// ORDINAL reference ("the second one"): the client's own conversation
// state names a donorId from an earlier turn, but that id is ALWAYS
// re-verified against the CURRENT request's userId here before being
// trusted -- conversation state can point at a donor, but it can never
// grant access to one this request's authenticated user doesn't own.
// data_source='live' and archived_at IS NULL exclude archived/merged
// donors from ever being resolved this way, matching every other
// donor-lookup in this feature.
export const DONOR_OWNERSHIP_CHECK_SQL = "SELECT id, display_name FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL";

// Used by lib/assistant/capabilities.ts's searchDonors for a NAME
// reference, and by resolveDonorReference's own "name" branch to turn a
// fundraiser-typed or model-reported name into a real, owned donor --
// the model never produces or guesses an id itself, only a name string,
// which is matched against ONLY this user's own donors.
export const DONOR_SEARCH_SQL = "SELECT id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND display_name LIKE ? ORDER BY display_name LIMIT ?";
