import { type FollowUpContent } from "./idempotency.ts";

// Concurrency safety for an existing interaction's `summary` (2026-10-22,
// fifth follow-up review -- closing two retry defects the fourth
// follow-up review's own atomicity fix left open). Shared by
// app/api/trips/[id]/prospects/[prospectId]/meeting-notes/route.ts (the
// only route that UPDATEs an existing interaction's summary rather than
// always inserting a fresh one) so the actual write/decision logic this
// test file exercises is the exact production implementation, not a
// copy of it.
//
// The write is a compare-and-swap keyed on `casBaseline` -- the summary
// this editing session actually started from, never a value re-read at
// the last moment, since the real risk is a browser tab left open across
// someone else's change, not a sub-second race within one request. The
// fourth follow-up review's `write_token` mechanism (drizzle/0052) is
// unchanged here: every CAS'd primary UPDATE stamps a fresh, per-call
// random value as part of its own SET clause, and every dependent
// statement in the SAME `db.batch()` proves the primary applied via
// `EXISTS (... interactions WHERE id = ? AND write_token = ?)` -- never
// by matching end-state content, never by chaining the SQL `changes()`
// function past an intervening statement. That transaction design is
// unchanged and still what makes the two fixes below safe to add to the
// same batch.
//
// CONFIRMED DEFECT 1 this round closes: the fourth follow-up review made
// an identical retry's follow-up write idempotent by pairing a content-
// matching DELETE with a write_token-gated INSERT of the same id -- so a
// matching retry would delete the existing row and recreate it. That is
// NOT a no-op: if the follow-up had since been completed (or otherwise
// changed) through some other path, the retry silently reopened it and
// reset `created_at`. Each follow-up write is now a genuine no-op when
// its row already matches (see the two-statement insert/verify pair
// below) -- `status`, `created_at`, and everything else a completion or
// dismissal already changed survives completely untouched -- and
// `followUpsCreated` in the response reflects the actual newly-inserted
// rowcount, never a blind `followUps.length`.
//
// CONFIRMED DEFECT 2 this round closes: the previous replay/conflict
// disambiguation (`followUpsAlreadyMatch`) only ever queried the ids the
// RETRYING request itself submitted. A retry that silently dropped,
// added, reordered, or recolored one of the original save's follow-ups
// while keeping the others unchanged was reported as a safe "replayed"
// no-op -- the dropped/changed follow-up's own row was simply never
// looked at, because nothing about the retrying request's own body can
// prove what the COMPLETE original payload was.
//
// `meeting_note_save_identities` (drizzle/0053) is that proof: one row
// per client-generated `saveId` (the same idempotencyKey every follow-up
// id this save produces is already namespaced under, so it is globally
// unique by construction), recording a deterministic serialization of
// the complete payload this identity was first used with. The CAS'd
// primary write and this ledger row commit in the SAME batch as the
// follow-up writes: `INSERT ... ON CONFLICT(save_id) DO UPDATE` whose
// UPDATE branch sets `payload_signature` to itself when the newly
// computed signature matches what's on record (a true no-op) or to NULL
// when it does not. Because that column is NOT NULL, a mismatch is a
// genuine constraint violation -- which rolls the WHOLE batch back,
// including the primary summary UPDATE, exactly like a genuine PRIMARY
// KEY collision already does for other cases. The same ledger row --
// read directly, not re-derived from the submitted request -- is also
// what the CAS-missed replay/conflict disambiguation below compares
// against, closing the exact gap `followUpsAlreadyMatch` left open.
//
// INDEPENDENT REVIEW (2026-10-22) found two gaps in the above and this
// round closes both:
// 1. The signature previously covered only `followUps` -- a reused save
// identity submitted with a DIFFERENT `newSummary` (the notes
// themselves) or a different `interactionId`/`donorId` (the save's own
// target) but the SAME follow-ups would pass the ledger check
// undetected, since nothing about the notes or the target was ever part
// of what was being compared. The signature now also covers
// `interactionId`, `donorId`, and `newSummary` -- a save key reused with
// different notes or a different target is rejected exactly like a
// reused key with different follow-ups always was.
// 2. The CAS-missed disambiguation branch special-cased `followUps.
// length === 0` to return a bare "replayed" WITHOUT ever consulting the
// ledger -- so retrying a save identity with every one of its original
// follow-ups now REMOVED (an empty list) bypassed the payload comparison
// entirely: as long as the summary coincidentally matched, it was
// reported as a safe replay regardless of what the identity's own
// recorded payload actually was. The ledger comparison now runs
// unconditionally, with no follow-up-count carve-out; a genuinely new
// save identity (nothing in the ledger yet) is `undefined === signature`,
// correctly a conflict rather than an assumed replay.
export type ConcurrentFollowUpInput = FollowUpContent & { id: string; donorId: string };

export type ConcurrentSaveOutcome =
  | { status: "applied"; followUpsCreated: number }
  // This exact save (summary AND, if any were requested, every one of
  // its follow-ups) had already fully applied before this call --
  // proven by the save-identity ledger's own recorded payload, never
  // inferred from matching text or from only the ids this retry itself
  // mentions. Never creates or changes anything.
  | { status: "replayed" }
  // Genuinely rejected -- nothing was written, nothing changed.
  // `summary_stale`: the row's summary no longer matches `casBaseline`
  // and does not already hold the requested new value either.
  // `followup_mismatch`: the summary side resolved (applied or a
  // coincidental match), but this save identity's complete payload --
  // target, notes, AND follow-ups -- does not match what is already on
  // record for it (any addition, removal, reorder, or content change to
  // any of the three, including removing every follow-up down to none,
  // or no record at all) -- the donor-profile route's own established
  // "changed-payload retry is rejected outright" rule, applied here too.
  | { status: "conflict"; reason: "summary_stale" | "followup_mismatch" };

const MISMATCH_VIOLATION_PATTERN = /UNIQUE constraint failed|NOT NULL constraint failed/i;
function isMismatchViolation(error: unknown): boolean {
  if (error instanceof Error) {
    if (MISMATCH_VIOLATION_PATTERN.test(error.message)) return true;
    if (error.cause instanceof Error && MISMATCH_VIOLATION_PATTERN.test(error.cause.message)) return true;
  }
  return false;
}

// Deterministic serialization of the COMPLETE payload a save identity is
// being asked to apply -- notes, target, AND follow-ups -- the same
// shape every call for this identity must reproduce exactly for the
// ledger comparison (drizzle/0053) to treat it as a replay. Follow-up
// order is significant, matching idempotency.ts's own followUpListsMatch
// convention: a follow-up's index is part of its identity (embedded in
// its own recommendation row id), so the same two follow-ups submitted
// in a different order is correctly a different payload, not a cosmetic
// reordering. `interactionId`/`donorId` are included so a save key
// reused against a different target is rejected exactly like one reused
// with different notes or follow-ups -- never inferred from matching
// follow-up content alone.
function payloadSignature(interactionId: string, donorId: string, newSummary: string, followUps: ConcurrentFollowUpInput[]): string {
  return JSON.stringify({
    interactionId,
    donorId,
    summary: newSummary,
    followUps: followUps.map((item) => ({ id: item.id, description: item.description, dueAtEpoch: item.dueAtEpoch })),
  });
}

export async function saveConcurrentSummaryAndFollowUps(
  db: D1Database,
  interactionId: string,
  donorId: string,
  userId: string,
  newSummary: string,
  casBaseline: string,
  now: number,
  followUps: ConcurrentFollowUpInput[],
  saveId: string,
): Promise<ConcurrentSaveOutcome> {
  const writeToken = crypto.randomUUID();
  const signature = payloadSignature(interactionId, donorId, newSummary, followUps);

  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE interactions SET summary = ?, write_token = ?, updated_at = ? WHERE id = ? AND donor_id = ? AND user_id = ? AND summary = ?")
      .bind(newSummary, writeToken, now, interactionId, donorId, userId, casBaseline),
    db.prepare(`INSERT INTO meeting_note_save_identities (save_id, interaction_id, payload_signature, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)
        ON CONFLICT(save_id) DO UPDATE SET
          payload_signature = CASE WHEN meeting_note_save_identities.payload_signature = excluded.payload_signature THEN meeting_note_save_identities.payload_signature ELSE NULL END,
          updated_at = CASE WHEN meeting_note_save_identities.payload_signature = excluded.payload_signature THEN excluded.updated_at ELSE NULL END`)
      .bind(saveId, interactionId, signature, now, now, interactionId, writeToken),
  ];
  // Two statements per follow-up, not one, so `followUpsCreated` can
  // report an ACCURATE newly-created count (an `ON CONFLICT DO UPDATE`
  // reports `changes = 1` identically for a fresh insert and a no-op
  // replay update -- confirmed empirically -- so that rowcount alone
  // cannot distinguish them):
  // 1. A plain INSERT, gated additionally on `NOT EXISTS` for this
  //    exact id -- fires, and its own rowcount is 1, ONLY when the row
  //    is genuinely new. A pre-existing row (replay or collision) makes
  //    this a true no-op; `changes` is reliably 0.
  // 2. A verify-or-throw UPDATE -- a true identity no-op when the row's
  //    content (freshly inserted by statement 1, or already there from
  //    before) matches what was requested, writing `action` back to
  //    its own current value and touching nothing else (`status`,
  //    `created_at`, anything a completion or dismissal already
  //    changed survives completely untouched). When content does NOT
  //    match, the same CASE branch writes NULL into `action` (NOT
  //    NULL), forcing a genuine constraint violation that rolls the
  //    whole batch back -- defense in depth underneath the save-
  //    identity ledger above, for a follow-up id collision from any
  //    source, not only a reused save identity.
  const followUpInsertIndexes: number[] = [];
  for (const followUp of followUps) {
    followUpInsertIndexes.push(statements.length);
    statements.push(
      db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?) AND NOT EXISTS (SELECT 1 FROM recommendations WHERE id = ?)`)
        .bind(followUp.id, followUp.donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now, interactionId, writeToken, followUp.id),
      db.prepare(`UPDATE recommendations SET action = CASE WHEN action = ? AND due_at IS ? THEN action ELSE NULL END
          WHERE id = ? AND EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)`)
        .bind(followUp.description, followUp.dueAtEpoch, followUp.id, interactionId, writeToken),
    );
  }

  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await db.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    if (!isMismatchViolation(error)) throw error;
    // The batch rolled back in full -- the summary UPDATE (even though
    // its own CAS matched) is undone along with the ledger row and
    // every follow-up.
    return { status: "conflict", reason: "followup_mismatch" };
  }

  if ((results[0]?.meta?.changes ?? 0) > 0) {
    // This request's own CAS applied, proven by its own statement's
    // rowcount, and every follow-up committed in the SAME transaction
    // (a genuine payload mismatch would have thrown above, undoing this
    // too). Count only the follow-ups actually just inserted (each
    // pair's own INSERT statement) -- an identical retry's `NOT EXISTS`
    // guard correctly reports zero, never touching an already-existing
    // row's own state.
    const followUpsCreated = followUpInsertIndexes.reduce((total, insertIndex) => total + (results[insertIndex]?.meta?.changes ?? 0), 0);
    return { status: "applied", followUpsCreated };
  }

  // The CAS missed and nothing in this batch applied (every dependent
  // statement's write_token gate read false). Disambiguate a safe
  // replay (this exact save identity already fully applied, e.g. a
  // network-level retry) from a genuine conflict, by reading back the
  // ACTUAL summary and the save-identity ledger's own recorded payload
  // -- never by inferring from text equality alone, and never by
  // querying only the ids THIS retry happens to mention. The ledger
  // check always runs, with no empty-follow-up-list carve-out: a save
  // identity that originally had follow-ups, retried with all of them
  // now removed, must still be compared against its own recorded
  // payload, not waved through just because this request has nothing
  // left to list. A save identity the ledger has no record of at all
  // (never successfully applied) is `undefined === signature` below --
  // correctly a conflict, never an assumed replay.
  const current = await db.prepare("SELECT summary FROM interactions WHERE id = ? AND donor_id = ? AND user_id = ?").bind(interactionId, donorId, userId).first<{ summary: string }>();
  if (current?.summary !== newSummary) return { status: "conflict", reason: "summary_stale" };
  const ledgerEntry = await db.prepare("SELECT payload_signature FROM meeting_note_save_identities WHERE save_id = ?").bind(saveId).first<{ payload_signature: string }>();
  return ledgerEntry?.payload_signature === signature ? { status: "replayed" } : { status: "conflict", reason: "followup_mismatch" };
}
