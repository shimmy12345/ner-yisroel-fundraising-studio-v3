// Fundraising Intelligence Brief -- Phase 1 per-donor synthesis. Pure.
// Collapses every DetectedSignal that fired for one donor into exactly
// ONE candidate (§13 / hard rule H: "one underlying donor situation
// should not generate multiple Brief cards merely because several
// engines noticed it"). The Schwartz regression case (a real recent
// gift and a separate, still fully-unpaid pledge) must remain
// distinguishable within that one item -- this is why every fired
// signal's own evidence is preserved verbatim in sourceSignals rather
// than merged into a single summed figure.
import type { PortfolioFocusDonorInput, PortfolioFocusResult } from "../portfolio-focus/types.ts";
import type { BriefDisposition, BriefEvidenceRef, ConfidenceLevel, FundraisingIntelligenceCandidate } from "./types.ts";
import { assertSafeBriefText } from "./text-safety.ts";
import type { DetectedSignal } from "./situations.ts";

// The only two combinations Phase 1 allows to upgrade to KNOW_DO ("use
// sparingly," per instruction) -- a genuinely opposite-disposition
// signal fired for the same donor, and the winning signal is
// meaningful enough (tier 1 or 2) that the pairing is worth stating as
// one story rather than picking a side.
function combineDisposition(winner: DetectedSignal, others: DetectedSignal[]): BriefDisposition {
  const hasOppositeDisposition = others.some((o) => o.disposition !== winner.disposition);
  if (hasOppositeDisposition && winner.priorityTier <= 2) return "KNOW_DO";
  return winner.disposition;
}

function combinedConfidence(winner: DetectedSignal, others: DetectedSignal[]): ConfidenceLevel {
  // Confidence describes FOS's knowledge on the winning situation only
  // -- an unrelated secondary signal's own confidence never dilutes or
  // inflates it.
  return winner.confidence;
}

export function synthesizeDonorCandidate(
  donor: PortfolioFocusDonorInput,
  result: PortfolioFocusResult,
  signals: DetectedSignal[],
): FundraisingIntelligenceCandidate | null {
  if (signals.length === 0) return null;

  const sorted = [...signals].sort((a, b) => a.priorityOrder - b.priorityOrder);
  const winner = sorted[0];
  const others = sorted.slice(1);

  const disposition = combineDisposition(winner, others);
  const opposite = others.find((o) => o.disposition !== winner.disposition) ?? null;
  const possibleAction = disposition === "DO" || disposition === "KNOW_DO" ? (winner.possibleAction ?? opposite?.possibleAction ?? null) : null;

  // Preserve each secondary situation's own explanation as ONE distinct,
  // separately-labeled fact -- never folded into the winner's dollar
  // figures (this is the concrete mechanism that keeps Schwartz's
  // separate gift and pledge from being summed into one misleading
  // number). Only the human-readable explanation is kept, not also that
  // signal's own raw evidence array, to avoid saying the same fact twice
  // in two slightly different phrasings.
  const sourceSignals: BriefEvidenceRef[] = [...winner.evidence, ...others.map((other) => ({ kind: other.evidence[0]?.kind ?? ("momentum" as const), detail: `Also on file: ${other.explanation}` }))];

  const context: string = `donor ${donor.donorId}`;
  return {
    donorId: donor.donorId,
    displayName: donor.displayName,
    disposition,
    situationType: winner.situationType,
    headline: assertSafeBriefText(winner.headline, `${context} headline`),
    explanation: assertSafeBriefText(winner.explanation, `${context} explanation`),
    whyNow: assertSafeBriefText(winner.whyNow, `${context} whyNow`),
    whatFosDoesNotKnow: winner.whatFosDoesNotKnow ? assertSafeBriefText(winner.whatFosDoesNotKnow, `${context} whatFosDoesNotKnow`) : null,
    possibleAction: possibleAction ? assertSafeBriefText(possibleAction, `${context} possibleAction`) : null,
    confidence: combinedConfidence(winner, others),
    sourceSignals,
    included: false, // decided by the population-level ranking pass in index.ts
    suppressionReason: null,
    debug: {
      portfolioFocusRank: result.rank,
      compositeScore: result.compositeScore,
      financialSignificance: result.components.financialSignificance,
      recommendationKind: donor.recommendation?.kind ?? null,
      recommendationScore: donor.recommendation?.score ?? null,
      priorityTier: winner.priorityTier,
    },
  };
}

export function buildNoSituationCandidate(donor: PortfolioFocusDonorInput, result: PortfolioFocusResult): FundraisingIntelligenceCandidate {
  const suppressionReason = donor.recommendation?.kind === "reconnect_contact_gap"
    ? "reconnect_fallback_only_no_independent_situation"
    : "no_qualifying_situation";
  return {
    donorId: donor.donorId,
    displayName: donor.displayName,
    disposition: "KNOW",
    situationType: "none",
    headline: "",
    explanation: "",
    whyNow: "",
    whatFosDoesNotKnow: null,
    possibleAction: null,
    confidence: "limited",
    sourceSignals: [],
    included: false,
    suppressionReason,
    debug: {
      portfolioFocusRank: result.rank,
      compositeScore: result.compositeScore,
      financialSignificance: result.components.financialSignificance,
      recommendationKind: donor.recommendation?.kind ?? null,
      recommendationScore: donor.recommendation?.score ?? null,
      priorityTier: null,
    },
  };
}
