// Portfolio Focus -- Round 3 frozen materiality model (see
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md, "Opportunity magnitude
// redesign" / "Exact frozen Round 3 formula"). Answers "how
// strategically significant is this single financial event" for both
// Opportunity's pledge track and Stewardship's event track -- the ONE
// shared helper both components use, by design (Round 2/3's own
// disclosed finding: some overlap between concepts describing the same
// real event is legitimate; a single, tested helper is safer than two
// near-duplicate ones).
//
// Anchored to FIXED real-dollar brackets ($500 = negligible, $100,000 =
// a standard six-figure major-gift threshold) rather than a scale
// relative to this portfolio's own current largest pledge -- Round 2's
// portfolio-relative-only approach let a $1,500 pledge score nearly as
// high as a $75,000 one; anchoring to real dollar brackets fixed that
// (see the calibration doc's dollar-sensitivity table for the exact
// before/after values this implementation must reproduce).
import { clamp, percentileRank } from "./stats.ts";

const MATERIALITY_FLOOR_CENTS = 50_000; // $500
const MATERIALITY_CEILING_CENTS = 10_000_000; // $100,000
const LOG_FLOOR = Math.log10(MATERIALITY_FLOOR_CENTS / 100);
const LOG_CEILING = Math.log10(MATERIALITY_CEILING_CENTS / 100);

export function absoluteMateriality(amountCents: number | null): number {
  if (!amountCents || amountCents <= 0) return 0;
  const logAmount = Math.log10(amountCents / 100);
  return clamp((logAmount - LOG_FLOOR) / (LOG_CEILING - LOG_FLOOR), 0, 1);
}

// 0.70 absolute (fixed real-dollar brackets) + 0.15 portfolio-relative
// percentile + 0.15 donor-relative (bounded so it can nudge, never
// overwhelm, the absolute read -- see the calibration doc's Examples
// A-D). `ownPeakCents` is the donor's own historical peak single event
// (gift or pledge, whichever is larger) -- 0/null/negative safely
// yields a zero donor-relative term, never a divide-by-zero.
export function materiality(amountCents: number | null, ownPeakCents: number | null, allFinancialEventAmounts: readonly number[]): number {
  if (!amountCents || amountCents <= 0) return 0;
  const abs = absoluteMateriality(amountCents);
  const pct = percentileRank(allFinancialEventAmounts, amountCents);
  const rel = ownPeakCents && ownPeakCents > 0 ? Math.min(1, amountCents / ownPeakCents) : 0;
  return 0.70 * abs + 0.15 * pct + 0.15 * rel;
}

// Continuous recency decay -- 1.0 at day 0, 0 at day 365+, never a
// cliff. Shared by Opportunity's financial track and Stewardship's
// event/active-fulfillment tracks (both use the same "how fresh is this"
// concept, applied to different underlying events).
export function recencyDecay(days: number | null): number {
  if (days == null) return 0;
  return clamp(1 - days / 365, 0, 1);
}
