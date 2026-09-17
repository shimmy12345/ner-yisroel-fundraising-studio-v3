// Fundraising Intelligence Brief -- Phase 1 (computation only). See
// docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md for the investigation
// this implements, and docs/FUNDRAISING-INTELLIGENCE-BRIEF-PHASE1-
// CALIBRATION.md for the real-data run this was calibrated against.
//
// This module is a pure, in-memory SELECTION/SYNTHESIS layer over
// Portfolio Focus's already-computed output (lib/portfolio-focus/*.ts).
// It introduces ZERO new D1 queries, ZERO new weighted composite score,
// and ZERO schema. Every field here is DERIVED from existing donor
// evidence -- there is no field a fundraiser must maintain.

// Not every insight is an action -- KNOW_DO exists but must stay rare
// (see combineDisposition() in synthesize.ts, the only place it is
// produced, and only for two named, deliberately narrow combinations).
export type BriefDisposition = "KNOW" | "DO" | "KNOW_DO";

// Minimal, stable taxonomy -- each value maps to one independent,
// evidence-based detector in situations.ts. Never extended purely for
// display; a new value here must correspond to a new, real detection
// rule.
export type SituationType =
  | "explicit_follow_up"
  | "stewardship_moment"
  | "commitment_progress"
  | "pledge_follow_up"
  | "financial_change"
  | "relationship_visibility"
  | "ask_resolution"
  | "upcoming_moment";

// Describes FOS's KNOWLEDGE, never the relationship itself (see
// text-safety.ts's banned-phrase guard, which enforces this at runtime).
export type ConfidenceLevel = "high" | "medium" | "limited";

export type BriefEvidenceRef = {
  // Which underlying record/engine this evidence came from -- for
  // calibration auditing (§18), never for end-user copy.
  kind:
    | "open_reminder"
    | "relationship_fact"
    | "ask"
    | "pledge_plan"
    | "pledge_balance"
    | "momentum"
    | "cash_event"
    | "portfolio_focus_confidence"
    | "upcoming_date"
    | "recommendation_engine";
  // Human-readable, no raw scores.
  detail: string;
};

// Debug-only fields. Never rendered in end-user UX (§15/§28) -- exists
// purely so the calibration formatter (scripts/fundraising-intelligence-
// calibration.mjs) can audit why an item was included/excluded without
// re-deriving anything.
export type BriefDebugInfo = {
  portfolioFocusRank: number;
  compositeScore: number;
  financialSignificance: number;
  recommendationKind: string | null;
  recommendationScore: number | null;
  priorityTier: 1 | 2 | 3 | null;
};

// One unified shape for both included Brief items and rejected/
// suppressed candidates (§6's field list explicitly includes
// suppressionReason "if a candidate was rejected during debug/
// calibration mode") -- `included` distinguishes the two.
export type FundraisingIntelligenceCandidate = {
  donorId: string;
  displayName: string;
  disposition: BriefDisposition;
  situationType: SituationType | "none";
  headline: string;
  explanation: string; // WHAT FOS knows
  whyNow: string;
  whatFosDoesNotKnow: string | null; // WHAT FOS does NOT know, if material
  possibleAction: string | null; // WHAT MAY BE WORTH DOING, only if genuinely supported
  confidence: ConfidenceLevel;
  sourceSignals: BriefEvidenceRef[];
  included: boolean;
  suppressionReason: string | null;
  debug: BriefDebugInfo;
};

export type FundraisingIntelligenceBriefResult = {
  items: FundraisingIntelligenceCandidate[]; // included === true, deterministically ordered, length 0-15
  rejected: FundraisingIntelligenceCandidate[]; // included === false -- every donor who triggered at least one detector but did not make the cut, or whose only signal was hard-suppressed
  computedAt: number;
  donorCount: number;
  suppressionReasonCounts: Record<string, number>;
  dispositionCounts: Record<BriefDisposition, number>;
  situationTypeCounts: Record<string, number>;
};
