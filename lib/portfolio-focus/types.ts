// Portfolio Focus -- shared types (Phase 1 implementation, 2026-08-28).
// Implements the model FROZEN in docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md.
// Do not add fields here that the calibrated model doesn't use --
// this module answers "where should limited fundraising attention go
// over the next 30 days," not a general donor-summary shape (that's
// already lib/relationships/meeting-brief-model.ts's job).

export type MomentumLabel =
  | "actively_fulfilling_commitment"
  | "dormant_lapsed"
  | "newly_significant"
  | "increasing"
  | "declining"
  | "noisy_swing"
  | "stable"
  | "insufficient_data"
  | "no_giving_history";

// Round 3 Calibration Section 11 / Investigation Section 5: distinguishes
// a currently-collectible pledge from a legacy balance needing
// verification from a strategically immaterial bookkeeping artifact.
// Never touches the pledge row itself -- purely a strategic read.
export type PledgeStaleClass = "current" | "legacy_needs_verification" | "immaterial_artifact" | null;

export type ConfidenceLevel = "high" | "medium" | "low";

// Round 3 Section 9 (labeling correction applied in this implementation
// per the user's Phase 1 instruction): the smallest vocabulary that
// accurately represents the calibrated model. Every value must be
// traceable to the evidence that produced it -- see attention-type.ts.
export type AttentionType =
  | "solicit_scheduled"
  | "cultivate_steward_active"
  | "steward_active_fulfillment"
  | "reconnect_understand_decline"
  | "cultivate_real_growth"
  | "learn_relationship_review"
  | "coverage_needed"
  | "monitor_routine";

// The aggregation layer's output for one donor -- already-resolved,
// already-dated evidence, no D1 shapes leak past this boundary. Built by
// lib/portfolio-focus/aggregate.ts from raw D1 rows (lib/portfolio-focus/data.ts)
// using the SAME canonical financial reconstruction and the SAME real
// production functions (buildRecommendationEvidence, buildDonorRecommendation,
// resolveOpenPledgeActivityDate, evaluatePaymentPlan, resolveRelationshipSnapshot,
// findMostActionableFact) as every other surface in this codebase --
// never a second, competing financial truth model.
export type PortfolioFocusDonorInput = {
  donorId: string;
  displayName: string;
  donorCode: string | null;

  // Financial -- category-agnostic, per the audited model (gift +
  // audited pledge payments + past-dated unaudited remainder).
  lifetimeCents: number;
  last365Cents: number;
  prior365Cents: number;
  distinctActivityYears: number;
  historicalPeakGiftCents: number | null;
  historicalPeakCommitmentCents: number | null;
  mostRecentCashKind: "gift" | "pledge_payment" | null;
  mostRecentCashCents: number | null;
  daysSinceLastGift: number | null;

  // Open pledge -- resolveOpenPledgeActivityDate/evaluatePaymentPlan
  // already applied by the aggregation layer.
  openPledgeBalanceCents: number | null;
  openPledgeTotalCents: number | null;
  openPledgeCategory: "open_pledge" | "partially_paid_pledge" | null;
  pledgeAgeDays: number | null; // last-activity recency (tactical basis)
  pledgeCommitmentAgeDays: number | null; // real commitment-date recency, only when known (strategic "is this new" basis)
  pledgePlanOnTrack: boolean | null; // null = no active plan

  // Relationship
  askHistoryCount: number;
  hasOpenReminder: boolean;
  openReminderAction: string | null;
  lastInteractionDaysAgo: number | null; // null = never any interaction
  daysSinceSubstantiveContact: number | null; // null = never (or only broadcast-role contact)
  hasCurrentFact: boolean;
  hasActionableFact: boolean; // findMostActionableFact (engagement OR solicitation category) is non-null
  hasUnconfirmedHistoricalContext: boolean; // any donor_historical_context row -- confidence's "medium" relationship tier only, never scored
  currentSnapshotSummary: string | null; // resolveRelationshipSnapshot's live-or-cached summary, for display/explanation only -- never scored
  upcomingDateDescription: string | null; // e.g. "birthday in 6 days" -- for explanation only

  // Tactical Urgency input -- computed by the aggregation layer via the
  // REAL, unmodified Recommendation Engine (buildRecommendationEvidence +
  // buildDonorRecommendation). Portfolio Focus never recomputes this.
  // Round 3's own formula never reads Suggested-pool membership (only
  // the real recommendation kind/score) -- computing pool membership
  // requires additional, unrelated inputs (narrative-donor-id sets,
  // contact-gap candidate lists) that would add plumbing with no effect
  // on any score. Deliberately out of scope for the composite; a future
  // surface wanting "is this donor also in Suggested today" can compute
  // it independently via lib/workspace/suggestion-candidates.ts.
  recommendation: { kind: string; score: number; action: string } | null;
};

// Portfolio-wide percentile bases -- built once per scoring run from
// every donor's input (lib/portfolio-focus/context.ts), never
// recomputed per-donor. All FS/OPP/STEW/MOM percentile terms read from
// this shared context so a single scoring pass has one consistent view
// of "large relative to the rest of the portfolio."
export type PortfolioFocusContext = {
  lifetimeValuesPositive: number[];
  historicalPeaksPositive: number[];
  distinctYearsPositive: number[];
  financialEventAmounts: number[]; // every completed-gift amount + every pledge total, portfolio-wide
  deltaAbsValues: number[]; // |last365 - prior365| for every donor with prior365 > 0
};

export type PortfolioFocusComponents = {
  financialSignificance: number;
  opportunity: number;
  stewardship: number;
  momentum: number;
  tacticalUrgency: number;
};

export type PortfolioFocusEvidence = {
  lifetimeCents: number;
  last365Cents: number;
  prior365Cents: number;
  openPledgeBalanceCents: number | null;
  openPledgeTotalCents: number | null;
  pledgeStaleClass: PledgeStaleClass;
  mostRecentCashCents: number | null;
  mostRecentCashKind: "gift" | "pledge_payment" | null;
  daysSinceLastGift: number | null;
  daysSinceSubstantiveContact: number | null;
  hasCurrentFact: boolean;
  hasOpenReminder: boolean;
  openReminderAction: string | null;
  currentSnapshotSummary: string | null;
  upcomingDateDescription: string | null;
  recommendationKind: string | null;
  recommendationScore: number | null;
  // The real Recommendation Engine's own action text (same
  // buildDonorRecommendation() call already made once during
  // aggregation for Tactical Urgency -- never re-run, never a second
  // computation) -- for display/explanation only, per this type's own
  // convention (see currentSnapshotSummary/upcomingDateDescription
  // above). Phase 2B's Suggested Action cross-reference (docs/
  // PORTFOLIO-FOCUS-UX-DESIGN.md Section 7F) reads this instead of
  // re-deriving or inventing a tactical action.
  recommendationAction: string | null;
};

export type PortfolioFocusResult = {
  donorId: string;
  displayName: string;
  donorCode: string | null;
  rank: number;
  compositeScore: number;
  baseComposite: number;
  components: PortfolioFocusComponents;
  momentumLabel: MomentumLabel;
  pledgeStaleClass: PledgeStaleClass;
  coverage: number;
  coverageFloor: number;
  coverageTriggered: boolean;
  financialConfidence: ConfidenceLevel;
  relationshipConfidence: ConfidenceLevel;
  attentionType: AttentionType;
  whyNow: string;
  evidence: PortfolioFocusEvidence;
};
