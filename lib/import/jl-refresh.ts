export type DatedActivity = { activityDate: number | null; category: string };

const DAY_SECONDS = 86400;

// Only a fully-received, fully-reconciled gift proves Fundraising OS
// already has real donation history covering its date. An open or
// partially-paid pledge's stored date is the JL export's "Due Date" for an
// UNRESOLVED balance -- a forward-looking commitment/obligation, not a
// record that money was actually received -- and must never be treated as
// import coverage. This is the exact root cause of the "Feb 23, 2027 - Sep
// 9, 2026" inverted Suggested Donation Export bug (docs/AI-HANDOFF.md): a
// real, legitimate partially-paid pledge with a future installment due
// date was previously counted here, making Fundraising OS believe it had
// donation history current through that future date.
function isCompletedDonation(activity: DatedActivity): boolean {
  return activity.category === "completed_gift";
}

export function donationExportRange(activities: DatedActivity[]) {
  const dates = activities
    .filter(isCompletedDonation)
    .map((activity) => activity.activityDate)
    .filter((date): date is number => date !== null && Number.isFinite(date));
  return dates.length ? { start: Math.min(...dates), end: Math.max(...dates) } : { start: null, end: null };
}

export type SuggestedDonationRange =
  | { state: "no_prior_coverage"; start: null; end: number }
  | { state: "range"; start: number; end: number; overlapDays: number }
  | { state: "already_current"; start: null; end: number; futureCoverageDetected: boolean }
  | { state: "unknown_coverage"; start: null; end: number };

// Invariant: this function must NEVER return a start after its end -- never
// invert the range, and never silently swap the two. `lastRangeEnd` must be
// the end of the most recent successful *donation* import's own detected
// coverage (jl_refresh_state.last_donation_range_end, itself now computed
// by donationExportRange() above using only completed gifts). If coverage
// already reaches or passes today, or the stored value is malformed, this
// returns an explicit non-range state instead of fabricating a date.
export function suggestedDonationRange(lastRangeEnd: number | null, now = new Date()): SuggestedDonationRange {
  const end = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  if (lastRangeEnd === null) return { state: "no_prior_coverage", start: null, end };
  if (!Number.isFinite(lastRangeEnd) || lastRangeEnd < 0) return { state: "unknown_coverage", start: null, end };
  if (lastRangeEnd >= end) return { state: "already_current", start: null, end, futureCoverageDetected: lastRangeEnd > end };
  const overlapDays = 7;
  const start = Math.max(0, lastRangeEnd - (overlapDays - 1) * DAY_SECONDS);
  return { state: "range", start, end, overlapDays };
}

export function isoDate(epoch: number | null) {
  return epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
}
