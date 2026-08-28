// Portfolio Focus -- stale-balance strategic relevance gate (Round 2/3,
// see docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md Section 8/11). Classifies
// an open pledge into exactly one of three strategic tiers WITHOUT
// touching the pledge row, the Recommendation Engine, or any database
// value -- purely a read used by Opportunity (a non-"current" pledge
// contributes zero Opportunity regardless of size) and by Portfolio
// Focus's own strategic discount of the Recommendation Engine's
// follow_up_pledge score (never the Engine's own score).
import type { PledgeStaleClass, PortfolioFocusDonorInput } from "./types.ts";

// "Is this pledge new" is judged by its own real commitment date when
// known (pledgeCommitmentAgeDays); falls back to last-activity recency
// (pledgeAgeDays) ONLY when the commitment date itself is unusable --
// the same Spetner-vs-Stein safeguard the financial-model audit
// established and every calibration round preserved unchanged.
export function pledgeRecencyDays(input: Pick<PortfolioFocusDonorInput, "pledgeCommitmentAgeDays" | "pledgeAgeDays">): number | null {
  if (input.pledgeCommitmentAgeDays != null) return input.pledgeCommitmentAgeDays;
  if (input.pledgeAgeDays != null && input.pledgeAgeDays >= 0) return input.pledgeAgeDays;
  return null;
}

export function classifyPledgeStaleness(
  input: Pick<PortfolioFocusDonorInput, "openPledgeBalanceCents" | "pledgeCommitmentAgeDays" | "pledgeAgeDays" | "pledgePlanOnTrack" | "daysSinceSubstantiveContact">,
): PledgeStaleClass {
  if (input.openPledgeBalanceCents === null) return null;
  const realAge = pledgeRecencyDays(input);
  const onTrack = input.pledgePlanOnTrack === true;
  const recentSubstantive = input.daysSinceSubstantiveContact != null && input.daysSinceSubstantiveContact <= 365;
  if (onTrack || (realAge != null && realAge <= 365) || recentSubstantive) return "current";
  if (realAge != null && realAge > 1825) return "immaterial_artifact"; // 5+ years
  return "legacy_needs_verification"; // 1-5 years, or age itself unknown
}
