import type { PendingGiftMatchRow } from "./management.ts";

// Shared JL-import pending-match reconciliation (2026-10-21, second
// follow-up review -- "enforce pending-pledge reconciliation success
// inside the import transaction"). Used identically by the pending-gift
// and pending-pledge paths in app/api/import/route.ts -- the SAME guard
// shape (CONFIRM_PENDING_GIFT_SQL/CONFIRM_PENDING_PLEDGE_SQL, both
// `WHERE ... confirmed_by_activity_id IS NULL`) means both categories
// shared the identical gap this module closes: the CONFIRM statement
// can affect zero rows when a competing request already reconciled the
// same pending entry first (its own guard is exactly what stops a
// double-claim), but the OLD code always wrote the audit row
// unconditionally regardless of whether the CONFIRM actually applied --
// so a losing claim still got permanently, falsely recorded as
// "pending_matched" in giving_activity_management_audits, even though
// the pending entry itself was never actually touched by this request.
//
// Fix: the audit INSERT below is itself conditioned on the CONFIRM
// statement, EARLIER in the SAME batch, having actually applied -- a D1
// batch is one real transaction, and later statements observe earlier
// statements' own writes within it (the same property this codebase's
// calendar-sync guards and attributeGivingActivityToTrip's own
// reconciliation already rely on), so this EXISTS check sees the
// CONFIRM's just-applied effect, or its absence, correctly either way.
// The caller (app/api/import/route.ts) additionally reads back each
// CONFIRM statement's own rowcount after the batch commits (via
// resolvePendingReconciliationOutcomes below) so it can report and
// count ONLY the matches that actually reconciled -- never crediting,
// auditing, or reporting a stale claim as successful, and never
// aborting the rest of a valid import over one race it lost.

export type PendingReconciliationDecision = { action: string; pendingId?: string | null };
export type PendingReconciliationMatch = { fingerprint: string; candidates: PendingGiftMatchRow[] };

export type PendingReconciliationPlan = {
  statements: D1PreparedStatement[];
  // Candidate id -> index of its OWN confirm statement within
  // `statements` (not within the caller's larger combined batch -- the
  // caller adds its own `baseOffset` when interpreting results).
  confirmIndexByCandidateId: Map<string, number>;
  candidateById: Map<string, PendingGiftMatchRow>;
};

// Builds, for every match with an explicit "merge" decision naming one
// of its own candidates, the [CONFIRM, conditional-audit] statement pair
// -- never more than one pair per candidate (a candidate can only ever
// be named by one decision; the caller's own claimedPendingIds/
// claimedPendingPledgeIds guard against two DECISIONS naming the same
// candidate before this is ever called). `confirmSql` is
// CONFIRM_PENDING_GIFT_SQL or CONFIRM_PENDING_PLEDGE_SQL, bound here as
// (importedActivityId, now, candidate.id, userId, candidate.donor_id) --
// identical argument order both callers already used before this
// extraction.
export function buildPendingReconciliationStatements(
  db: D1Database,
  confirmSql: string,
  matches: PendingReconciliationMatch[],
  decisionByFingerprint: Map<string, PendingReconciliationDecision>,
  importedActivityIdByFingerprint: Map<string, string>,
  userId: string,
  importId: string,
  now: number,
): PendingReconciliationPlan {
  const statements: D1PreparedStatement[] = [];
  const confirmIndexByCandidateId = new Map<string, number>();
  const candidateById = new Map<string, PendingGiftMatchRow>();
  for (const match of matches) {
    const decision = decisionByFingerprint.get(match.fingerprint);
    if (decision?.action !== "merge" || !decision.pendingId) continue;
    const importedActivityId = importedActivityIdByFingerprint.get(match.fingerprint);
    const candidate = match.candidates.find((item) => item.id === decision.pendingId);
    if (!importedActivityId || !candidate) continue;
    candidateById.set(candidate.id, candidate);
    const confirmIndex = statements.length;
    statements.push(db.prepare(confirmSql).bind(importedActivityId, now, candidate.id, userId, candidate.donor_id));
    confirmIndexByCandidateId.set(candidate.id, confirmIndex);
    // The EXISTS check alone only proves "the pending entry currently
    // points at MY activity id" -- true the first time the CONFIRM
    // above actually applies, but ALSO still true on a later retry that
    // targets the SAME already-merged candidate with the SAME
    // importedActivityId (the retry's own CONFIRM affects zero rows,
    // yet the end state it checks for is unchanged from the original
    // success). A deterministic id plus INSERT OR IGNORE closes that
    // gap: a pending entry can only ever be confirmed once, ever (the
    // CONFIRM's own guard is permanent -- confirmed_by_activity_id never
    // reverts to NULL), so "one audit row per candidate, ever" is the
    // correct invariant, enforced here the same way CONFIRM_PENDING_
    // GIFT_SQL/CONFIRM_PENDING_PLEDGE_SQL enforce "confirmed at most
    // once" on the pending row itself -- a real PRIMARY KEY, not a
    // read-then-decide check.
    statements.push(db.prepare(`INSERT OR IGNORE INTO giving_activity_management_audits (id,user_id,activity_id,import_id,action,previous_donor_id,next_donor_id,previous_status,next_status,previous_note,next_note,created_at)
        SELECT ?,?,?,?,'pending_matched',?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM giving_activities WHERE id = ? AND confirmed_by_activity_id = ? AND workspace_status = 'merged')`)
      .bind(`pending-match-${candidate.id}`, userId, candidate.id, importId, candidate.donor_id, candidate.donor_id, candidate.workspace_status, "merged", candidate.private_note, candidate.private_note, now, candidate.id, importedActivityId));
  }
  return { statements, confirmIndexByCandidateId, candidateById };
}

export type PendingReconciliationOutcome = { confirmedCandidateIds: string[]; staleCandidateIds: string[] };

// Reads back, from the FULL batch's own results array, whether each
// candidate's own CONFIRM statement actually affected a row --
// `baseOffset` is where this plan's own statements begin within that
// larger array (the caller concatenates several plans' statements
// together into one real D1 batch). Never infers success from having
// submitted a merge decision at all -- only from the guarded UPDATE's
// own rowcount, post-commit.
export function resolvePendingReconciliationOutcomes(
  results: Array<{ meta?: { changes?: number } }>,
  plan: PendingReconciliationPlan,
  baseOffset: number,
): PendingReconciliationOutcome {
  const confirmedCandidateIds: string[] = [];
  const staleCandidateIds: string[] = [];
  for (const [candidateId, relativeIndex] of plan.confirmIndexByCandidateId) {
    const changes = results[baseOffset + relativeIndex]?.meta?.changes ?? 0;
    (changes > 0 ? confirmedCandidateIds : staleCandidateIds).push(candidateId);
  }
  return { confirmedCandidateIds, staleCandidateIds };
}
