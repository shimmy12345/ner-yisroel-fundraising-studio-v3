// Portfolio Focus -- attention-type resolver (Round 3, WITH the
// labeling correction approved for Phase 1 implementation -- see
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md Section 9, Case 3).
//
// The smallest vocabulary that accurately represents the calibrated
// model (Investigation item 10: focus != solicitation). Every value is
// deterministically traceable to the evidence that produced it -- this
// function reads only already-computed components/labels, never
// re-derives evidence itself.
import type { AttentionType, MomentumLabel, PortfolioFocusComponents, PortfolioFocusDonorInput } from "./types.ts";

// Labeling-fix criterion (Round 3 Section 9): "zero documented
// relationship interaction/history" for THIS decision means no
// interaction ever, no current Relationship Fact, and no Ask history --
// deliberately NOT relaxed by the mere presence of unconfirmed imported
// historical context (which already earns a donor "medium" relationship
// confidence elsewhere, but is not a real, verified relationship thread
// to describe as "cultivate"). This is why the check below is its own
// function rather than reusing computeRelationshipConfidence()'s
// three-tier result -- the two questions ("how confident are we" vs.
// "is there a real thread to build on") are related but not identical.
function hasNoRealRelationshipHistory(input: Pick<PortfolioFocusDonorInput, "lastInteractionDaysAgo" | "hasCurrentFact" | "askHistoryCount">): boolean {
  return input.lastInteractionDaysAgo == null && !input.hasCurrentFact && input.askHistoryCount === 0;
}

export function resolveAttentionType(
  input: Pick<PortfolioFocusDonorInput, "hasOpenReminder" | "pledgePlanOnTrack" | "lastInteractionDaysAgo" | "hasCurrentFact" | "askHistoryCount">,
  components: PortfolioFocusComponents,
  momentumLabel: MomentumLabel,
  coverageTriggered: boolean,
): AttentionType {
  if (coverageTriggered) return "coverage_needed";
  // An explicit, already-scheduled fundraiser commitment always wins --
  // honoring a real plan is never in tension with any other reading.
  if (input.hasOpenReminder) return "solicit_scheduled";
  if (components.opportunity >= 0.4) return "cultivate_steward_active";
  if (input.pledgePlanOnTrack === true) return "steward_active_fulfillment";
  if (momentumLabel === "declining" && components.financialSignificance > 0.6) return "reconnect_understand_decline";
  if (momentumLabel === "increasing" || momentumLabel === "newly_significant") {
    // THE FIX: a real dollar increase does not, by itself, mean there is
    // a relationship thread to "cultivate" -- if nothing has ever been
    // documented about this relationship, the honest next step is to
    // learn/review it, not to imply a cultivation plan already exists.
    if (hasNoRealRelationshipHistory(input) && components.financialSignificance > 0.6) return "learn_relationship_review";
    return "cultivate_real_growth";
  }
  if (components.financialSignificance > 0.6) return "learn_relationship_review";
  return "monitor_routine";
}

// Human-readable label for each attention type -- kept alongside the
// resolver so every consumer (tests, future UI/Assistant surfaces)
// renders identical wording, never re-deriving copy independently.
export const ATTENTION_TYPE_LABELS: Record<AttentionType, string> = {
  solicit_scheduled: "Solicit (honor scheduled commitment)",
  cultivate_steward_active: "Cultivate/steward (active commitment)",
  steward_active_fulfillment: "Steward (active fulfillment)",
  reconnect_understand_decline: "Reconnect/understand (real decline)",
  cultivate_real_growth: "Cultivate (real growth)",
  learn_relationship_review: "Learn / relationship review",
  coverage_needed: "Relationship coverage needed (learn/review)",
  monitor_routine: "Monitor (routine)",
};
