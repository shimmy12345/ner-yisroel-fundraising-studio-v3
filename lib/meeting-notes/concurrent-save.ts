import { followUpListsMatch, type FollowUpContent } from "./idempotency.ts";

// Concurrency safety for an existing interaction's `summary` (2026-10-21,
// third follow-up review -- closing a gap the second follow-up review's
// own fix left open). Shared by
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
// The PREVIOUS version of this module built the follow-up INSERTs as
// part of the SAME batch as the summary UPDATE, conditioned on a SQL
// `WHERE EXISTS (... summary = ?)` bound to the NEW summary -- intending
// to prove "the preceding UPDATE actually applied." It does not: that
// EXISTS check only proves the ROW'S CURRENT CONTENT matches the new
// value, which can be true for reasons that have nothing to do with
// THIS request's own write -- most concretely, when the row's summary
// already happened to equal the requested new value (a stale
// `expectedSummary` racing a completion that coincidentally produced
// the exact same text, or simply a retry) WHILE this request's own CAS,
// keyed on the OLDER `casBaseline`, correctly affected zero rows. In
// that exact shape, the summary UPDATE legitimately reports failure
// while the follow-up INSERTs' own EXISTS check still reads true and
// creates brand-new tasks anyway -- a rejected save that silently
// creates follow-ups regardless. Matching END-STATE TEXT is never proof
// that THIS request's write produced it.
//
// The fix below never infers success from content matching. It runs the
// summary UPDATE on its own first and reads back ITS OWN authoritative
// rowcount. Follow-ups are only ever attempted once that rowcount has
// already proven this exact request's CAS applied; a CAS miss never
// attempts to create a single follow-up, full stop -- the one exception
// being a genuine, already-completed replay of THIS SAME request
// (verified by reading back the SPECIFIC follow-up rows this exact
// idempotencyKey would have created and confirming they already match,
// never merely by the summary text happening to match).
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
  const updateResult = await db.prepare("UPDATE interactions SET summary = ?, updated_at = ? WHERE id = ? AND donor_id = ? AND user_id = ? AND summary = ?")
    .bind(newSummary, now, interactionId, donorId, userId, casBaseline).run() as unknown as { meta?: { changes?: number } };

  if ((updateResult.meta?.changes ?? 0) > 0) {
    // This request's own CAS just applied, proven by its own rowcount --
    // safe to create follow-ups now, unconditionally (no SQL guard
    // needed; nothing left to prove). A PRIMARY KEY conflict here can
    // only mean THIS exact idempotencyKey's follow-up ids were already
    // used -- a genuine network-level retry of this exact request after
    // its own earlier attempt's response was lost, disambiguated the
    // same way a stale CAS is below.
    if (followUps.length === 0) return { status: "applied", followUpsCreated: 0 };
    try {
      await db.batch(followUps.map((followUp) =>
        db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
          .bind(followUp.id, followUp.donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now)));
      return { status: "applied", followUpsCreated: followUps.length };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      return (await followUpsAlreadyMatch(db, userId, followUps)) ? { status: "replayed" } : { status: "conflict", reason: "followup_mismatch" };
    }
  }

  // The CAS missed. Disambiguate a safe replay (this exact save --
  // summary AND every requested follow-up -- already fully applied,
  // e.g. a network-level retry) from a genuine conflict, by reading
  // back the ACTUAL rows, never by inferring from text equality alone.
  const current = await db.prepare("SELECT summary FROM interactions WHERE id = ? AND donor_id = ? AND user_id = ?").bind(interactionId, donorId, userId).first<{ summary: string }>();
  if (current?.summary !== newSummary) return { status: "conflict", reason: "summary_stale" };
  return (await followUpsAlreadyMatch(db, userId, followUps)) ? { status: "replayed" } : { status: "conflict", reason: "followup_mismatch" };
}
