// Portfolio Focus -- Phase 1 public API (2026-08-28).
//
// Answers: "Given everything Fundraising OS knows, where should limited
// fundraising attention go over the next 30 days?" -- a STRATEGIC,
// portfolio-relative layer, never a replacement for Suggested Actions/
// the Recommendation Engine (which answers "what's the best next action
// for this donor," a different question -- see
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md Section 1/10 and the
// Investigation's own framing).
//
// This module implements the model FROZEN in
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md exactly, with the one approved
// attention-type labeling correction (Section 9) applied. No weight,
// threshold, or formula here should ever be adjusted without a new,
// documented calibration round -- see docs/PORTFOLIO-FOCUS-CALIBRATION*.md
// for the full reasoning history.
//
// Read-only: no D1 write exists anywhere in this module. No UI
// assumptions. No Recommendation Engine or Relationship Intelligence
// modification -- both are consumed via their own real, unmodified
// exports.
import { loadPortfolioFocusRawData } from "./data.ts";
import { aggregatePortfolioFocusInputs } from "./aggregate.ts";
import { buildPortfolioContext } from "./context.ts";
import { scorePortfolioFocus } from "./score.ts";
import type { PortfolioFocusResult } from "./types.ts";

export async function computePortfolioFocus(userId: string, timezone: string, now: number): Promise<PortfolioFocusResult[]> {
  const raw = await loadPortfolioFocusRawData(userId);
  const { donorInputs, financialEventAmounts } = aggregatePortfolioFocusInputs(raw, now, timezone);
  const ctx = buildPortfolioContext(donorInputs, financialEventAmounts);
  return scorePortfolioFocus(donorInputs, ctx);
}

export * from "./types.ts";
export { aggregatePortfolioFocusInputs } from "./aggregate.ts";
export { buildPortfolioContext } from "./context.ts";
export { scorePortfolioFocus, scorePortfolioFocusDonor, ATTENTION_TYPE_LABELS } from "./score.ts";
export { classifyPledgeStaleness, pledgeRecencyDays } from "./stale-balance.ts";
export { absoluteMateriality, materiality, recencyDecay } from "./materiality.ts";
export { computeCoverage, computeCoverageFloor, computeFinancialSignificance, computeMomentum, computeOpportunity, computeStewardship, computeTacticalUrgency } from "./components.ts";
export { computeFinancialConfidence, computeRelationshipConfidence } from "./confidence.ts";
export { resolveAttentionType } from "./attention-type.ts";
