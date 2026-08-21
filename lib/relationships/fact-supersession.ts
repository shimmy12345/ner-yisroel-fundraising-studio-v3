import { isSingularStateCategory, type FactCategory, type FactLifecycle } from "./fact-classification.ts";

// Relationship Intelligence Phase 2 -- the pure "add rather than erase"
// decision core, deliberately kept in its own module with NO
// "cloudflare:workers" import (unlike lib/relationships/fact-accept.ts,
// which uses this function but cannot itself be imported outside a
// Workers runtime at all -- importing any name from a module pulls in
// its full top-level import graph, so this had to be split out, not
// just exported, to be unit-testable).

export type ExistingFactRef = { id: string; category: FactCategory; lifecycle: FactLifecycle; sourceInteractionId: string | null; fingerprint: string };
export type NewFactRef = { category: FactCategory; lifecycle: FactLifecycle; sourceInteractionId: string; fingerprint: string };
export type SupersessionDecision = { targetId: string | null; isNoOp: boolean };

// An exact same-source-interaction match always wins first (a correction
// to what THIS interaction already contributed, regardless of category/
// lifecycle/singular-state-ness). Otherwise, only the two singular-state
// categories (solicitation, health) auto-supersede, and only within the
// SAME lifecycle too (the Lifecycle Correction's own fix -- a durable
// identity fact and a time_bound event fact sharing a category must
// never collide). Every other category is additive; no automatic
// target -- the new fact is simply added alongside existing current
// facts, never replacing them.
export function selectSupersessionTarget(currentFacts: ExistingFactRef[], newFact: NewFactRef): SupersessionDecision {
  let target = currentFacts.find((fact) => fact.sourceInteractionId === newFact.sourceInteractionId) ?? null;
  if (!target && isSingularStateCategory(newFact.category)) {
    target = currentFacts.find((fact) => fact.category === newFact.category && fact.lifecycle === newFact.lifecycle) ?? null;
  }
  // No-op: re-accepting text that would produce a byte-identical fact to
  // the one it would supersede (e.g. an edit that didn't actually change
  // the accepted sentence) -- nothing changed, so nothing should be
  // written, not even a pointless supersede-with-identical-content chain.
  const isNoOp = target !== null && target.fingerprint === newFact.fingerprint;
  return { targetId: target?.id ?? null, isNoOp };
}
