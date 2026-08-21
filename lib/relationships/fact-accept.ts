import { env } from "cloudflare:workers";
import { type FactCategory, type FactLifecycle } from "./fact-classification.ts";
import { synthesizeRelationshipSnapshot, type PinnedFreshSourceInteractionIds, type SynthesisFact } from "./fact-synthesis.ts";
import {
  planFactAcceptanceStep,
  type FactAcceptanceIntent,
  type FactAcceptancePlanInput,
  type FactAcceptanceWorkingState,
} from "./fact-accept-plan.ts";

// Relationship Intelligence Phase 2 -- the shared accept pipeline every
// existing explicit-acceptance write path (Capture, edit route, Outcome
// Option A, Monday import confirm_contact) now goes through, replacing
// each route's own bespoke "overwrite donors.relationship_summary
// directly" statement. Builds D1 statements to APPEND to the caller's
// own existing `env.DB.batch(statements)` array -- never executes on its
// own -- so every route's existing atomicity (interaction update + this
// + audit rows, all-or-nothing) is preserved exactly as before.
//
// Never called unless the caller has already confirmed explicit human
// acceptance (acceptRelationshipSnapshot === true) -- this module itself
// has no opinion on that gate, matching every existing route's own
// established convention of deciding acceptance before ever reaching the
// write.

type CurrentFactRow = {
  id: string;
  category: FactCategory;
  lifecycle: FactLifecycle;
  fact_text: string;
  source_interaction_id: string | null;
  source_interaction_occurred_at: number;
  fingerprint: string;
};

export type FactAcceptanceInput = Omit<FactAcceptancePlanInput, "pinnedFresh">;

export type FactAcceptancePlan = {
  statements: D1PreparedStatement[];
  // Index into the RETURNED statements array pointing at the donors CAS
  // UPDATE -- the caller appends `statements` to its own existing array
  // and must offset this index by that array's length-before-append to
  // read `results[offsetIndex].meta.changes` after `env.DB.batch()`
  // resolves, exactly mirroring Option A's own established
  // relationshipStatementIndex convention. -1 when there is nothing to
  // write (nothing extracted, or the proposal is a byte-identical no-op
  // against the fact it would supersede).
  relationshipStatementIndex: number;
};

const EMPTY_PLAN: FactAcceptancePlan = { statements: [], relationshipStatementIndex: -1 };

export type FactAcceptanceDonorState = {
  workingState: FactAcceptanceWorkingState;
  // Pending-ask source_interaction_ids, loaded once alongside the
  // working state and passed into each planFactAcceptanceStep() call
  // directly (kept separate from workingState since it never evolves
  // between decisions -- no accept decision in any of the four wired
  // routes ever creates or changes an ask, so it cannot change across
  // decisions within one batch and never needs reloading mid-batch).
  pinnedFresh: PinnedFreshSourceInteractionIds;
};

// Reads exactly the D1 state a single accept decision needs -- current
// facts, the donor's own relationship_summary/institutional_memory (the
// CAS baseline), and pending-ask source_interaction_ids (the
// pinned-freshness set). Exported so a caller processing MULTIPLE
// decisions for the same donor within one D1 batch (the Monday import
// commit route) can load this ONCE per donor and thread the workingState
// it gets back from each planFactAcceptanceStep() call into the next
// decision, rather than re-reading D1 (which cannot see the earlier
// decision's own not-yet-executed statements from the same batch).
export async function loadFactAcceptanceDonorState(donorId: string, userId: string): Promise<FactAcceptanceDonorState> {
  const [currentFactsResult, donorRow, pendingAskRows] = await Promise.all([
    env.DB.prepare("SELECT id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, fingerprint FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND status = 'current'")
      .bind(donorId, userId).all<CurrentFactRow>(),
    env.DB.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
      .bind(donorId, userId).first<{ relationship_summary: string | null; institutional_memory: string | null }>(),
    // Only the linked source_interaction_id matters for the pin -- never
    // the ask's own amount/purpose, which this module never reads or
    // copies anywhere.
    env.DB.prepare("SELECT source_interaction_id FROM asks WHERE donor_id = ? AND user_id = ? AND status = 'pending' AND source_interaction_id IS NOT NULL")
      .bind(donorId, userId).all<{ source_interaction_id: string }>(),
  ]);
  return {
    workingState: {
      facts: currentFactsResult.results.map((fact) => ({
        id: fact.id, category: fact.category, lifecycle: fact.lifecycle, factText: fact.fact_text,
        sourceInteractionId: fact.source_interaction_id, sourceInteractionOccurredAt: fact.source_interaction_occurred_at, fingerprint: fact.fingerprint,
      })),
      relationshipSummary: donorRow?.relationship_summary ?? null,
      institutionalMemory: donorRow?.institutional_memory ?? null,
    },
    pinnedFresh: new Set(pendingAskRows.results.map((row) => row.source_interaction_id)),
  };
}

// Turns one decision's FactAcceptanceIntent (or null) into the actual D1
// statements to append to the caller's own batch array -- the INSERT-
// fact + its audit row, the optional supersede UPDATE + its audit row,
// and the donors CAS UPDATE, in that fixed order (matching every
// existing test's own literal-shape assertions). Never executes
// anything itself.
export function materializeFactAcceptanceIntent(intent: FactAcceptanceIntent | null, donorId: string, userId: string, now: number): FactAcceptancePlan {
  if (!intent) return EMPTY_PLAN;
  const { newFact, supersedeFactId } = intent;

  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB.prepare(`INSERT INTO donor_relationship_facts
      (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, supersedes_fact_id, fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?)`)
      .bind(newFact.id, donorId, userId, newFact.category, newFact.lifecycle, newFact.factText, newFact.sourceInteractionId, newFact.sourceInteractionOccurredAt, supersedeFactId, newFact.fingerprint, now, now),
  );
  statements.push(
    env.DB.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'created', '[]', NULL, ?, ?)`)
      .bind(crypto.randomUUID(), newFact.id, userId, donorId, JSON.stringify({ factText: newFact.factText, category: newFact.category, lifecycle: newFact.lifecycle, sourceInteractionId: newFact.sourceInteractionId }), now),
  );

  if (supersedeFactId) {
    // CAS-guarded on status still being 'current' -- fails closed (0
    // rows) rather than clobbering a concurrent change; a 0-row result
    // here does not fail the whole batch (D1 batch() does not roll back
    // on a 0-change UPDATE), but the caller's own top-level interaction-
    // row CAS is still the request's real concurrency guard, matching
    // every existing route's established pattern.
    statements.push(
      env.DB.prepare("UPDATE donor_relationship_facts SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'current'")
        .bind(now, supersedeFactId),
    );
    statements.push(
      env.DB.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'superseded', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), supersedeFactId, userId, donorId, JSON.stringify(["status"]), JSON.stringify({ status: "current" }), JSON.stringify({ status: "superseded", supersededByFactId: newFact.id }), now),
    );
  }

  const relationshipStatementIndex = statements.length;
  statements.push(
    env.DB.prepare(`UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = 86, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND relationship_summary IS ? AND institutional_memory IS ?`)
      .bind(intent.relationshipSummary, intent.institutionalMemory, now, donorId, userId, intent.casRelationshipSummary, intent.casInstitutionalMemory),
  );

  return { statements, relationshipStatementIndex };
}

// Single-decision entry point every route but Monday's confirm_contact
// loop uses (each of those calls this exactly once per interaction, so
// there is no same-donor sequencing concern for them): loads working
// state fresh from D1, plans the one decision against it, and
// materializes the result. Equivalent in shape and behavior to Phase
// 2's original all-in-one implementation -- unchanged for every existing
// caller.
export async function planFactAcceptance(input: FactAcceptanceInput): Promise<FactAcceptancePlan> {
  const { workingState, pinnedFresh } = await loadFactAcceptanceDonorState(input.donorId, input.userId);
  const { intent } = planFactAcceptanceStep(workingState, { ...input, pinnedFresh });
  return materializeFactAcceptanceIntent(intent, input.donorId, input.userId, input.now);
}

// Transitions every CURRENT fact sourced from a given interaction to
// `archived_with_source` (a source interaction being archived/cancelled/
// reassigned to a different donor) and resynthesizes the donor's
// Snapshot from whatever current facts remain -- never promoting some
// OTHER interaction's never-explicitly-accepted extraction to fill the
// gap, per the approved design. Returns the same shape as
// planFactAcceptance so callers can append/offset identically; -1 when
// this interaction sourced no current facts for this donor (nothing to
// do).
export async function planFactArchival(input: { donorId: string; userId: string; sourceInteractionId: string; now: number }): Promise<FactAcceptancePlan> {
  const [affectedResult, allCurrentResult, donorRow, pendingAskRows] = await Promise.all([
    env.DB.prepare("SELECT id FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND source_interaction_id = ? AND status = 'current'")
      .bind(input.donorId, input.userId, input.sourceInteractionId).all<{ id: string }>(),
    env.DB.prepare("SELECT id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND status = 'current'")
      .bind(input.donorId, input.userId).all<CurrentFactRow>(),
    env.DB.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
      .bind(input.donorId, input.userId).first<{ relationship_summary: string | null; institutional_memory: string | null }>(),
    env.DB.prepare("SELECT source_interaction_id FROM asks WHERE donor_id = ? AND user_id = ? AND status = 'pending' AND source_interaction_id IS NOT NULL")
      .bind(input.donorId, input.userId).all<{ source_interaction_id: string }>(),
  ]);
  const affected = affectedResult.results;
  if (affected.length === 0) return EMPTY_PLAN;

  const statements: D1PreparedStatement[] = [];
  for (const fact of affected) {
    statements.push(
      env.DB.prepare("UPDATE donor_relationship_facts SET status = 'archived_with_source', updated_at = ? WHERE id = ? AND status = 'current'")
        .bind(input.now, fact.id),
    );
    statements.push(
      env.DB.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'archived_with_source', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), fact.id, input.userId, input.donorId, JSON.stringify(["status"]), JSON.stringify({ status: "current" }), JSON.stringify({ status: "archived_with_source" }), input.now),
    );
  }

  const remaining: SynthesisFact[] = allCurrentResult.results
    .filter((fact) => !affected.some((item) => item.id === fact.id))
    .map((fact) => ({
      factText: fact.fact_text,
      category: fact.category,
      lifecycle: fact.lifecycle,
      status: "current",
      sourceInteractionId: fact.source_interaction_id,
      sourceInteractionOccurredAt: fact.source_interaction_occurred_at,
    }));
  const pinnedFresh = new Set(pendingAskRows.results.map((row) => row.source_interaction_id));
  const synthesis = synthesizeRelationshipSnapshot(remaining, input.now, pinnedFresh);

  const relationshipStatementIndex = statements.length;
  statements.push(
    env.DB.prepare(`UPDATE donors SET relationship_summary = ?, institutional_memory = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND relationship_summary IS ? AND institutional_memory IS ?`)
      .bind(synthesis.relationshipSummary, synthesis.institutionalMemory, input.now, input.donorId, input.userId, donorRow?.relationship_summary ?? null, donorRow?.institutional_memory ?? null),
  );

  return { statements, relationshipStatementIndex };
}
