import type { RecommendationEvidence } from "./recommendation-evidence.ts";
import { generateCandidates, type EvidenceCertainty, type RecommendationCandidate, type RecommendationCandidateKind } from "./recommendation-candidates.ts";
import type { GiftSource } from "../giving/acknowledgment.ts";

export type DonorRecommendation = {
  action: string;
  why: string;
  evidence: string[];
  confidence: "high" | "medium" | "low";
  timing: string | null;
  // Exposed for callers that need to pick a link/href or a visual signal
  // per surface (e.g. the homepage queue), without re-deriving what kind
  // of action this is from the text itself.
  kind: RecommendationCandidateKind;
  // Only set when kind === "acknowledge_gift" -- lets a surface wire a
  // direct one-click "Mark thank-you sent" action to the exact gift this
  // recommendation is about.
  giftSource?: GiftSource;
  giftId?: string;
};

// honor_reminder answers "what's the next relationship touchpoint" -- so do
// continue_conversation/relationship_opportunity/reconnect_contact_gap/solicit.
// When a reminder exists, those are suppressed as duplicates of a question
// the reminder already answers. acknowledge_gift/follow_up_pledge/open_ask
// are a different concern (money/stewardship) and are never suppressed by
// a reminder -- see design case 1 (a recent gift can still win over an
// unrelated open reminder on merit). open_ask joins that group rather than
// the vague-touchpoint one: it's a concrete, specific action ("follow up
// on the $10k ask"), not a generic "reach out" suggestion, so it deserves
// to surface on its own merit exactly like follow_up_pledge does. This
// still gives an EXPLICIT reminder set specifically for an ask (from
// capture or the donor page's "Add follow-up") the final word in practice:
// honor_reminder's own scoring (specificity 0.9, recency/urgency 0.6-1)
// reliably outranks open_ask's (0.75/0.7/ramping 0-1) without needing a
// hard suppression rule -- see openAskCandidate's own comment.
const REMINDER_SUPPRESSES: ReadonlySet<RecommendationCandidateKind> = new Set([
  "continue_conversation",
  "relationship_opportunity",
  "reconnect_contact_gap",
  "solicit",
]);

// A confirmed/narrative-backed candidate is always preferred over one
// backed only by an unconfirmed Monday note when both are otherwise
// plausible -- implemented as a multiplier, not an outright ban, since an
// unconfirmed row should still win when it's the only evidence available
// at all (see design scenario C).
function certaintyMultiplier(certainty: EvidenceCertainty): number {
  if (certainty === "confirmed") return 1;
  if (certainty === "narrative") return 0.85;
  return 0.55; // unconfirmed_historical
}

// Exported so tests can assert against the real, exact scoring formula
// (e.g. tests/suggestion-candidates.test.mjs's monotonicity invariant for
// reconnect_contact_gap) rather than a duplicated copy of these weights
// that could silently drift out of sync with the real one.
export function score(candidate: RecommendationCandidate): number {
  return certaintyMultiplier(candidate.certainty) * (0.35 * candidate.specificity + 0.35 * candidate.recency + 0.30 * candidate.urgency);
}

// Deterministic tie-break only -- used purely so identical scores don't
// depend on array/object iteration order. Not a fallback hierarchy: it
// only ever applies when two scores are exactly equal, which in practice
// means near-identical evidence.
const KIND_PRIORITY: RecommendationCandidateKind[] = [
  "honor_reminder",
  "acknowledge_gift",
  "yahrtzeit_outreach",
  "birthday_outreach",
  "anniversary_outreach",
  "follow_up_pledge",
  "open_ask",
  "relationship_opportunity",
  "continue_conversation",
  "solicit",
  "reconnect_contact_gap",
];

export function buildDonorRecommendation(evidence: RecommendationEvidence): DonorRecommendation | null {
  let candidates = generateCandidates(evidence);

  // --- Hard constraint 1: reminder suppresses the "next touchpoint" family. ---
  if (candidates.some((candidate) => candidate.kind === "honor_reminder")) {
    candidates = candidates.filter((candidate) => candidate.kind === "honor_reminder" || !REMINDER_SUPPRESSES.has(candidate.kind));
  }

  // --- Hard constraint 2: an open pledge vetoes solicit unless the
  // supporting evidence postdates the pledge's own activity date. This is
  // a veto, not a down-rank -- a vetoed candidate never enters scoring,
  // no matter how strong its other inputs look. ---
  const pledge = evidence.giving.openPledge;
  if (pledge) {
    candidates = candidates.filter((candidate) => {
      if (candidate.kind !== "solicit") return true;
      if (pledge.activityDate === null) return false;
      return candidate.supportingDate !== null && candidate.supportingDate > pledge.activityDate;
    });
  }

  // --- Hard constraint 3 (certainty cap) is enforced at candidate
  // generation time -- solicitCandidate/relationshipOpportunityCandidate
  // never assign "high" confidence, and certaintyMultiplier() below keeps
  // an unconfirmed-only candidate from outscoring a confirmed one except
  // when it's the only survivor. ---

  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    const diff = score(b) - score(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
  });

  const winner = ranked[0];
  return { action: winner.action, why: winner.why, evidence: winner.evidence, confidence: winner.confidence, timing: winner.timing, kind: winner.kind, giftSource: winner.giftSource, giftId: winner.giftId };
}

// --- Snapshot-card presentation ---
// The donor page's top "Suggested action" KPI card (same row as "Lifetime
// paid"/"Most recent paid gift") is a narrow, single-line-budget slot --
// never the place for full recommendation reasoning or embedded raw
// evidence text. The detailed action/why/evidence/confidence already have
// their own home in the RELATIONSHIP SNAPSHOT story card's "SUGGESTED
// ACTION" block, which this never touches. This never re-derives or
// overrides which recommendation won (buildDonorRecommendation above is
// untouched) -- it only chooses how much of the ALREADY-CHOSEN winner's
// text is safe to show in a narrow card.
export type RecommendationSnapshotSummary = { headline: string; supporting: string | null };

const SNAPSHOT_HEADLINE_MAX = 100;
function conciseSnapshotText(value: string, max = SNAPSHOT_HEADLINE_MAX): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  const truncated = singleLine.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? truncated.slice(0, lastSpace) : truncated).trim()}…`;
}

// relationship_opportunity and solicit build their full `action` by
// embedding the donor's entire relationship_summary/institutional_memory
// (itself a multi-line dump: topics, people, organizations, commitments,
// next action -- see lib/capture/interaction.ts's actionableRelationship-
// Snapshot) or an imported note verbatim -- exactly right for the detail
// view, where a fundraiser needs the actual text to act on it, wrong for
// a narrow KPI card. Those two kinds get a fixed, kind-aware headline
// instead of their `action` field. Every other kind's `action` is already
// a single, bounded, purpose-built sentence, so it's reused as-is, through
// the same length backstop, in case a free-text-derived field (a user-
// authored reminder, an interaction subject line) happens to run long --
// semantic selection is the real fix; the backstop is only insurance.
export function summarizeRecommendationForSnapshot(recommendation: DonorRecommendation): RecommendationSnapshotSummary {
  if (recommendation.kind === "relationship_opportunity") {
    return { headline: "Review before next outreach", supporting: "Recent relationship notes are available." };
  }
  if (recommendation.kind === "solicit") {
    return {
      headline: "Consider a solicitation ask",
      supporting: recommendation.confidence === "low"
        ? "An imported note references a possible ask, not yet confirmed."
        : "Relationship notes describe a possible solicitation opportunity.",
    };
  }
  return { headline: conciseSnapshotText(recommendation.action), supporting: null };
}
