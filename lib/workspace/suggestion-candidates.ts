// Bounds which donors enter the homepage/Today per-donor evidence+scoring
// pipeline (lib/workspace/live-data.ts), so a large donor roster doesn't
// mean running the full recommendation engine on nearly everyone only to
// discard almost all of it. Pure -- no D1 access -- so it can be unit
// tested directly against synthetic fixtures at real and larger-than-real
// scale (see tests/suggestion-candidates.test.mjs).
//
// Every category except "no recent contact" is kept in full, unbounded:
// a real paid gift, a real open pledge, and a yahrtzeit/birthday/
// anniversary actually inside its own lead window are all driven by real,
// rare events -- their count scales with donor *activity*, not with total
// donor count. Only the contact-gap bucket scales with the size of the
// donor base itself (at real scale, most of the roster has no recent
// contact), so it's the only one that needs bounding.
//
// Open reminders are deliberately NOT part of this selection at all --
// lib/workspace/live-data.ts's separate, unconditional reminder loop
// already turns every open reminder into a homepage card directly,
// without going through per-donor evidence-building. That mechanism is
// untouched by this module.

import { nextYahrtzeitOccurrence, type HebrewMonthName } from "../calendar/hebrew-date.ts";
import { nextGregorianRecurrence } from "../calendar/gregorian-recurring-date.ts";
import { RELATIONSHIP_DATE_LEAD_WINDOW_DAYS } from "../relationships/recommendation-candidates.ts";

// The hard ceiling live-data.ts ever displays on the homepage
// (`Math.min(priorityLimit, 50)`). The contact-gap pool size below is
// *derived* from this, not a second, independently-chosen number that
// could silently drift out of sync with the actual display limit.
export const HOMEPAGE_MAX_RESULTS = 50;

// Headroom above the display ceiling. The core bound (see the monotonicity
// note on selectSuggestionDonorIds below) is already exact at 1x -- nobody
// outside the top HOMEPAGE_MAX_RESULTS stalest donors can outscore anybody
// inside it. This multiplier exists only for what happens *after*
// selection: dismissed items get filtered out post-hoc, other rank-4
// candidates (relationship_opportunity, continue_conversation, etc.)
// compete for the same slots, and ties need somewhere to land -- none of
// which changes the correctness argument, they just mean "exactly
// HOMEPAGE_MAX_RESULTS" would be cutting it closer than necessary.
export const CONTACT_GAP_POOL_HEADROOM_MULTIPLIER = 2;

export const CONTACT_GAP_POOL_SIZE = HOMEPAGE_MAX_RESULTS * CONTACT_GAP_POOL_HEADROOM_MULTIPLIER;

export type ContactGapCandidate = { donorId: string; daysSinceLastContact: number | null };
export type YahrtzeitCandidateRow = { donorId: string; hebrewMonth: HebrewMonthName; hebrewDay: number };
export type ImportantDateCandidateRow = { donorId: string; month: number; day: number };

// Mirrors recommendation-evidence.ts's own daysBetween exactly (not
// imported, to avoid coupling this module to that one's internals for a
// single line of arithmetic) -- so "inside the lead window" here always
// agrees with what yahrtzeitOutreachCandidate decides later for the same
// donor, now, and timezone.
function daysBetween(laterEpoch: number, earlierEpoch: number): number {
  return Math.max(0, Math.floor((laterEpoch - earlierEpoch) / 86400));
}

// "Never contacted" sorts as more stale than any specific day count. This
// is deliberately conservative: it guarantees every donor who could win
// under either the within-donor urgency formula (which treats "never"
// as a fixed 0.5, capped by any day count >= 365) or live-data.ts's own
// cross-donor sortAt key (which ranks "never" as the single most extreme
// value) is captured by the same bound, without this module needing to
// know or duplicate that downstream tie-breaking logic itself.
function staleness(days: number | null): number {
  return days === null ? Number.POSITIVE_INFINITY : days;
}

// Core guarantee: reconnect_contact_gap's score depends on nothing but
// days-since-contact (specificity and recency are fixed constants for
// that candidate -- see recommendation-candidates.ts). Ranking within this
// category is therefore a pure, monotonic function of staleness() alone,
// so the top-N stalest donors by that measure are exactly the donors who
// could possibly place among the top N results -- nobody excluded can
// ever outscore everybody included. tests/suggestion-candidates.test.mjs
// pins this as an explicit invariant: if a future change makes this
// candidate's score depend on anything else, that test fails and this
// module's whole strategy needs revisiting, not just a bigger pool size.
export function selectSuggestionDonorIds(input: {
  giftDonorIds: Iterable<string>;
  pledgeDonorIds: Iterable<string>;
  yahrtzeitRows: YahrtzeitCandidateRow[];
  importantDateRows?: ImportantDateCandidateRow[];
  contactGapCandidates: ContactGapCandidate[];
  timezone: string;
  now: number;
  poolSize?: number;
}): Set<string> {
  const poolSize = input.poolSize ?? CONTACT_GAP_POOL_SIZE;
  const selected = new Set<string>();
  for (const id of input.giftDonorIds) selected.add(id);
  for (const id of input.pledgeDonorIds) selected.add(id);

  const yahrtzeitsByDonor = new Map<string, YahrtzeitCandidateRow[]>();
  for (const row of input.yahrtzeitRows) {
    if (!yahrtzeitsByDonor.has(row.donorId)) yahrtzeitsByDonor.set(row.donorId, []);
    yahrtzeitsByDonor.get(row.donorId)!.push(row);
  }
  for (const [donorId, rows] of yahrtzeitsByDonor) {
    const soonestDaysUntil = Math.min(...rows.map((row) => {
      const occurrence = nextYahrtzeitOccurrence(row.hebrewMonth, row.hebrewDay, input.timezone, input.now);
      return daysBetween(occurrence.primary.gregorianEpoch, input.now);
    }));
    if (soonestDaysUntil <= RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) selected.add(donorId);
  }

  // Birthday/anniversary donors within their own lead window are kept
  // unbounded for the exact same reason as yahrtzeit above: driven by real,
  // rare per-donor events, not by total donor count.
  const importantDatesByDonor = new Map<string, ImportantDateCandidateRow[]>();
  for (const row of input.importantDateRows ?? []) {
    if (!importantDatesByDonor.has(row.donorId)) importantDatesByDonor.set(row.donorId, []);
    importantDatesByDonor.get(row.donorId)!.push(row);
  }
  for (const [donorId, rows] of importantDatesByDonor) {
    const soonestDaysUntil = Math.min(...rows.map((row) => {
      const occurrence = nextGregorianRecurrence(row.month, row.day, input.timezone, input.now);
      return daysBetween(occurrence.primary.gregorianEpoch, input.now);
    }));
    if (soonestDaysUntil <= RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) selected.add(donorId);
  }

  // Comparing by subtraction (b - a) breaks here: two never-contacted
  // donors both map to Infinity, and Infinity - Infinity is NaN, which is
  // not a valid comparator result -- V8's sort assumes a real total order
  // and can silently misorder unrelated elements once it sees one. Explicit
  // relational comparisons avoid the NaN case entirely.
  const boundedContactGap = [...input.contactGapCandidates]
    .sort((a, b) => {
      const sa = staleness(a.daysSinceLastContact);
      const sb = staleness(b.daysSinceLastContact);
      return sa === sb ? 0 : sb > sa ? 1 : -1;
    })
    .slice(0, poolSize);
  for (const candidate of boundedContactGap) selected.add(candidate.donorId);

  return selected;
}
