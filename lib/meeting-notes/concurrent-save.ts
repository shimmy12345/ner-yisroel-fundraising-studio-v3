// Concurrency safety for an existing interaction's `summary` (2026-10-21,
// second follow-up review -- "a stale editor must not silently overwrite
// newer saved notes or an appended completion note"). Shared by
// app/api/trips/[id]/prospects/[prospectId]/meeting-notes/route.ts
// (the only route that UPDATEs an existing interaction's summary rather
// than always inserting a fresh one) so the actual SQL this test file
// exercises is the exact production statement shape, not a copy of it.
//
// The write is a compare-and-swap keyed on `casBaseline` -- the summary
// this editing session actually started from, never a value re-read at
// the last moment, since the real risk is a browser tab left open
// across someone else's change, not a sub-second race within one
// request. The follow-up INSERTs are conditioned on the SAME UPDATE,
// earlier in the same batch, having actually applied -- a D1 batch is
// one real transaction, and a later statement observes an earlier
// statement's own write within it, so this EXISTS check sees the
// UPDATE's just-applied effect (or its absence) correctly either way.
// Without that, a lost CAS would still leave a batch free to insert
// follow-ups for a save that never actually landed.
export type ConcurrentFollowUpInput = { id: string; donorId: string; userId: string; description: string; dueAtEpoch: number | null };

export function buildConcurrentSummarySaveStatements(
  db: D1Database,
  interactionId: string,
  donorId: string,
  userId: string,
  newSummary: string,
  casBaseline: string,
  now: number,
  followUps: ConcurrentFollowUpInput[],
): D1PreparedStatement[] {
  const updateStatement = db.prepare("UPDATE interactions SET summary = ?, updated_at = ? WHERE id = ? AND donor_id = ? AND user_id = ? AND summary = ?")
    .bind(newSummary, now, interactionId, donorId, userId, casBaseline);
  const followUpStatements = followUps.map((followUp) =>
    db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ? WHERE EXISTS (SELECT 1 FROM interactions WHERE id = ? AND donor_id = ? AND user_id = ? AND summary = ?)`)
      .bind(followUp.id, followUp.donorId, followUp.userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now, interactionId, donorId, userId, newSummary));
  return [updateStatement, ...followUpStatements];
}

// The decisive check after the batch commits -- never inferred from
// "the batch didn't throw" alone, since a CAS miss with no follow-ups
// to conflict on commits cleanly with zero rows changed.
export function concurrentSummarySaveApplied(results: Array<{ meta?: { changes?: number } }>): boolean {
  return (results[0]?.meta?.changes ?? 0) > 0;
}
