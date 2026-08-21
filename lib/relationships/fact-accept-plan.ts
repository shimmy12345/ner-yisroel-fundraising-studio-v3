import { extractInteraction, type InteractionKind } from "../capture/interaction.ts";
import { classifyRelationshipFact, type FactCategory, type FactLifecycle } from "./fact-classification.ts";
import { computeRelationshipFactFingerprint } from "./fact-fingerprint.ts";
import { synthesizeRelationshipSnapshot, type SynthesisFact, type PinnedFreshSourceInteractionIds } from "./fact-synthesis.ts";
import { selectSupersessionTarget } from "./fact-supersession.ts";

// Relationship Intelligence Phase 2 -- the pure "decide + synthesize +
// compute next state" core of fact acceptance, factored out of
// lib/relationships/fact-accept.ts so it has NO "cloudflare:workers"
// import (matching the Phase 1 classifyCandidate()/planBackfill() and
// this phase's own fact-supersession.ts precedent) and can therefore be
// called repeatedly, in-memory, against a caller-supplied working state
// instead of a fresh D1 read every time.
//
// This exists specifically to fix a real correctness bug: a caller
// processing several accept decisions for the SAME donor within one D1
// batch (e.g. the Monday import commit route's decision loop) cannot
// rely on a fresh D1 read to see an earlier decision's not-yet-executed
// statements from the same batch. The fix is to thread a
// FactAcceptanceWorkingState through the decisions in order -- each
// call's `nextState` becomes the next call's input `state` -- so later
// decisions see exactly the effective state earlier decisions in the
// same batch would have produced, without weakening supersession rules
// or relying on a later cleanup pass. lib/relationships/fact-accept.ts's
// own planFactAcceptance() (the single-decision D1-touching entry point
// every other route uses) is simply this function called once, with
// state loaded fresh from D1 -- so single-decision callers are
// unaffected in shape or behavior.

export type WorkingFact = {
  id: string;
  category: FactCategory;
  lifecycle: FactLifecycle;
  factText: string;
  sourceInteractionId: string | null;
  sourceInteractionOccurredAt: number;
  fingerprint: string;
};

// Only CURRENT facts participate in supersession/synthesis, so this is
// the whole state a caller needs to carry between decisions for one
// donor -- deliberately excludes superseded/archived rows, which never
// influence a subsequent decision.
export type FactAcceptanceWorkingState = {
  facts: WorkingFact[];
  relationshipSummary: string | null;
  institutionalMemory: string | null;
};

export type FactAcceptancePlanInput = {
  donorId: string;
  userId: string;
  // The interaction this acceptance is attributed to. Always a real,
  // already-resolved interaction id in Phase 2 (never null -- null is
  // reserved for Phase 1's historical backfill rows only).
  sourceInteractionId: string;
  sourceInteractionOccurredAt: number; // epoch seconds
  noteText: string;
  kind: InteractionKind;
  subject: string;
  now: number; // epoch seconds
  pinnedFresh: PinnedFreshSourceInteractionIds;
};

// Everything a caller needs to build the actual D1 statements for one
// accepted decision -- deliberately SQL-free so this module never needs
// "cloudflare:workers". `casRelationshipSummary`/`casInstitutionalMemory`
// are the exact values the donors CAS write must compare against --
// the working state's OWN values at the time this decision was planned,
// which is what makes sequential in-batch CAS writes for the same donor
// compose correctly (each one guards against the previous one's own
// effect, not a stale pre-batch snapshot).
export type FactAcceptanceIntent = {
  newFact: WorkingFact;
  supersedeFactId: string | null;
  relationshipSummary: string | null;
  institutionalMemory: string | null;
  casRelationshipSummary: string | null;
  casInstitutionalMemory: string | null;
};

export type FactAcceptanceStepResult = {
  // null when there is nothing to write (nothing extracted, or the
  // proposal is a byte-identical no-op against the fact it would
  // supersede) -- the caller writes nothing and `nextState` is the
  // SAME object as the input `state` (safe to keep reusing for the next
  // decision on this donor).
  intent: FactAcceptanceIntent | null;
  nextState: FactAcceptanceWorkingState;
};

// Reuses every existing, already-tested pure function verbatim
// (extractInteraction, classifyRelationshipFact,
// computeRelationshipFactFingerprint, selectSupersessionTarget,
// synthesizeRelationshipSnapshot) -- this function only sequences them
// against the caller-supplied working state instead of a D1 read.
export function planFactAcceptanceStep(state: FactAcceptanceWorkingState, input: FactAcceptancePlanInput): FactAcceptanceStepResult {
  const extracted = extractInteraction(input.noteText, input.kind, input.subject);
  if (extracted.relationshipSummary === null) return { intent: null, nextState: state };

  const { category, lifecycle } = classifyRelationshipFact(extracted.relationshipSummary);
  const fingerprint = computeRelationshipFactFingerprint({ donorId: input.donorId, factText: extracted.relationshipSummary, sourceInteractionId: input.sourceInteractionId });

  const decision = selectSupersessionTarget(
    state.facts.map((fact) => ({ id: fact.id, category: fact.category, lifecycle: fact.lifecycle, sourceInteractionId: fact.sourceInteractionId, fingerprint: fact.fingerprint })),
    { category, lifecycle, sourceInteractionId: input.sourceInteractionId, fingerprint },
  );
  if (decision.isNoOp) return { intent: null, nextState: state };
  const supersedeTarget = decision.targetId ? state.facts.find((fact) => fact.id === decision.targetId)! : null;

  const newFact: WorkingFact = {
    id: crypto.randomUUID(),
    category,
    lifecycle,
    factText: extracted.relationshipSummary,
    sourceInteractionId: input.sourceInteractionId,
    sourceInteractionOccurredAt: input.sourceInteractionOccurredAt,
    fingerprint,
  };

  const postWriteCurrentFacts: SynthesisFact[] = state.facts
    .filter((fact) => fact.id !== supersedeTarget?.id)
    .map((fact) => ({
      factText: fact.factText,
      category: fact.category,
      lifecycle: fact.lifecycle,
      status: "current",
      sourceInteractionId: fact.sourceInteractionId,
      sourceInteractionOccurredAt: fact.sourceInteractionOccurredAt,
    }));
  postWriteCurrentFacts.push({
    factText: newFact.factText,
    category: newFact.category,
    lifecycle: newFact.lifecycle,
    status: "current",
    sourceInteractionId: newFact.sourceInteractionId,
    sourceInteractionOccurredAt: newFact.sourceInteractionOccurredAt,
  });

  const synthesis = synthesizeRelationshipSnapshot(postWriteCurrentFacts, input.now, input.pinnedFresh);

  const intent: FactAcceptanceIntent = {
    newFact,
    supersedeFactId: supersedeTarget?.id ?? null,
    relationshipSummary: synthesis.relationshipSummary,
    institutionalMemory: synthesis.institutionalMemory,
    casRelationshipSummary: state.relationshipSummary,
    casInstitutionalMemory: state.institutionalMemory,
  };

  const nextState: FactAcceptanceWorkingState = {
    facts: [...state.facts.filter((fact) => fact.id !== supersedeTarget?.id), newFact],
    relationshipSummary: synthesis.relationshipSummary,
    institutionalMemory: synthesis.institutionalMemory,
  };

  return { intent, nextState };
}
