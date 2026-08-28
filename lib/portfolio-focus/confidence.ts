// Portfolio Focus -- confidence assessment (Round 2/3, kept OUTSIDE the
// composite score per explicit instruction throughout every calibration
// round: missing data must never silently become a negative signal).
// Two independent axes so a fundraiser can distinguish "high priority
// with strong evidence" from "potentially important but poorly
// documented" -- see docs/PORTFOLIO-FOCUS-CALIBRATION.md Section 13/
// docs/PORTFOLIO-FOCUS-CALIBRATION-V2.md Section 13.
import type { ConfidenceLevel, PortfolioFocusDonorInput } from "./types.ts";

export function computeFinancialConfidence(input: Pick<PortfolioFocusDonorInput, "distinctActivityYears">): ConfidenceLevel {
  if (input.distinctActivityYears >= 3) return "high";
  if (input.distinctActivityYears >= 1) return "medium";
  return "low";
}

export function computeRelationshipConfidence(
  input: Pick<PortfolioFocusDonorInput, "lastInteractionDaysAgo" | "hasCurrentFact" | "askHistoryCount" | "hasUnconfirmedHistoricalContext">,
): ConfidenceLevel {
  if (input.lastInteractionDaysAgo != null || input.hasCurrentFact || input.askHistoryCount > 0) return "high";
  if (input.hasUnconfirmedHistoricalContext) return "medium";
  return "low";
}
