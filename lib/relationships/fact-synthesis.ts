import { DURABLE_BASELINE_SCORE, RELEVANCE_FLOOR, resolveDecayWindowDays, isConfirmedOutreachCompletion, isUnambiguousCompletedOutreachAction, type FactCategory, type FactLifecycle } from "./fact-classification.ts";

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
  // Completion-awareness (2026-10-12) -- see fact-classification.ts's
  // isConfirmedOutreachCompletion() for the full contract: the real
  // `type`/`summary` of the interaction `sourceInteractionId` points
  // at, when the caller has them available. Optional and defaults to
  // "no evidence" (via scoreFact()'s `?? null`) so every existing
  // caller that doesn't supply these -- e.g. fact-accept.ts's
  // archival-resynthesis path -- keeps compiling and behaving exactly
  // as before, falling back to ordinary decay-based scoring unchanged.
  sourceInteractionType?: string | null;
  sourceInteractionSummary?: string | null;
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
  // Completed Outreach Action Fix, round 2 (2026-10-14, docs/AI-HANDOFF.md)
  // -- checked FIRST, before even the `durable` early-return, and against
  // the fact's own TEXT rather than its stored `lifecycle`. An unambiguous
  // ACTION report (the fundraiser's own past-tense contact verb, e.g.
  // "Texted ... and thanked him") is never actionable at any age, with no
  // grace window -- see isUnambiguousCompletedOutreachAction's own doc
  // comment for why this is categorically different from an EVENT report
  // ("Son had a bar mitzvah.", no stated actor, genuinely ambiguous about
  // completion), which keeps its existing, unchanged, age-based treatment
  // further below. Checking the TEXT rather than the stored `lifecycle`
  // value is also what makes this self-healing for the two rows already
  // written in Production with the stale `durable` value, with zero data
  // migration required.
  if (isUnambiguousCompletedOutreachAction(fact.factText, fact.category)) return 0;
  if (fact.lifecycle === "durable") return DURABLE_BASELINE_SCORE;
  // fact.lifecycle === "time_bound" (follow_up is filtered out by the
  // caller before this function ever sees it -- see
  // synthesizeRelationshipSnapshot below).
  //
  // Completion-awareness (2026-10-12, see fact-classification.ts's
  // isConfirmedOutreachCompletion()): checked BEFORE the normal decay
  // formula, not as a replacement for it -- a fact with no confirmed
  // completion evidence (the common case: `sourceInteractionType`/
  // `sourceInteractionSummary` absent, or present but not confirming)
  // falls straight through to the exact same decay math as before,
  // byte-for-byte. Returning 0 here (rather than a new threshold) reuses
  // every existing downstream mechanic unchanged: RELEVANCE_FLOOR still
  // gates actionability the same way a fully-decayed fact already does,
  // and synthesizeRelationshipSnapshot's "never blank" fallback still
  // applies if this is the donor's only current fact -- the fact stays
  // permanently visible in donor_relationship_facts and (as a last
  // resort) in the Snapshot, it just stops being "actionable."
  if (fact.lifecycle === "time_bound" && isConfirmedOutreachCompletion(fact.factText, fact.sourceInteractionType ?? null, fact.sourceInteractionSummary ?? null)) return 0;
  if (fact.category === "solicitation" && fact.sourceInteractionId !== null && pinnedFresh.has(fact.sourceInteractionId)) return 1;
  const daysAgo = Math.max(0, (now - fact.sourceInteractionOccurredAt) / 86400);
  return recencyScore(daysAgo, resolveDecayWindowDays(fact.category, fact.factText));
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

export type ActionableFact = { factText: string; category: FactCategory; sourceInteractionId: string | null; score: number };

// Relationship Snapshot Architecture Stage 2 (see docs/AI-HANDOFF.md) --
// a STRICT, non-fallback relevance check answering "is there a currently
// ACTIONABLE fact," never "what should the Snapshot display." Reuses the
// exact same scoreFact() formula synthesizeRelationshipSnapshot() itself
// uses above (same function in this module, not a copy or a second
// formula) -- the only difference is this NEVER falls back to the single
// most-recent fact when nothing clears RELEVANCE_FLOOR. That "never
// blank" fallback exists so the DISPLAYED Relationship Snapshot never
// reads empty; it must never leak into a recommendation-actionability
// decision, where "nothing currently actionable" is the correct, honest
// answer, not a display gap to paper over. Concretely: a donor whose
// only fact is a fully-decayed, ask-resolved solicitation would still
// show that fact's text via synthesizeRelationshipSnapshot()'s fallback
// (correct for display -- something beats nothing when there's genuinely
// nothing more current to say), but this function correctly returns null
// for that same fact set (correct for actionability -- there is nothing
// CURRENT to recommend acting on).
//
// `category`, when passed, restricts eligibility to that one category
// (e.g. "solicitation" for solicit-candidate gating); omitted, it
// considers every current, non-follow_up fact regardless of category
// (for a generic "is there anything currently relevant at all" check).
export function findMostActionableFact(facts: SynthesisFact[], now: number, pinnedFresh: PinnedFreshSourceInteractionIds = new Set(), category?: FactCategory): ActionableFact | null {
  const eligible = facts.filter((fact) => fact.status === "current" && fact.lifecycle !== "follow_up" && (category === undefined || fact.category === category));
  const scored = eligible
    .map((fact) => ({ fact, score: scoreFact(fact, now, pinnedFresh) }))
    .filter((item) => item.score > RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score || b.fact.sourceInteractionOccurredAt - a.fact.sourceInteractionOccurredAt);
  if (scored.length === 0) return null;
  const top = scored[0];
  return { factText: top.fact.factText, category: top.fact.category, sourceInteractionId: top.fact.sourceInteractionId, score: top.score };
}

export type ResolvedRelationshipSnapshot = SynthesisResult & { source: "facts" | "cache" };

// Relationship Snapshot Architecture Stage 3 (see docs/AI-HANDOFF.md) --
// the ONE shared resolver every display/context surface (donor page,
// Meeting Brief, Assistant) must call instead of independently
// reimplementing "facts if any exist, else the cached columns." Not a
// new synthesis algorithm and not a new relevance formula -- when the
// donor has at least one fact row, this delegates to the existing,
// unmodified synthesizeRelationshipSnapshot() (same pinning/decay/
// "never blank" semantics already approved and already used elsewhere
// in this module); when the donor has zero fact rows, it returns the
// cached values byte-for-byte, untouched, exactly as today -- the
// required exact legacy fallback. `source` is exposed only so callers/
// tests can confirm which path produced a given result; it is never
// itself display text.
export function resolveRelationshipSnapshot(
  facts: SynthesisFact[],
  cached: { relationshipSummary: string | null; institutionalMemory: string | null },
  now: number,
  pinnedFresh: PinnedFreshSourceInteractionIds = new Set(),
): ResolvedRelationshipSnapshot {
  if (facts.length === 0) return { relationshipSummary: cached.relationshipSummary, institutionalMemory: cached.institutionalMemory, source: "cache" };
  const synthesized = synthesizeRelationshipSnapshot(facts, now, pinnedFresh);
  return { ...synthesized, source: "facts" };
}
