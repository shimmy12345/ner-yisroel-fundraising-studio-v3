import { planFactAcceptance, planFactArchival, type WriteGate } from "../relationships/fact-accept.ts";
import type { InteractionKind } from "./interaction.ts";

// Generic interaction edit concurrency safety (2026-10-21, fourth
// follow-up review -- closing a real atomicity bug the third follow-up
// review's own fix introduced).
//
// The interactions UPDATE is the compare-and-swap (`WHERE ... AND
// summary = ?`, bound to the exact baseline the caller already
// validated). CONFIRMED FAILURE IN 62dec37 this fixes: the previous
// version ran that UPDATE alone via `.run()`, read back its own
// rowcount, and -- only once proven -- ran every companion write
// (reminders, donor-reassignment fact archival, relationship-fact
// acceptance) as a SEPARATE `db.batch()` call. Two separate commits are
// not one transaction: in the (rare, but real) case a companion
// statement itself failed, the edit's own primary UPDATE had already
// committed -- exactly the same shape of bug confirmed in
// lib/meeting-notes/concurrent-save.ts's saveConcurrentSummaryAndFollowUps.
//
// The fix (drizzle/0052) keeps the primary UPDATE and every companion
// write in ONE `db.batch()` call -- one real transaction. Because D1
// batch statements still run unconditionally in sequence, each companion
// is gated on `write_token` -- a fresh, request-unique value
// (crypto.randomUUID(), generated once per call) the primary UPDATE
// stamps as part of its own CAS'd SET clause. Every companion statement
// proves the primary applied by checking
// `EXISTS (... interactions WHERE id = ? AND write_token = ?)` bound to
// that exact value -- never by matching end-state content (two
// unrelated writes can coincidentally produce the same text) and never
// by chaining the SQL `changes()` function past an intervening
// statement. Because the token is fresh and random per call, no
// concurrent request can ever make that EXISTS check read true except
// as a direct consequence of THIS call's own CAS having matched, in the
// same transaction. A rejected edit (CAS miss) leaves every companion
// gate false: nothing about reminders, relationship facts, or donor
// assignment changes, and the row that failed its CAS is itself
// completely untouched (its own SET clause never applied).
//
// lib/relationships/fact-accept.ts's planFactArchival/planFactAcceptance
// take this same gate as an optional parameter and AND it into every
// statement they build (donor_relationship_facts INSERT/UPDATE, their
// audit rows, and the donors relationship-snapshot CAS) -- every other
// caller of those functions passes no gate and is unaffected.
export type InteractionEditInput = {
  interactionId: string;
  userId: string;
  existingDonorId: string;
  donorId: string;
  type: InteractionKind;
  summary: string;
  casBaseline: string;
  source: string;
  occurredAtEpoch: number;
  now: number;
  reminderId: string;
  reminderDueAtEpoch: number | null;
  reminderNextAction: string;
  acceptRelationshipSnapshot: boolean;
  scheduled: boolean;
  note: string;
  subject: string;
};

export type InteractionEditOutcome =
  | { status: "applied"; relationshipUpdated: boolean }
  // Genuinely rejected -- the CAS missed, so NOTHING was written: not
  // the interaction row, not the reminder, not any relationship-fact
  // archival or acceptance statement. `currentSummary` is the row's
  // actual current value (null if the row vanished entirely, which
  // should not happen given the caller already confirmed ownership
  // moments earlier, but is never assumed).
  | { status: "conflict"; currentSummary: string | null };

export async function applyInteractionEdit(db: D1Database, input: InteractionEditInput): Promise<InteractionEditOutcome> {
  const writeToken = crypto.randomUUID();
  const gate: WriteGate = { sql: "EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)", params: [input.interactionId, writeToken] };

  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE interactions SET donor_id = ?, type = ?, occurred_at = ?, summary = ?, source = ?, write_token = ?, updated_at = ? WHERE id = ? AND user_id = ? AND summary = ?")
      .bind(input.donorId, input.type, input.occurredAtEpoch, input.summary, input.source, writeToken, input.now, input.interactionId, input.userId, input.casBaseline),
  ];

  if (input.reminderDueAtEpoch !== null) {
    statements.push(db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 94, 'open', ?, ?, ? WHERE ${gate.sql}
      ON CONFLICT(id) DO UPDATE SET donor_id = excluded.donor_id, action = excluded.action, reason = excluded.reason, status = 'open', due_at = excluded.due_at, updated_at = excluded.updated_at`)
      .bind(input.reminderId, input.donorId, input.userId, input.reminderNextAction, "Reminder requested for this activity.", input.reminderDueAtEpoch, input.now, input.now, ...gate.params));
  } else {
    statements.push(db.prepare(`DELETE FROM recommendations WHERE id = ? AND user_id = ? AND ${gate.sql}`).bind(input.reminderId, input.userId, ...gate.params));
  }

  if (input.donorId !== input.existingDonorId) {
    const archival = await planFactArchival({ donorId: input.existingDonorId, userId: input.userId, sourceInteractionId: input.interactionId, now: input.now }, gate);
    statements.push(...archival.statements);
  }

  let relationshipStatementIndex = -1;
  if (input.acceptRelationshipSnapshot && !input.scheduled) {
    const plan = await planFactAcceptance({
      donorId: input.donorId, userId: input.userId, sourceInteractionId: input.interactionId, sourceInteractionOccurredAt: input.occurredAtEpoch,
      noteText: input.note, kind: input.type, subject: input.subject, now: input.now,
    }, gate);
    if (plan.relationshipStatementIndex >= 0) relationshipStatementIndex = statements.length + plan.relationshipStatementIndex;
    statements.push(...plan.statements);
  }

  const results = await db.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    // The CAS missed -- every companion statement's gate also read
    // false in this SAME transaction, so nothing else changed either.
    const current = await db.prepare("SELECT summary FROM interactions WHERE id = ? AND user_id = ?").bind(input.interactionId, input.userId).first<{ summary: string }>();
    return { status: "conflict", currentSummary: current?.summary ?? null };
  }

  const relationshipUpdated = relationshipStatementIndex >= 0 && (results[relationshipStatementIndex]?.meta?.changes ?? 0) > 0;
  return { status: "applied", relationshipUpdated };
}
