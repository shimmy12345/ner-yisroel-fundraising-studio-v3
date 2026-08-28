// Portfolio Focus -- Today-page presentation adapter (Phase 2A,
// 2026-08-28). Pure, read-only, no D1 access (no import of ./index.ts
// or ./data.ts) so this stays trivially unit-testable with plain
// synthetic fixtures, the same convention as
// tests/portfolio-focus-components.test.mjs.
//
// This file NEVER re-derives a score, rank, or attention type -- it only
// translates the already-computed PortfolioFocusResult (lib/portfolio-focus/
// score.ts, implementing the model FROZEN in
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md) into the display vocabulary
// approved in docs/PORTFOLIO-FOCUS-UX-DESIGN.md Section 8-9. The
// internal AttentionType enum (lib/portfolio-focus/types.ts) is never
// changed or exposed to the UI -- only this display mapping is new.
import type { AttentionType, PortfolioFocusEvidence, PortfolioFocusResult } from "./types.ts";

// UX-design-approved fundraiser-facing vocabulary (docs/PORTFOLIO-FOCUS-UX-DESIGN.md
// Section 8). learn_relationship_review and coverage_needed intentionally
// share one label -- from a fundraiser's point of view both mean "go
// learn about this relationship, don't solicit it"; the real distinction
// stays in the untouched internal enum and in whyNow's underlying
// evidence. monitor_routine is not expected to ever reach a top-5/top-25
// cut, but still needs a safe, honest label if it ever does.
export const ATTENTION_TYPE_DISPLAY_LABELS: Record<AttentionType, string> = {
  solicit_scheduled: "Solicitation Opportunity",
  cultivate_steward_active: "Cultivate & Steward",
  steward_active_fulfillment: "Active Stewardship",
  reconnect_understand_decline: "Reconnect",
  cultivate_real_growth: "Cultivate",
  learn_relationship_review: "Relationship Review",
  coverage_needed: "Relationship Review",
  monitor_routine: "Monitor",
};

function fmtCentsCompact(cents: number | null): string {
  if (cents == null) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

// A short, one-line version of the engine's own whyNow sentence, derived
// only from PortfolioFocusResult.evidence (never from raw components,
// never inventing a fact whyNow/evidence didn't already establish). Kept
// deliberately parallel to score.ts's buildWhyNow() but shorter, for the
// compact Today card -- the full-length whyNow stays available for a
// future "why this donor?" detail view (Phase 2B).
export function formatPortfolioFocusWhyNow(attentionType: AttentionType, evidence: PortfolioFocusEvidence): string {
  switch (attentionType) {
    case "coverage_needed":
    case "learn_relationship_review":
      // Coverage-driven and thin-documentation cases must never read as a
      // call to solicit -- docs/PORTFOLIO-FOCUS-UX-DESIGN.md Section 11.
      return `${fmtCentsCompact(evidence.lifetimeCents)} lifetime relationship, limited current relationship documentation.`;
    case "solicit_scheduled":
      // openReminderAction is already a self-contained phrase (and may
      // itself contain its own quotation marks, e.g. a donor-authored
      // note) -- prefixing rather than re-quoting avoids doubled/nested
      // quote marks in the rendered row.
      return evidence.openReminderAction ? `Scheduled follow-up: ${evidence.openReminderAction}.` : "An explicit fundraiser follow-up is already scheduled.";
    case "cultivate_steward_active":
      return evidence.openPledgeTotalCents ? `${fmtCentsCompact(evidence.openPledgeTotalCents)} commitment, currently active.` : "Active, current relationship signal.";
    case "steward_active_fulfillment":
      return `${fmtCentsCompact(evidence.openPledgeBalanceCents)} remaining of ${fmtCentsCompact(evidence.openPledgeTotalCents)}, on track.`;
    case "reconnect_understand_decline":
      return `Giving declined from ${fmtCentsCompact(evidence.prior365Cents)} to ${fmtCentsCompact(evidence.last365Cents)} this year.`;
    case "cultivate_real_growth":
      return `Giving grew from ${fmtCentsCompact(evidence.prior365Cents)} to ${fmtCentsCompact(evidence.last365Cents)} this year.`;
    case "monitor_routine":
    default:
      return "No significant financial or relationship signal this period.";
  }
}

// One Today-card row -- deliberately excludes compositeScore, baseComposite,
// components, coverage/coverageFloor, momentumLabel, pledgeStaleClass, and
// financialConfidence/relationshipConfidence: docs/PORTFOLIO-FOCUS-UX-DESIGN.md
// Section 5/7 -- the Today card shows WHO / WHY / WHAT KIND OF ATTENTION,
// never raw scores or internal classification names.
export type TodayPortfolioFocusRow = {
  donorId: string;
  rank: number;
  displayName: string;
  donorCode: string | null;
  attentionLabel: string;
  whyNow: string;
};

// Takes the engine's own already-ranked output (index 0 = rank 1, per
// scorePortfolioFocus's own sort) and returns the first `limit` rows for
// the Today card, unmodified in order -- no re-sorting, no curation, no
// donor-specific special case of any kind.
export function buildTodayPortfolioFocusRows(results: readonly PortfolioFocusResult[], limit: number): TodayPortfolioFocusRow[] {
  return results.slice(0, limit).map((result) => ({
    donorId: result.donorId,
    rank: result.rank,
    displayName: result.displayName,
    donorCode: result.donorCode,
    attentionLabel: ATTENTION_TYPE_DISPLAY_LABELS[result.attentionType],
    whyNow: formatPortfolioFocusWhyNow(result.attentionType, result.evidence),
  }));
}
