// Fundraising Intelligence Brief -- dedicated-page presentation
// adapter. Pure, no D1 access (no import of ./compute.ts) -- translates
// the engine's own already-computed FundraisingIntelligenceCandidate[]
// (lib/fundraising-intelligence/index.ts) into fundraiser language.
// Mirrors lib/portfolio-focus/dedicated-view.ts's own convention: never
// re-derives a disposition, situation, or confidence level, and never
// invents a fact -- every field below is built only from a candidate's
// own already-computed fields. Only INCLUDED items (candidate.included
// === true) are ever passed in; `rejected` candidates are never
// rendered anywhere in the UI.
import type { BriefDisposition, FundraisingIntelligenceCandidate, SituationType } from "./types.ts";
import { CONFIDENCE_EXPLANATIONS, CONFIDENCE_LABELS, DISPOSITION_LABELS, SITUATION_TYPE_LABELS } from "./labels.ts";

export type IntelligenceBriefGroup = "needs_action" | "worth_knowing_and_doing" | "worth_knowing";

// Preferred grouping per the design's own UX recommendation: DO / KNOW+DO
// / KNOW, in plain human terms -- never grouped by technical situation
// type (a fundraiser should understand what to do with the information,
// not how the engine classified it).
export const INTELLIGENCE_GROUP_LABELS: Record<IntelligenceBriefGroup, string> = {
  needs_action: "Needs Action",
  worth_knowing_and_doing: "Worth Knowing & Doing",
  worth_knowing: "Worth Knowing",
};

export const INTELLIGENCE_GROUP_ORDER: readonly IntelligenceBriefGroup[] = ["needs_action", "worth_knowing_and_doing", "worth_knowing"];

export function groupForDisposition(disposition: BriefDisposition): IntelligenceBriefGroup {
  if (disposition === "DO") return "needs_action";
  if (disposition === "KNOW_DO") return "worth_knowing_and_doing";
  return "worth_knowing";
}

export type IntelligenceBriefRow = {
  donorId: string;
  displayName: string;
  disposition: BriefDisposition;
  dispositionLabel: string;
  group: IntelligenceBriefGroup;
  situationLabel: string;
  headline: string;
  explanation: string;
  whyNow: string;
  whatFosDoesNotKnow: string | null;
  // Never present unless the engine itself supplied one -- the UI layer
  // never invents an action (rule §9/§10 of the UI phase's own
  // instruction). Guaranteed non-null exactly when disposition is "DO"
  // or "KNOW_DO" -- see lib/fundraising-intelligence/synthesize.ts's own
  // invariant, re-asserted by a test here rather than re-derived.
  possibleAction: string | null;
  confidenceLabel: string;
  confidenceExplanation: string;
  // Reuses the ALREADY-ESTABLISHED "rank" concept from the Portfolio
  // Focus dedicated page (a familiar, already-shipped UI idea) -- never
  // a raw composite score or component value.
  portfolioFocusRank: number;
  // Plain-English evidence sentences only (BriefEvidenceRef.detail) --
  // the internal `kind` tag (e.g. "pledge_balance") is deliberately
  // dropped here; it is calibration-only vocabulary, not end-user copy.
  evidenceLines: string[];
};

function buildRow(item: FundraisingIntelligenceCandidate): IntelligenceBriefRow {
  return {
    donorId: item.donorId,
    displayName: item.displayName,
    disposition: item.disposition,
    dispositionLabel: DISPOSITION_LABELS[item.disposition],
    group: groupForDisposition(item.disposition),
    situationLabel: SITUATION_TYPE_LABELS[item.situationType as SituationType] ?? "Intelligence",
    headline: item.headline,
    explanation: item.explanation,
    whyNow: item.whyNow,
    whatFosDoesNotKnow: item.whatFosDoesNotKnow,
    possibleAction: item.possibleAction,
    confidenceLabel: CONFIDENCE_LABELS[item.confidence],
    confidenceExplanation: CONFIDENCE_EXPLANATIONS[item.confidence],
    portfolioFocusRank: item.debug.portfolioFocusRank,
    evidenceLines: item.sourceSignals.map((signal) => signal.detail),
  };
}

// Builds one row per INCLUDED item, in the engine's own order -- no
// re-sorting, no curation, no donor-specific special case of any kind
// (the same principle lib/portfolio-focus/dedicated-view.ts's own
// buildDedicatedPortfolioFocusRows documents).
export function buildIntelligenceBriefRows(items: readonly FundraisingIntelligenceCandidate[]): IntelligenceBriefRow[] {
  return items.map(buildRow);
}

export function groupIntelligenceBriefRows(rows: readonly IntelligenceBriefRow[]): Record<IntelligenceBriefGroup, IntelligenceBriefRow[]> {
  const groups: Record<IntelligenceBriefGroup, IntelligenceBriefRow[]> = { needs_action: [], worth_knowing_and_doing: [], worth_knowing: [] };
  for (const row of rows) groups[row.group].push(row);
  return groups;
}
