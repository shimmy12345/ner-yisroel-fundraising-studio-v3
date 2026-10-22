import { followUpListsMatch, type FollowUpContent } from "./idempotency.ts";

// Concurrency safety for an existing interaction's `summary` (2026-10-21,
// fourth follow-up review -- closing a real atomicity bug the third
// follow-up review's own fix introduced). Shared by
// app/api/trips/[id]/prospects/[prospectId]/meeting-notes/route.ts (the
// only route that UPDATEs an existing interaction's summary rather than
// always inserting a fresh one) so the actual write/decision logic this
// test file exercises is the exact production implementation, not a
// copy of it.
//
// The write is a compare-and-swap keyed on `casBaseline` -- the summary
// this editing session actually started from, never a value re-read at
// the last moment, since the real risk is a browser tab left open across
// someone else's change, not a sub-second race within one request.
//
// CONFIRMED FAILURE IN 62dec37 this fixes: the previous version ran the
// summary UPDATE on its own via `.run()`, read back its own rowcount,
// and -- only once proven -- ran the follow-up INSERTs as a SEPARATE
// `db.batch()` call. Two separate commits are not one transaction: when
// a follow-up id collided with different content, the function
// correctly rejected the request, but the summary UPDATE from the FIRST
// call had already committed. A rejected save was leaving its new
// summary permanently written.
//
// The fix (drizzle/0052) keeps the summary UPDATE and every follow-up
// write in ONE `db.batch()` call -- one real transaction, confirmed via
// this repo's own D1SqliteAdapter (`BEGIN IMMEDIATE` ... `COMMIT`,
// rollback-and-rethrow on any statement that throws). Because D1 batch
// statements still run unconditionally in sequence (there is no SQL
// "skip the rest if the previous statement affected zero rows"), each
// follow-up write is gated on `write_token` -- a fresh, request-unique
// value (crypto.randomUUID(), generated once per call, never reused or
// shared) the summary UPDATE stamps as part of its OWN CAS'd SET clause.
// A dependent statement proves the summary UPDATE applied by checking
// `EXISTS (... interactions WHERE id = ? AND write_token = ?)` bound to
// that exact value -- never by matching the new summary TEXT (two
// unrelated writes can coincidentally produce the same text) and never
// by chaining the SQL `changes()` function past an intervening statement
// (it only ever describes the IMMEDIATELY PRECEDING statement, so a
// second or later follow-up checking it would see the FIRST follow-up's
// own rowcount, not the summary UPDATE's). Because the token is fresh
// and random per call, no concurrent request -- even one racing from the
// exact same `casBaseline` -- can ever make that EXISTS check read true
// except as a direct consequence of THIS call's own CAS having matched,
// in the same transaction, moments earlier.
//
// A follow-up id already holding DIFFERENT content must abort the WHOLE
// request, including the already-applied summary UPDATE -- not just
// skip that one follow-up. This is done with a genuine SQL throw, never
// a try/catch content comparison performed AFTER a write already landed:
// each follow-up is a DELETE (removing the row only if its id AND
// content already exactly match what is being requested -- a no-op
// when nothing with that id exists yet) immediately followed by a
// write_token-gated INSERT of that exact id. If the row did not exist,
// or existed with matching content and was just removed, the INSERT
// succeeds (fresh create, or an identical-content replay). If the row
// existed with DIFFERENT content, the DELETE's content match fails, the
// row is left in place, and the INSERT then collides with it on the
// PRIMARY KEY -- a real UNIQUE constraint violation, which D1 rolls the
// entire batch back for, undoing the summary UPDATE too. No compensating
// write is ever needed, because nothing partial is ever actually
// committed.
export type ConcurrentFollowUpInput = FollowUpContent & { id: string; donorId: string };

export type ConcurrentSaveOutcome =
  | { status: "applied"; followUpsCreated: number }
  // This exact save (summary AND, if any were requested, every one of
  // its follow-ups) had already fully applied before this call --
  // proven by re-reading the actual rows, never inferred. Never creates
  // or changes anything.
  | { status: "replayed" }
  // Genuinely rejected -- nothing was written, nothing changed.
  // `summary_stale`: the row's summary no longer matches `casBaseline`
  // and does not already hold the requested new value either.
  // `followup_mismatch`: the summary side resolved (applied or a
  // coincidental match), but the specific follow-ups this request wants
  // to create collide with DIFFERENT already-saved content under the
  // same ids -- the donor-profile route's own established "changed-
  // payload retry is rejected outright" rule, applied here too.
  | { status: "conflict"; reason: "summary_stale" | "followup_mismatch" };

const UNIQUE_VIOLATION_PATTERN = /UNIQUE constraint failed/i;
function isUniqueConstraintViolation(error: unknown): boolean {
  if (error instanceof Error) {
    if (UNIQUE_VIOLATION_PATTERN.test(error.message)) return true;
    if (error.cause instanceof Error && UNIQUE_VIOLATION_PATTERN.test(error.cause.message)) return true;
  }
  return false;
}

// Reads back the EXACT rows this request's own follow-up ids would have
// created and compares them against what was requested -- the only
// basis on which "this exact save already applied" is ever accepted.
// A follow-up id that does not exist at all under this key means this
// is NOT a replay of a prior successful save of these follow-ups (fresh
// ids that were simply never written) -- `false`, never assumed safe.
async function followUpsAlreadyMatch(db: D1Database, userId: string, followUps: ConcurrentFollowUpInput[]): Promise<boolean> {
  if (followUps.length === 0) return true;
  const ids = followUps.map((item) => item.id);
  const rows = await db.prepare(`SELECT id, action, due_at FROM recommendations WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids).all<{ id: string; action: string; due_at: number | null }>();
  if (rows.results.length !== followUps.length) return false;
  const existing: FollowUpContent[] = rows.results.map((row) => ({ index: ids.indexOf(row.id), description: row.action, dueAtEpoch: row.due_at }));
  return followUpListsMatch(existing, followUps);
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
): Promise<ConcurrentSaveOutcome> {
  const writeToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE interactions SET summary = ?, write_token = ?, updated_at = ? WHERE id = ? AND donor_id = ? AND user_id = ? AND summary = ?")
      .bind(newSummary, writeToken, now, interactionId, donorId, userId, casBaseline),
  ];
  for (const followUp of followUps) {
    statements.push(
      db.prepare(`DELETE FROM recommendations WHERE id = ? AND donor_id = ? AND user_id = ? AND action = ? AND due_at IS ?
          AND EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)`)
        .bind(followUp.id, followUp.donorId, userId, followUp.description, followUp.dueAtEpoch, interactionId, writeToken),
      db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)`)
        .bind(followUp.id, followUp.donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now, interactionId, writeToken),
    );
  }

  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await db.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    // The batch rolled back in full -- the summary UPDATE (even though
    // its own CAS matched) is undone along with every follow-up.
    return { status: "conflict", reason: "followup_mismatch" };
  }

  if ((results[0]?.meta?.changes ?? 0) > 0) {
    // This request's own CAS applied, proven by its own statement's
    // rowcount, and every follow-up committed in the SAME transaction
    // (a genuine mismatch would have thrown above, undoing this too).
    return { status: "applied", followUpsCreated: followUps.length };
  }

  // The CAS missed and nothing in this batch applied (every dependent
  // statement's write_token gate read false). Disambiguate a safe
  // replay (this exact save -- summary AND every requested follow-up --
  // already fully applied, e.g. a network-level retry) from a genuine
  // conflict, by reading back the ACTUAL rows, never by inferring from
  // text equality alone.
  const current = await db.prepare("SELECT summary FROM interactions WHERE id = ? AND donor_id = ? AND user_id = ?").bind(interactionId, donorId, userId).first<{ summary: string }>();
  if (current?.summary !== newSummary) return { status: "conflict", reason: "summary_stale" };
  return (await followUpsAlreadyMatch(db, userId, followUps)) ? { status: "replayed" } : { status: "conflict", reason: "followup_mismatch" };
}
