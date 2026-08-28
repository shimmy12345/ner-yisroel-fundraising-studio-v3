// Portfolio Focus -- Round 3 frozen component definitions (see
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md, "Exact frozen Round 3
// formula" and docs/PORTFOLIO-FOCUS-CALIBRATION-V2.md for the FS/MOM/TAC
// definitions Round 3 explicitly left unchanged). Every function here is
// pure -- no D1, no I/O -- and takes only already-resolved evidence from
// lib/portfolio-focus/aggregate.ts plus the shared portfolio-wide
// PortfolioFocusContext.
import type { MomentumLabel, PledgeStaleClass, PortfolioFocusContext, PortfolioFocusDonorInput } from "./types.ts";
import { materiality, recencyDecay } from "./materiality.ts";
import { percentileRank } from "./stats.ts";
import { pledgeRecencyDays } from "./stale-balance.ts";

// ---------------- Financial Significance (Round 2, unchanged in Round 3) ----------------
// Deliberately never touches pledges or recent commitments -- magnitude/
// history only, so a donor who gives entirely through outright gifts is
// never structurally disadvantaged relative to one who happens to use
// pledges (Investigation item 3's central requirement).
export function computeFinancialSignificance(input: PortfolioFocusDonorInput, ctx: PortfolioFocusContext): number {
  const ownPeak = Math.max(input.historicalPeakGiftCents ?? 0, input.historicalPeakCommitmentCents ?? 0);
  const lifetimePct = percentileRank(ctx.lifetimeValuesPositive, input.lifetimeCents);
  const peakPct = ownPeak > 0 ? percentileRank(ctx.historicalPeaksPositive, ownPeak) : 0;
  const yearsPct = input.distinctActivityYears > 0 ? percentileRank(ctx.distinctYearsPositive, input.distinctActivityYears) : 0;
  return 0.60 * lifetimePct + 0.25 * peakPct + 0.15 * yearsPct;
}

function ownPeakCents(input: PortfolioFocusDonorInput): number {
  return Math.max(input.historicalPeakGiftCents ?? 0, input.historicalPeakCommitmentCents ?? 0);
}

// ---------------- Opportunity (Round 3: materiality redesigned; engagement track and combination rule unchanged from Round 2) ----------------
export function computeOpportunity(input: PortfolioFocusDonorInput, ctx: PortfolioFocusContext, staleClass: PledgeStaleClass): number {
  const peak = ownPeakCents(input);
  let financialOpp = 0;
  if (staleClass === "current" && input.openPledgeTotalCents) {
    const recency = pledgeRecencyDays(input);
    financialOpp = recencyDecay(recency) * materiality(input.openPledgeTotalCents, peak, ctx.financialEventAmounts);
  }
  // Engagement track: a live, warm relationship registers as a real
  // opportunity even with zero dollar commitment (Investigation item 8) --
  // a general mechanic, not donor-specific. No credit of any kind for
  // absence of documented contact (Investigation item 4) -- that code
  // path does not exist here.
  let engagementOpp = 0;
  if (input.hasOpenReminder) engagementOpp = 0.6;
  else if (input.hasActionableFact && input.daysSinceSubstantiveContact != null && input.daysSinceSubstantiveContact <= 45) engagementOpp = 0.4;

  let opp = Math.max(financialOpp, engagementOpp);
  if (financialOpp >= 0.4 && engagementOpp >= 0.4) opp += 0.1;
  return Math.min(1, opp);
}

// ---------------- Stewardship (Round 2: no longer requires a payment plan; Round 3 shares the corrected materiality()) ----------------
export function computeStewardship(input: PortfolioFocusDonorInput, ctx: PortfolioFocusContext, staleClass: PledgeStaleClass): number {
  const peak = ownPeakCents(input);
  let recentEvent: { amount: number; recencyDays: number | null } | null = null;
  if (staleClass === "current" && input.openPledgeTotalCents) {
    recentEvent = { amount: input.openPledgeTotalCents, recencyDays: pledgeRecencyDays(input) };
  }
  if (input.mostRecentCashKind === "gift" && input.mostRecentCashCents != null && input.daysSinceLastGift != null && input.daysSinceLastGift <= 365) {
    if (!recentEvent || input.mostRecentCashCents > recentEvent.amount) recentEvent = { amount: input.mostRecentCashCents, recencyDays: input.daysSinceLastGift };
  }
  const recentEventTerm = recentEvent ? recencyDecay(recentEvent.recencyDays) * materiality(recentEvent.amount, peak, ctx.financialEventAmounts) : 0;
  const onTrack = input.pledgePlanOnTrack === true;
  const activeFulfillmentTerm = onTrack ? materiality(input.openPledgeTotalCents, peak, ctx.financialEventAmounts) : 0;
  const explicitReminderTerm = input.hasOpenReminder ? 1 : 0;
  const meaningfulRelationship = percentileRank(ctx.lifetimeValuesPositive, input.lifetimeCents) > 0.5;
  const upcomingDateTerm = input.upcomingDateDescription && meaningfulRelationship ? 1 : 0;
  const recentSubstantiveTerm = input.daysSinceSubstantiveContact != null && input.daysSinceSubstantiveContact <= 45 ? 1 : 0;
  const stew = 0.35 * recentEventTerm + 0.20 * activeFulfillmentTerm + 0.20 * explicitReminderTerm + 0.15 * upcomingDateTerm + 0.10 * recentSubstantiveTerm;
  return Math.min(1, stew);
}

// ---------------- Relationship Momentum (Round 2, unchanged in Round 3) ----------------
export function computeMomentum(input: PortfolioFocusDonorInput, ctx: PortfolioFocusContext): { label: MomentumLabel; signal: number } {
  const lifetimePct = percentileRank(ctx.lifetimeValuesPositive, input.lifetimeCents);
  const onTrack = input.pledgePlanOnTrack === true;
  const everGaveBeforeLast365 = input.lifetimeCents > input.last365Cents;

  if (input.lifetimeCents === 0) return { label: "no_giving_history", signal: 0 };
  if (onTrack) return { label: "actively_fulfilling_commitment", signal: 0.3 };
  if (input.daysSinceLastGift === null || input.daysSinceLastGift > 365) return { label: "dormant_lapsed", signal: 0.4 * lifetimePct };
  if (!everGaveBeforeLast365 && input.last365Cents > 0) {
    const matPct = percentileRank(ctx.lifetimeValuesPositive, input.last365Cents);
    return { label: "newly_significant", signal: 0.4 + 0.5 * matPct };
  }
  if (input.prior365Cents > 0) {
    const ratio = input.last365Cents / input.prior365Cents;
    const deltaAbs = Math.abs(input.last365Cents - input.prior365Cents);
    const deltaMaterialityPct = percentileRank(ctx.deltaAbsValues, deltaAbs);
    const deltaRelativeToLifetime = input.lifetimeCents > 0 ? deltaAbs / input.lifetimeCents : 0;
    const meaningfulSwing = deltaMaterialityPct >= 0.4 && deltaRelativeToLifetime >= 0.03;
    if (ratio >= 1.25 && meaningfulSwing) return { label: "increasing", signal: Math.min(0.7, 0.3 + (ratio - 1) * 0.3) };
    if (ratio <= 0.6 && meaningfulSwing) return { label: "declining", signal: 0.5 * lifetimePct };
    if (ratio >= 1.25 || ratio <= 0.6) return { label: "noisy_swing", signal: 0.05 };
    return { label: "stable", signal: 0.1 };
  }
  return { label: "insufficient_data", signal: 0.05 };
}

// ---------------- Tactical Urgency (Round 2, unchanged in Round 3) ----------------
// The real Recommendation Engine score, consumed as-is, EXCEPT Portfolio
// Focus's own strategic representation of a follow_up_pledge on a stale
// balance is discounted -- the Recommendation Engine itself, its score,
// and Suggested Actions/Daily Agenda are never touched.
export function computeTacticalUrgency(input: PortfolioFocusDonorInput, staleClass: PledgeStaleClass): number {
  let tac = input.recommendation ? input.recommendation.score : 0;
  if (input.recommendation && input.recommendation.kind === "follow_up_pledge" && staleClass) {
    if (staleClass === "immaterial_artifact") tac = Math.min(tac, 0.15);
    else if (staleClass === "legacy_needs_verification") tac = Math.min(tac, 0.40);
  }
  return tac;
}

// ---------------- Relationship Coverage (new in Round 3) ----------------
// "Given how important this relationship is, do we know enough to
// manage it responsibly" -- explicitly NOT "is there a solicitation
// opportunity." Multiplicative by design (Coverage can never exceed
// Financial Significance) so it is mathematically incapable of becoming
// a second, independent "FS + missing-interaction" bonus.
export function computeCoverage(input: PortfolioFocusDonorInput, financialSignificance: number): number {
  const knowledgeScore =
    0.30 * (input.lastInteractionDaysAgo != null ? 1 : 0) +
    0.25 * (input.hasCurrentFact ? 1 : 0) +
    0.15 * (input.askHistoryCount > 0 ? 1 : 0) +
    0.30 * (input.daysSinceSubstantiveContact != null && input.daysSinceSubstantiveContact <= 365 ? 1 : 0);
  const evidenceGap = 1 - knowledgeScore;
  return financialSignificance * evidenceGap;
}

// Cubic curve so the floor stays negligible except when Coverage is
// genuinely near-maximal (both very high Financial Significance AND
// near-total absence of relationship evidence). Continuous, no cliff;
// its ceiling (0.45) sits below the genuinely-active donor cluster so it
// can raise a silent-but-significant relationship without ever
// outranking real, current activity.
export function computeCoverageFloor(coverage: number): number {
  return 0.45 * Math.pow(coverage, 3);
}
