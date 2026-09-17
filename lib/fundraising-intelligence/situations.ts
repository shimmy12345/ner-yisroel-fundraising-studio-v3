// Fundraising Intelligence Brief -- Phase 1 situation detectors. Pure,
// no D1/I/O. Each function is one independent, evidence-based detector
// (see docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md §7/§11 for the
// investigation this implements). None of these branch on
// `recommendation.kind` as a QUALIFYING condition -- the Recommendation
// Engine's per-donor winner (including the generic reconnect_contact_gap
// fallback, which real-data investigation showed wins for 209/254 real
// donors) is never itself sufficient evidence for Brief inclusion. Every
// detector below reads only independent, structured evidence
// (reminders, facts, asks, pledge/plan state, momentum, financial
// materiality, confidence axes) that already exists on Portfolio
// Focus's computed output.
import type { PortfolioFocusDonorInput, PortfolioFocusResult } from "../portfolio-focus/types.ts";
import type { RawAskRow, RawRelationshipFactRow } from "../portfolio-focus/aggregate.ts";
import type { BriefDisposition, BriefEvidenceRef, ConfidenceLevel, SituationType } from "./types.ts";

const DAY = 86400;

// Hard rule F: a negative day-delta means the underlying date is
// future-dated (a real, live data anomaly found in Independent
// Staging -- see the design doc §4, David B. Rosenbaum). Never treat a
// negative value as "recent"; treat it as unknown instead.
export function safeDays(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

export type DetectedSignal = {
  situationType: SituationType;
  disposition: BriefDisposition; // this detector's own natural disposition -- "KNOW" or "DO" only; KNOW_DO is decided later, in synthesis, from a combination of two detectors' outputs
  // Fixed priority used both for tiering (§17) and for picking the
  // single winning situation per donor (§13/H) when several detectors
  // fire for the same donor. Lower priorityOrder wins.
  priorityTier: 1 | 2 | 3;
  priorityOrder: number;
  headline: string;
  explanation: string;
  whyNow: string;
  whatFosDoesNotKnow: string | null;
  possibleAction: string | null; // MUST be non-null iff disposition === "DO" (checked by tests)
  confidence: ConfidenceLevel;
  evidence: BriefEvidenceRef[];
};

// --- Tier 1 --------------------------------------------------------

function detectExplicitFollowUp(donor: PortfolioFocusDonorInput, facts: RawRelationshipFactRow[]): DetectedSignal | null {
  const evidence: BriefEvidenceRef[] = [];
  let primaryText: string | null = null;

  if (donor.hasOpenReminder && donor.openReminderAction) {
    primaryText = donor.openReminderAction;
    evidence.push({ kind: "open_reminder", detail: donor.openReminderAction });
  }
  // A fact-level commitment ("said to follow up after Succos") that has
  // not (or not yet) been promoted to a formal recommendations-row
  // reminder -- classifyFactLifecycle's own `follow_up` category, reused
  // as-is, never re-derived here.
  const followUpFact = facts.find((f) => f.lifecycle === "follow_up");
  if (followUpFact) {
    evidence.push({ kind: "relationship_fact", detail: followUpFact.fact_text });
    if (!primaryText) primaryText = followUpFact.fact_text;
  }
  if (!primaryText) return null;

  return {
    situationType: "explicit_follow_up",
    disposition: "DO",
    priorityTier: 1,
    priorityOrder: 0,
    headline: "Follow-up already committed",
    explanation: `A specific follow-up is on file: "${primaryText}".`,
    whyNow: "This is a commitment the fundraiser already made, not a suggestion FOS is inventing.",
    whatFosDoesNotKnow: null,
    possibleAction: primaryText,
    confidence: "high",
    evidence,
  };
}

const ASK_MATERIALITY_FLOOR_CENTS = 100_000; // $1,000 -- documented, not derived
const ASK_RECENCY_WINDOW_DAYS = 545; // ~18 months -- an ancient declined ask is no longer live context

function detectAskResolution(asks: RawAskRow[], now: number): DetectedSignal | null {
  if (asks.length === 0) return null;
  const mostRecent = [...asks].sort((a, b) => b.asked_at - a.asked_at)[0];
  const ageDays = safeDays(Math.floor((now - mostRecent.asked_at) / DAY));
  const amountLabel = mostRecent.amount_cents != null ? fmtCents(mostRecent.amount_cents) : "an unspecified amount";
  const purposeLabel = mostRecent.purpose ?? "purpose not recorded";
  const evidence: BriefEvidenceRef[] = [{ kind: "ask", detail: `${mostRecent.status} ask for ${amountLabel} (${purposeLabel})` }];

  if (mostRecent.status === "pending") {
    if (ageDays === null) return null; // future-dated ask -- rule F: don't manufacture urgency from a bad date
    const material = (mostRecent.amount_cents ?? 0) >= ASK_MATERIALITY_FLOOR_CENTS;
    return {
      situationType: "ask_resolution",
      disposition: material ? "DO" : "KNOW",
      priorityTier: 1,
      priorityOrder: 1,
      headline: "Ask still open",
      explanation: `An ask for ${amountLabel} (${purposeLabel}) has been pending for ${ageDays} days with no recorded resolution.`,
      whyNow: material ? "A material ask has sat open for a while -- worth a status check before assuming it's still live." : "A pending ask is on file.",
      whatFosDoesNotKnow: "Whether this ask has been discussed informally since it was recorded.",
      possibleAction: material ? "Check in on the status of this ask." : null,
      confidence: "medium",
      evidence,
    };
  }

  if (mostRecent.status === "declined" || mostRecent.status === "withdrawn") {
    if (ageDays === null || ageDays > ASK_RECENCY_WINDOW_DAYS) return null;
    return {
      situationType: "ask_resolution",
      disposition: "KNOW",
      priorityTier: 1,
      priorityOrder: 1,
      headline: "Prior ask was not accepted",
      explanation: `The most recent ask (${amountLabel}, ${purposeLabel}) was recorded as ${mostRecent.status} ${ageDays} days ago.`,
      whyNow: "FOS should not present this as an open opportunity -- the recorded Ask history says otherwise.",
      whatFosDoesNotKnow: null,
      possibleAction: null,
      confidence: "high",
      evidence,
    };
  }

  return null; // "committed" -- Phase 1 deliberately does not cross-reference against giving to detect a mismatch; see calibration doc's documented gap
}

function detectPledgeFollowUp(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): DetectedSignal | null {
  if (donor.openPledgeBalanceCents == null || donor.openPledgeBalanceCents <= 0) return null;
  // Reuse Portfolio Focus's OWN, already-calibrated pledge-staleness
  // classification (lib/portfolio-focus/stale-balance.ts) rather than a
  // second age rule -- a real 5+ year old balance is a dead bookkeeping
  // artifact, never a live "worth a follow-up" situation, regardless of
  // this detector's own 60-day nudge threshold below. (Found live during
  // Phase 1 calibration: several real Independent Staging pledges are
  // 12-27 YEARS old and were wrongly surfacing as "gone stale" DO items
  // before this guard was added -- see the calibration doc.)
  if (result.pledgeStaleClass === "immaterial_artifact") return null;

  const total = donor.openPledgeTotalCents ?? donor.openPledgeBalanceCents;
  const remainingRatio = total > 0 ? donor.openPledgeBalanceCents / total : 1;
  if (remainingRatio <= 0.25) return null; // near-complete -- commitment_progress's territory, not a follow-up gap

  const ageDays = safeDays(donor.pledgeAgeDays);
  const hasPlan = donor.pledgePlanOnTrack !== null;
  const isStale = (hasPlan && donor.pledgePlanOnTrack === false) || (!hasPlan && ageDays !== null && ageDays >= 60);
  if (!isStale) return null;

  const contactDays = safeDays(donor.daysSinceSubstantiveContact);
  const warm = contactDays !== null && contactDays <= 60;
  const needsVerification = result.pledgeStaleClass === "legacy_needs_verification";

  return {
    situationType: "pledge_follow_up",
    disposition: "DO",
    priorityTier: 1,
    priorityOrder: 2,
    headline: "Open pledge has gone stale",
    explanation: `A ${fmtCents(total)} pledge (${fmtCents(donor.openPledgeBalanceCents)} still open) has had no recorded payment activity in ${ageDays ?? "an unknown number of"} days${hasPlan ? ", and its payment plan is currently behind schedule" : ""}.`,
    whyNow: warm ? "Recent, unrelated contact shows the relationship is active -- a friendly follow-up on this pledge is low-risk." : "This is an old, unresolved financial commitment worth a status check.",
    whatFosDoesNotKnow: warm ? null : "Whether this pledge has been discussed informally since its last recorded activity.",
    possibleAction: "Follow up on the open pledge balance.",
    confidence: needsVerification ? "limited" : warm ? "high" : "medium",
    evidence: [{ kind: "pledge_balance", detail: `${fmtCents(donor.openPledgeBalanceCents)} of ${fmtCents(total)} open, ${hasPlan ? "plan behind schedule" : "no active plan"}` }],
  };
}

// --- Tier 2 --------------------------------------------------------

function detectCommitmentProgress(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): DetectedSignal | null {
  if (donor.openPledgeBalanceCents == null || donor.openPledgeTotalCents == null || donor.openPledgeTotalCents <= 0) return null;
  if (result.pledgeStaleClass === "immaterial_artifact") return null; // an ancient dead balance is not "healthy progress" -- see detectPledgeFollowUp
  const remainingRatio = donor.openPledgeBalanceCents / donor.openPledgeTotalCents;
  if (remainingRatio > 0.25) return null;
  if (donor.pledgePlanOnTrack === false) return null; // behind schedule is pledge_follow_up's territory, not "healthy progress"

  const pctPaid = Math.round((1 - remainingRatio) * 100);
  return {
    situationType: "commitment_progress",
    disposition: "KNOW",
    priorityTier: 2,
    priorityOrder: 3,
    headline: "Commitment nearly fulfilled",
    explanation: `${fmtCents(donor.openPledgeBalanceCents)} remains of a ${fmtCents(donor.openPledgeTotalCents)} pledge -- ${pctPaid}% already paid, on track.`,
    whyNow: "Worth knowing this is close to done -- not a stewardship gap and not a new ask opportunity.",
    whatFosDoesNotKnow: null,
    possibleAction: null,
    confidence: donor.pledgePlanOnTrack === true ? "high" : "medium",
    evidence: [{ kind: "pledge_balance", detail: `${pctPaid}% paid, ${fmtCents(donor.openPledgeBalanceCents)} remaining` }],
  };
}

function detectStewardshipMoment(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult, facts: RawRelationshipFactRow[]): DetectedSignal | null {
  const activelyFulfilling = result.momentumLabel === "actively_fulfilling_commitment";
  const onTrackPlan = donor.pledgePlanOnTrack === true;
  // Rule H: a lifecycle === "follow_up" fact is already claimed by
  // detectExplicitFollowUp above -- excluded here so the same fact never
  // fires two different situation types for the same donor (which would
  // force an unearned KNOW_DO upgrade in synthesize.ts).
  const recentNonSolicitationFact = [...facts]
    .filter((f) => f.category !== "solicitation" && f.lifecycle !== "follow_up")
    .sort((a, b) => b.source_interaction_occurred_at - a.source_interaction_occurred_at)[0] ?? null;

  if (!activelyFulfilling && !onTrackPlan && !recentNonSolicitationFact) return null;

  const evidence: BriefEvidenceRef[] = [];
  let explanation: string;
  if (activelyFulfilling || onTrackPlan) {
    explanation = `This donor is actively fulfilling a ${fmtCents(donor.openPledgeTotalCents)} pledge on schedule (${fmtCents(donor.openPledgeBalanceCents)} remaining).`;
    evidence.push({ kind: "momentum", detail: "actively_fulfilling_commitment / on-track payment plan" });
  } else {
    explanation = `A specific relationship note is on file: "${recentNonSolicitationFact!.fact_text}".`;
  }
  if (recentNonSolicitationFact && (activelyFulfilling || onTrackPlan)) {
    evidence.push({ kind: "relationship_fact", detail: recentNonSolicitationFact.fact_text });
  }

  return {
    situationType: "stewardship_moment",
    disposition: "KNOW",
    priorityTier: 2,
    priorityOrder: 5,
    headline: activelyFulfilling || onTrackPlan ? "Actively engaged relationship" : "Recent relationship note on file",
    explanation,
    whyNow: "No stewardship gap and no reason to solicit again right now -- this is worth knowing, not acting on.",
    whatFosDoesNotKnow: null,
    possibleAction: null,
    confidence: (activelyFulfilling || onTrackPlan) && result.financialConfidence === "high" ? "high" : "medium",
    evidence,
  };
}

const FINANCIAL_CHANGE_MATERIALITY_FLOOR = 0.5; // existing financialSignificance percentile component -- not a new score
const NEWLY_SIGNIFICANT_FLOOR_CENTS = 100_000; // $1,000 -- keeps small first gifts from flooding Phase 1; see calibration doc's documented clustering gap

function detectFinancialChange(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): DetectedSignal | null {
  if (result.momentumLabel === "increasing" || result.momentumLabel === "declining") {
    if (result.components.financialSignificance < FINANCIAL_CHANGE_MATERIALITY_FLOOR) return null;
    const up = result.momentumLabel === "increasing";
    return {
      situationType: "financial_change",
      disposition: "KNOW",
      priorityTier: 2,
      priorityOrder: 4,
      headline: up ? "Giving trend moved up" : "Giving trend moved down",
      explanation: `Giving over the past year (${fmtCents(donor.last365Cents)}) compares to the prior year (${fmtCents(donor.prior365Cents)}) as a real, dated ${up ? "increase" : "decrease"}.`,
      whyNow: up ? "A real, recent increase in commitment -- worth being aware of before the next conversation." : "A real decline on a financially significant relationship -- worth understanding, not assuming a cause.",
      whatFosDoesNotKnow: up ? null : "Why giving declined -- FOS has no recorded interaction explaining it.",
      possibleAction: null,
      confidence: "medium",
      evidence: [{ kind: "momentum", detail: `${result.momentumLabel}: ${fmtCents(donor.prior365Cents)} -> ${fmtCents(donor.last365Cents)}` }],
    };
  }
  if (result.momentumLabel === "newly_significant") {
    if (donor.last365Cents < NEWLY_SIGNIFICANT_FLOOR_CENTS) return null;
    return {
      situationType: "financial_change",
      disposition: "KNOW",
      priorityTier: 2,
      priorityOrder: 4,
      headline: "New meaningful giving",
      explanation: `This donor crossed into meaningful giving for the first time (${fmtCents(donor.last365Cents)} in the past year, no prior giving history).`,
      whyNow: "A previously-quiet donor just became worth attention -- this would not surface from an importance ranking alone.",
      whatFosDoesNotKnow: null,
      possibleAction: null,
      confidence: "medium",
      evidence: [{ kind: "momentum", detail: `newly_significant: ${fmtCents(donor.last365Cents)}, no prior giving history` }],
    };
  }
  return null;
}

const RECENT_GIFT_WINDOW_DAYS = 30;
const RECENT_GIFT_MATERIALITY_FLOOR_CENTS = 50_000; // $500 -- a documented absolute floor, not a new percentile score

// A distinct signal from detectFinancialChange's year-over-year trend
// read: a single, real, recently-dated gift. Kept separate and always
// merged as its own evidence line (never summed with an open pledge
// balance or the last365/prior365 totals) -- this is the concrete
// mechanism that keeps Mordechai Schwartz's real $9,670 gift and his
// separate, fully-unpaid $36,000 pledge distinguishable within one
// synthesized item (see synthesize.ts and the design doc §13).
function detectRecentMeaningfulGift(donor: PortfolioFocusDonorInput): DetectedSignal | null {
  if (donor.mostRecentCashKind !== "gift") return null;
  const daysAgo = safeDays(donor.daysSinceLastGift);
  if (daysAgo === null || daysAgo > RECENT_GIFT_WINDOW_DAYS) return null;
  if ((donor.mostRecentCashCents ?? 0) < RECENT_GIFT_MATERIALITY_FLOOR_CENTS) return null;

  return {
    situationType: "financial_change",
    disposition: "KNOW",
    priorityTier: 2,
    priorityOrder: 4,
    headline: "Recent meaningful gift",
    explanation: `A ${fmtCents(donor.mostRecentCashCents)} gift was received ${daysAgo} days ago.`,
    whyNow: "A recent, real gift is a positive signal worth being aware of before the next conversation.",
    whatFosDoesNotKnow: null,
    possibleAction: null,
    confidence: "medium",
    evidence: [{ kind: "cash_event", detail: `${fmtCents(donor.mostRecentCashCents)} gift, ${daysAgo} days ago` }],
  };
}

// --- Tier 3 --------------------------------------------------------

const RELATIONSHIP_VISIBILITY_MATERIALITY_FLOOR = 0.75; // top quartile by the existing financialSignificance component

function detectRelationshipVisibility(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): DetectedSignal | null {
  if (result.relationshipConfidence !== "low") return null;
  if (result.components.financialSignificance < RELATIONSHIP_VISIBILITY_MATERIALITY_FLOOR) return null;

  return {
    situationType: "relationship_visibility",
    disposition: "KNOW",
    priorityTier: 3,
    priorityOrder: 6,
    headline: "Limited current relationship context on a significant relationship",
    // Rule E, enforced structurally by using this exact fixed phrase --
    // never "this relationship is weak."
    explanation: `${fmtCents(donor.lifetimeCents)} lifetime giving, but FOS has limited recent relationship context on this donor.`,
    whyNow: "A large financial relationship with thin current context is easy to overlook -- this is a gap in FOS's knowledge, not a judgment about the relationship.",
    whatFosDoesNotKnow: "No current relationship fact and no recent substantive contact is on file for this donor.",
    possibleAction: null,
    confidence: "limited",
    evidence: [{ kind: "portfolio_focus_confidence", detail: `relationshipConfidence: low, financialSignificance percentile: ${result.components.financialSignificance.toFixed(2)}` }],
  };
}

const UPCOMING_MOMENT_MATERIALITY_FLOOR = 0.5;

function detectUpcomingMoment(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): DetectedSignal | null {
  if (!donor.upcomingDateDescription) return null;
  if (result.components.financialSignificance < UPCOMING_MOMENT_MATERIALITY_FLOOR) return null; // rule C: a date alone, on an immaterial donor, is noise

  return {
    situationType: "upcoming_moment",
    disposition: "DO",
    priorityTier: 3,
    priorityOrder: 7,
    headline: "Meaningful date approaching",
    explanation: `${donor.upcomingDateDescription}, on a financially significant relationship.`,
    whyNow: "Worth having on hand before reaching out, on a relationship that matters.",
    whatFosDoesNotKnow: null,
    possibleAction: "Consider a brief personal note around this date.",
    confidence: "medium",
    evidence: [{ kind: "upcoming_date", detail: donor.upcomingDateDescription }],
  };
}

export function detectSituations(
  donor: PortfolioFocusDonorInput,
  result: PortfolioFocusResult,
  asks: RawAskRow[],
  facts: RawRelationshipFactRow[],
  now: number,
): DetectedSignal[] {
  // Rule D: a historically-true solicitation-category fact must never be
  // treated as a live opportunity when the donor's most recent Ask is
  // already declined/withdrawn -- Phase 1 does not build a standalone
  // "narrative opportunity" detector at all (see file header + design
  // doc §8's "no invented fundraising opportunity" principle), so this
  // is enforced simply by never reading solicitation-category fact text
  // as evidence for anything other than ask_resolution above, which
  // reads real Ask status directly rather than narrative text.
  const signals = [
    detectExplicitFollowUp(donor, facts),
    detectAskResolution(asks, now),
    detectPledgeFollowUp(donor, result),
    detectCommitmentProgress(donor, result),
    detectStewardshipMoment(donor, result, facts),
    detectFinancialChange(donor, result),
    detectRecentMeaningfulGift(donor),
    detectRelationshipVisibility(donor, result),
    detectUpcomingMoment(donor, result),
  ];
  return signals.filter((s): s is DetectedSignal => s !== null);
}
