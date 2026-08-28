// Portfolio Focus -- dedicated-view presentation adapter (Phase 2B,
// 2026-08-28). Pure, read-only, no D1 access (no import of ./index.ts
// or ./data.ts) -- translates the engine's own already-computed
// PortfolioFocusResult into fundraiser language for the dedicated
// /portfolio-focus view. Reuses Phase 2A's attention-type display
// vocabulary and why-now formatter (./today-view.ts) rather than
// creating a second, competing mapping -- see docs/PORTFOLIO-FOCUS-UX-
// DESIGN.md Section 8.
//
// This file never re-derives a score, rank, or attention type, and
// never invents a fact -- every sentence below is built only from a
// PortfolioFocusResult's own fields (components, evidence, confidence,
// coverage). Component-value thresholds here (e.g. "financially
// significant" at FS>=0.85) are PRESENTATION buckets for translating an
// already-frozen number into a sentence -- they have no effect on any
// score, rank, or composite, and are not a calibration threshold.
import type { AttentionType, ConfidenceLevel, PortfolioFocusEvidence, PortfolioFocusResult } from "./types.ts";
import { ATTENTION_TYPE_DISPLAY_LABELS, formatPortfolioFocusWhyNow } from "./today-view.ts";

export { ATTENTION_TYPE_DISPLAY_LABELS };

function fmt(cents: number | null): string {
  if (cents == null) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

// Relationship-context vocabulary (docs/PORTFOLIO-FOCUS-UX-DESIGN.md
// Section 9) -- restrained, never implies an error or a weak
// relationship. Driven by relationshipConfidence, the axis specifically
// about "how much does Fundraising OS actually know about this
// relationship" -- never by score, never by financial confidence.
export const RELATIONSHIP_CONTEXT_LABELS: Record<ConfidenceLevel, string> = {
  high: "Well documented",
  medium: "Some context",
  low: "Limited relationship context",
};

// ---- Filters (docs/PORTFOLIO-FOCUS-UX-DESIGN.md Section 6/17) ----
// Grouped by DISPLAY label, not raw enum: coverage_needed and
// learn_relationship_review share one filter chip, matching the single
// display label they already share (Section 8) -- the internal
// distinction stays intact in `attentionType`/the explanation layer.
export type PortfolioFocusFilterId =
  | "all" | "solicit_scheduled" | "cultivate_steward_active" | "steward_active_fulfillment"
  | "cultivate_real_growth" | "reconnect_understand_decline" | "relationship_review";

export const PORTFOLIO_FOCUS_FILTERS: ReadonlyArray<{ id: PortfolioFocusFilterId; label: string; matches: (attentionType: AttentionType) => boolean }> = [
  { id: "all", label: "All", matches: () => true },
  { id: "solicit_scheduled", label: "Solicitation Opportunity", matches: (t) => t === "solicit_scheduled" },
  { id: "cultivate_steward_active", label: "Cultivate & Steward", matches: (t) => t === "cultivate_steward_active" },
  { id: "steward_active_fulfillment", label: "Active Stewardship", matches: (t) => t === "steward_active_fulfillment" },
  { id: "cultivate_real_growth", label: "Cultivate", matches: (t) => t === "cultivate_real_growth" },
  { id: "reconnect_understand_decline", label: "Reconnect", matches: (t) => t === "reconnect_understand_decline" },
  { id: "relationship_review", label: "Relationship Review", matches: (t) => t === "coverage_needed" || t === "learn_relationship_review" },
];

function isRelationshipReviewType(attentionType: AttentionType): boolean {
  return attentionType === "coverage_needed" || attentionType === "learn_relationship_review";
}

// ---- A. Why now (lede) ----
// Reuses the engine's own whyNow sentence verbatim (never rewritten or
// re-derived) and, for the Relationship Review cases specifically,
// appends one explicit, mandatory clarifying sentence -- Fundraising
// OS's largest and quietest relationships must never read as a
// solicitation cue.
function buildLede(result: PortfolioFocusResult): string {
  const whyNow = formatFullWhyNow(result);
  if (isRelationshipReviewType(result.attentionType)) {
    return `${whyNow} This is a relationship-review signal, not a solicitation recommendation.`;
  }
  return whyNow;
}

// The expanded lede uses the engine's own full whyNow sentence (richer
// than the Today card's compact one-liner) -- still zero recomputation,
// same PortfolioFocusResult.whyNow field, just not the Today-specific
// abbreviation.
function formatFullWhyNow(result: PortfolioFocusResult): string {
  return result.whyNow;
}

// ---- B. Financial significance ----
function explainFinancialSignificance(result: PortfolioFocusResult): string {
  const fs = result.components.financialSignificance;
  const lifetime = fmt(result.evidence.lifetimeCents);
  if (fs >= 0.85) return `Among the most significant relationships in your entire portfolio -- ${lifetime} given to date.`;
  if (fs >= 0.55) return `A well-established, meaningful relationship -- ${lifetime} given to date.`;
  return `A meaningful but smaller relationship relative to the rest of your portfolio -- ${lifetime} given to date.`;
}

// ---- C. Opportunity ----
function explainOpportunity(result: PortfolioFocusResult): string {
  const { attentionType, evidence } = result;
  switch (attentionType) {
    case "solicit_scheduled":
      return evidence.openReminderAction ? `Explicit scheduled solicitation follow-up: ${evidence.openReminderAction}.` : "Explicit scheduled solicitation follow-up on file.";
    case "cultivate_steward_active":
      return evidence.openPledgeTotalCents ? `Recent, significant commitment currently active -- ${fmt(evidence.openPledgeTotalCents)}.` : "A current, actionable relationship signal, though not yet a specific dollar commitment.";
    case "steward_active_fulfillment":
      return "An existing commitment is already being fulfilled -- not a new solicitation opportunity.";
    case "coverage_needed":
    case "learn_relationship_review":
      return "No current solicitation opportunity identified -- this is a call to learn more, not to ask.";
    case "reconnect_understand_decline":
      return "No current solicitation opportunity identified -- understanding the recent decline comes before any ask.";
    case "cultivate_real_growth":
      return "No explicit solicitation opportunity on file yet, though real growth may make a cultivation conversation timely.";
    case "monitor_routine":
    default:
      return "No current solicitation opportunity identified.";
  }
}

// ---- D. Stewardship ----
function explainStewardship(result: PortfolioFocusResult): string {
  const { attentionType, evidence } = result;
  if (attentionType === "steward_active_fulfillment") {
    return `Commitment is actively being fulfilled -- ${fmt(evidence.openPledgeBalanceCents)} remaining of ${fmt(evidence.openPledgeTotalCents)}, on schedule.`;
  }
  if (attentionType === "cultivate_steward_active" && evidence.openPledgeTotalCents) {
    return "A recent, significant commitment merits active stewardship attention.";
  }
  return "No active stewardship signal on file right now.";
}

// ---- E. Relationship visibility ----
function explainRelationshipVisibility(result: PortfolioFocusResult): string {
  const { relationshipConfidence, evidence } = result;
  if (relationshipConfidence === "low") return "Fundraising OS has limited current relationship information for this significant relationship.";
  if (relationshipConfidence === "medium") return "Some relationship context is on file, though not recent substantive contact.";
  return evidence.currentSnapshotSummary
    ? `Recent, substantive relationship information is documented: ${evidence.currentSnapshotSummary}`
    : "Recent, substantive relationship information is documented.";
}

// ---- F. Tactical cross-reference ----
// Never invents an action -- reads the SAME real Recommendation Engine
// result already computed once during aggregation (recommendationAction,
// evidence.recommendationKind), never re-runs it, never a second query.
function explainTactical(evidence: PortfolioFocusEvidence): string {
  return hasFlaggableSuggestedAction(evidence) ? `Suggested Action: ${evidence.recommendationAction}` : "No urgent Suggested Action on file.";
}

// `reconnect_contact_gap` is the Recommendation Engine's generic, bounded
// "it's been a while" fallback (see lib/workspace/suggestion-candidates.ts's
// own documentation: it scales with total donor count, unlike every other
// kind, which is driven by a real, specific, rare event -- a pledge, a
// scheduled reminder, a documented cultivation opportunity). On real
// Independent Staging data it fires for ~80% of the portfolio, so
// treating it as "a Suggested Action worth flagging" here would make the
// indicator meaningless noise rather than the "restrained," genuinely
// informative signal item 6/14/19 ask for. Excluding it is a
// PRESENTATION judgment about what's worth flagging in this UI, not a
// change to the Recommendation Engine itself or to Tactical Urgency's
// own composite math (which still uses the real score/kind untouched).
function hasFlaggableSuggestedAction(evidence: PortfolioFocusEvidence): boolean {
  return evidence.recommendationKind !== null && evidence.recommendationKind !== "reconnect_contact_gap" && evidence.recommendationAction !== null;
}

// ---- G. Confidence / context ----
function explainConfidence(result: PortfolioFocusResult): string {
  const { financialConfidence, relationshipConfidence } = result;
  if (relationshipConfidence === "low") {
    return `Financial history here is ${financialConfidence === "high" ? "well established" : "reasonably clear"}; current relationship context is limited -- this read leans on giving history more than recent conversation.`;
  }
  if (relationshipConfidence === "medium") return "Some relationship context exists, though not recent substantive contact -- this read is reasonably well supported.";
  return "Both financial history and relationship context are well documented -- this is a well-supported strategic read.";
}

export type PortfolioFocusExplanation = {
  lede: string;
  financialSignificance: string;
  opportunity: string;
  stewardship: string;
  relationshipVisibility: string;
  confidence: string;
  tactical: string;
};

function buildExplanation(result: PortfolioFocusResult): PortfolioFocusExplanation {
  return {
    lede: buildLede(result),
    financialSignificance: explainFinancialSignificance(result),
    opportunity: explainOpportunity(result),
    stewardship: explainStewardship(result),
    relationshipVisibility: explainRelationshipVisibility(result),
    confidence: explainConfidence(result),
    tactical: explainTactical(result.evidence),
  };
}

// ---- Technical detail (debug/audit layer only -- items 23/24) ----
export type PortfolioFocusTechnicalDetail = {
  compositeScore: number;
  baseComposite: number;
  financialSignificance: number;
  opportunity: number;
  stewardship: number;
  momentum: number;
  momentumLabel: string;
  tacticalUrgency: number;
  coverage: number;
  coverageFloor: number;
  coverageTriggered: boolean;
  financialConfidence: ConfidenceLevel;
  relationshipConfidence: ConfidenceLevel;
  pledgeStaleClass: string | null;
};

function buildTechnicalDetail(result: PortfolioFocusResult): PortfolioFocusTechnicalDetail {
  return {
    compositeScore: result.compositeScore,
    baseComposite: result.baseComposite,
    financialSignificance: result.components.financialSignificance,
    opportunity: result.components.opportunity,
    stewardship: result.components.stewardship,
    momentum: result.components.momentum,
    momentumLabel: result.momentumLabel,
    tacticalUrgency: result.components.tacticalUrgency,
    coverage: result.coverage,
    coverageFloor: result.coverageFloor,
    coverageTriggered: result.coverageTriggered,
    financialConfidence: result.financialConfidence,
    relationshipConfidence: result.relationshipConfidence,
    pledgeStaleClass: result.pledgeStaleClass,
  };
}

export type DedicatedPortfolioFocusRow = {
  donorId: string;
  rank: number;
  displayName: string;
  donorCode: string | null;
  attentionType: AttentionType;
  attentionLabel: string;
  whyNow: string;
  contextLevel: ConfidenceLevel;
  contextLabel: string;
  hasSuggestedAction: boolean;
  explanation: PortfolioFocusExplanation;
  technical: PortfolioFocusTechnicalDetail;
};

// Builds one row per engine result, in the engine's own order (index 0
// = rank 1) -- no re-sorting, no curation, no donor-specific special
// case of any kind. Rank is always the donor's TRUE portfolio-wide rank
// (from the full scored array), even when the caller later slices or
// filters this list for display -- filtering must never renumber
// (docs/PORTFOLIO-FOCUS-UX-DESIGN.md's own principle, carried into
// Phase 2B): a filtered view of ranks 3/5/12 must still read #3/#5/#12.
export function buildDedicatedPortfolioFocusRows(results: readonly PortfolioFocusResult[]): DedicatedPortfolioFocusRow[] {
  return results.map((result) => ({
    donorId: result.donorId,
    rank: result.rank,
    displayName: result.displayName,
    donorCode: result.donorCode,
    attentionType: result.attentionType,
    attentionLabel: ATTENTION_TYPE_DISPLAY_LABELS[result.attentionType],
    whyNow: formatPortfolioFocusWhyNow(result.attentionType, result.evidence),
    contextLevel: result.relationshipConfidence,
    contextLabel: RELATIONSHIP_CONTEXT_LABELS[result.relationshipConfidence],
    hasSuggestedAction: hasFlaggableSuggestedAction(result.evidence),
    explanation: buildExplanation(result),
    technical: buildTechnicalDetail(result),
  }));
}
