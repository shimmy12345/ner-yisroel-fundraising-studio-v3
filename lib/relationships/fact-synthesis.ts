import { CATEGORY_DECAY_WINDOW_DAYS, DURABLE_BASELINE_SCORE, RELEVANCE_FLOOR, type FactCategory, type FactLifecycle } from "./fact-classification.ts";

// Relationship Intelligence Phase 2 -- deterministic synthesis, exactly
// as approved in docs/AI-HANDOFF.md's "Relationship Snapshot Synthesis
// Design" sections. Pure function, no D1 access, no generation -- only
// selection, scoring, capping, and verbatim sentence-join over already-
// accepted text. This is what regenerates donors.relationship_summary/
// institutional_memory; those two columns are a materialized CACHE of
// this function's output over the donor's CURRENT facts, never an
// independent source of truth.

export type SynthesisFact = {
  factText: string;
  category: FactCategory;
  lifecycle: FactLifecycle;
  status: "current" | "superseded" | "archived_with_source";
  sourceInteractionId: string | null;
  sourceInteractionOccurredAt: number; // epoch seconds
};

// Same exact linear decay shape as lib/relationships/recommendation-
// candidates.ts's own recencyScore -- reused by formula, not imported,
// since that file's version is scoped to RecommendationCandidate
// building and not exported for reuse; the shape
// (`clamp01(1 - daysAgo / horizonDays)`) is copied verbatim, including
// that file's own comment that this is "deliberately linear and simple
// -- not a claim worth making."
function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
function recencyScore(daysAgo: number, horizonDays: number) {
  return clamp01(1 - daysAgo / horizonDays);
}

// A `solicitation` fact whose sourceInteractionId matches a still-
// `pending` ask's own sourceInteractionId is pinned to full freshness
// (score 1.0) regardless of age -- the one sanctioned channel for
// structured data (asks) to influence a fact's relevance, per the
// approved design. Never copies the ask's own amount/purpose text into
// the fact, only its pending/resolved status. Caller supplies this as a
// plain Set of interaction ids (read from the real `asks` table at call
// time) -- this module has no D1 access of its own.
export type PinnedFreshSourceInteractionIds = ReadonlySet<string>;

function scoreFact(fact: SynthesisFact, now: number, pinnedFresh: PinnedFreshSourceInteractionIds): number {
  if (fact.lifecycle === "durable") return DURABLE_BASELINE_SCORE;
  // fact.lifecycle === "time_bound" (follow_up is filtered out by the
  // caller before this function ever sees it -- see
  // synthesizeRelationshipSnapshot below).
  if (fact.category === "solicitation" && fact.sourceInteractionId !== null && pinnedFresh.has(fact.sourceInteractionId)) return 1;
  const daysAgo = Math.max(0, (now - fact.sourceInteractionOccurredAt) / 86400);
  return recencyScore(daysAgo, CATEGORY_DECAY_WINDOW_DAYS[fact.category]);
}

// Reuses the exact same sentence-join convention as lib/capture/
// interaction.ts's actionableRelationshipSnapshot() -- never a new
// formatting scheme.
function joinFacts(facts: SynthesisFact[]): string | null {
  if (facts.length === 0) return null;
  return facts.map((fact) => (/[.!?]$/.test(fact.factText) ? fact.factText : `${fact.factText}.`)).join(" ");
}

export type SynthesisResult = { relationshipSummary: string | null; institutionalMemory: string | null };

// `facts` may be passed as the donor's full fact history (any status) --
// this function does its own status/lifecycle filtering as a hard
// invariant, never trusting the caller to have pre-filtered correctly:
// `superseded`/`archived_with_source` facts never participate, and
// `follow_up` facts never enter Snapshot prose at all, regardless of how
// fresh or old they are.
export function synthesizeRelationshipSnapshot(facts: SynthesisFact[], now: number, pinnedFresh: PinnedFreshSourceInteractionIds = new Set()): SynthesisResult {
  const eligible = facts.filter((fact) => fact.status === "current" && fact.lifecycle !== "follow_up");
  const scored = eligible
    .map((fact) => ({ fact, score: scoreFact(fact, now, pinnedFresh) }))
    .sort((a, b) => b.score - a.score || b.fact.sourceInteractionOccurredAt - a.fact.sourceInteractionOccurredAt);

  const clearingFloor = scored.filter((item) => item.score > RELEVANCE_FLOOR);
  let summarySet: SynthesisFact[];
  let memorySet: SynthesisFact[];
  if (clearingFloor.length > 0) {
    summarySet = clearingFloor.slice(0, 2).map((item) => item.fact);
    memorySet = clearingFloor.slice(0, 5).map((item) => item.fact);
  } else if (scored.length > 0) {
    // Nothing clears the floor, but at least one current, non-follow_up
    // fact exists -- the Snapshot must never go blank while any accepted
    // fact is on file. Falls back to the single most recent (the sort's
    // own recency tie-break already puts it first when every score is
    // tied at 0).
    summarySet = [scored[0].fact];
    memorySet = [scored[0].fact];
  } else {
    summarySet = [];
    memorySet = [];
  }

  return { relationshipSummary: joinFacts(summarySet), institutionalMemory: joinFacts(memorySet) };
}
