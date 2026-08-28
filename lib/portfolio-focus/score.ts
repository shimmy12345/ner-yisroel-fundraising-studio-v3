// Portfolio Focus -- top-level scoring orchestrator. Implements the
// FROZEN Round 3 composite exactly as documented in
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md ("Exact frozen Round 3
// formula"), with the Section 9 attention-type labeling correction
// applied (score/rank are unaffected by that correction -- it only
// changes which word describes the result).
import type { PortfolioFocusContext, PortfolioFocusDonorInput, PortfolioFocusEvidence, PortfolioFocusResult } from "./types.ts";
import { computeCoverage, computeCoverageFloor, computeFinancialSignificance, computeMomentum, computeOpportunity, computeStewardship, computeTacticalUrgency } from "./components.ts";
import { classifyPledgeStaleness } from "./stale-balance.ts";
import { computeFinancialConfidence, computeRelationshipConfidence } from "./confidence.ts";
import { resolveAttentionType, ATTENTION_TYPE_LABELS } from "./attention-type.ts";
import type { AttentionType } from "./types.ts";

function fmtCents(cents: number | null): string {
  if (cents == null) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function buildWhyNow(input: PortfolioFocusDonorInput, attentionType: AttentionType, staleClass: ReturnType<typeof classifyPledgeStaleness>): string {
  switch (attentionType) {
    case "coverage_needed":
      return `${fmtCents(input.lifetimeCents)} lifetime relationship with little or no documented interaction, Relationship Fact, or Ask history -- Fundraising OS has limited visibility into what is currently happening here.`;
    case "solicit_scheduled":
      return `An explicit fundraiser follow-up is already scheduled: "${input.openReminderAction}".`;
    case "cultivate_steward_active":
      if (input.openPledgeTotalCents && staleClass === "current") {
        const ageDays = input.pledgeCommitmentAgeDays ?? input.pledgeAgeDays;
        return `A ${fmtCents(input.openPledgeTotalCents)} commitment${ageDays != null ? `, ${ageDays} days old` : ""}, currently active.`;
      }
      return `A current, actionable relationship signal with recent substantive contact.`;
    case "steward_active_fulfillment":
      return `An active, on-track pledge -- ${fmtCents(input.openPledgeBalanceCents)} remaining of ${fmtCents(input.openPledgeTotalCents)} -- being fulfilled on schedule.`;
    case "reconnect_understand_decline":
      return `Giving fell from ${fmtCents(input.prior365Cents)} to ${fmtCents(input.last365Cents)} year-over-year on a financially significant relationship.`;
    case "cultivate_real_growth":
      return `Real, dated growth in giving: ${fmtCents(input.prior365Cents)} to ${fmtCents(input.last365Cents)} year-over-year.`;
    case "learn_relationship_review":
      return `A financially significant relationship (${fmtCents(input.lifetimeCents)} lifetime) with limited current relationship documentation.`;
    case "monitor_routine":
    default:
      return `No significant financial or relationship signal this period.`;
  }
}

function buildEvidence(input: PortfolioFocusDonorInput, staleClass: ReturnType<typeof classifyPledgeStaleness>): PortfolioFocusEvidence {
  return {
    lifetimeCents: input.lifetimeCents,
    last365Cents: input.last365Cents,
    prior365Cents: input.prior365Cents,
    openPledgeBalanceCents: input.openPledgeBalanceCents,
    openPledgeTotalCents: input.openPledgeTotalCents,
    pledgeStaleClass: staleClass,
    mostRecentCashCents: input.mostRecentCashCents,
    mostRecentCashKind: input.mostRecentCashKind,
    daysSinceLastGift: input.daysSinceLastGift,
    daysSinceSubstantiveContact: input.daysSinceSubstantiveContact,
    hasCurrentFact: input.hasCurrentFact,
    hasOpenReminder: input.hasOpenReminder,
    openReminderAction: input.openReminderAction,
    currentSnapshotSummary: input.currentSnapshotSummary,
    upcomingDateDescription: input.upcomingDateDescription,
    recommendationKind: input.recommendation?.kind ?? null,
    recommendationScore: input.recommendation?.score ?? null,
    recommendationAction: input.recommendation?.action ?? null,
  };
}

// Scores one donor. Pure -- rank is assigned by scorePortfolioFocus()
// below, after sorting the whole batch, never by this function.
export function scorePortfolioFocusDonor(input: PortfolioFocusDonorInput, ctx: PortfolioFocusContext): Omit<PortfolioFocusResult, "rank"> {
  const staleClass = classifyPledgeStaleness(input);
  const financialSignificance = computeFinancialSignificance(input, ctx);
  const opportunity = computeOpportunity(input, ctx, staleClass);
  const stewardship = computeStewardship(input, ctx, staleClass);
  const { label: momentumLabel, signal: momentumSignal } = computeMomentum(input, ctx);
  const tacticalUrgency = computeTacticalUrgency(input, staleClass);

  // Composite = 0.35 FS + 0.30 OPP + 0.20 STEW + 0.10 MOM + 0.05 TAC --
  // NO WEIGHT MAY CHANGE (frozen, per docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md).
  const baseComposite = 0.35 * financialSignificance + 0.30 * opportunity + 0.20 * stewardship + 0.10 * momentumSignal + 0.05 * tacticalUrgency;

  const coverage = computeCoverage(input, financialSignificance);
  const coverageFloor = computeCoverageFloor(coverage);
  const coverageTriggered = coverageFloor > baseComposite;
  const compositeScore = Math.max(baseComposite, coverageFloor);

  const financialConfidence = computeFinancialConfidence(input);
  const relationshipConfidence = computeRelationshipConfidence(input);

  const components = { financialSignificance, opportunity, stewardship, momentum: momentumSignal, tacticalUrgency };
  const attentionType = resolveAttentionType(input, components, momentumLabel, coverageTriggered);

  return {
    donorId: input.donorId,
    displayName: input.displayName,
    donorCode: input.donorCode,
    compositeScore: +compositeScore.toFixed(4),
    baseComposite: +baseComposite.toFixed(4),
    components: {
      financialSignificance: +financialSignificance.toFixed(4),
      opportunity: +opportunity.toFixed(4),
      stewardship: +stewardship.toFixed(4),
      momentum: +momentumSignal.toFixed(4),
      tacticalUrgency: +tacticalUrgency.toFixed(4),
    },
    momentumLabel,
    pledgeStaleClass: staleClass,
    coverage: +coverage.toFixed(4),
    coverageFloor: +coverageFloor.toFixed(4),
    coverageTriggered,
    financialConfidence,
    relationshipConfidence,
    attentionType,
    whyNow: buildWhyNow(input, attentionType, staleClass),
    evidence: buildEvidence(input, staleClass),
  };
}

// Scores every donor and assigns rank 1..N by descending composite
// score. Deterministic tie-break: donorId ascending (stable, arbitrary
// but reproducible -- never insertion order, which D1 does not
// guarantee).
export function scorePortfolioFocus(donorInputs: readonly PortfolioFocusDonorInput[], ctx: PortfolioFocusContext): PortfolioFocusResult[] {
  const scored = donorInputs.map((input) => scorePortfolioFocusDonor(input, ctx));
  scored.sort((a, b) => b.compositeScore - a.compositeScore || a.donorId.localeCompare(b.donorId));
  return scored.map((result, index) => ({ ...result, rank: index + 1 }));
}

export { ATTENTION_TYPE_LABELS };
