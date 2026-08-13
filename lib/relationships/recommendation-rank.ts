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
// the reminder already answers. acknowledge_gift/follow_up_pledge are a
// different concern (money/stewardship) and are never suppressed by a
// reminder -- see design case 1 (a recent gift can still win over an
// unrelated open reminder on merit).
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

function score(candidate: RecommendationCandidate): number {
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
  "follow_up_pledge",
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
