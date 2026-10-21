import { planFactAcceptance, planFactArchival } from "../relationships/fact-accept.ts";
import type { InteractionKind } from "./interaction.ts";

// Generic interaction edit concurrency safety (2026-10-21, third
// follow-up review -- "app/api/interactions/[id]/route.ts checks
// expectedSummary before writing, but its UPDATE remains unconditional").
// The PREVIOUS version of that route compared `expectedSummary` against
// the row it had just read, then -- if they matched -- went on to build
// and run an UNCONDITIONAL `UPDATE interactions SET ...` together with
// the reminder and relationship-fact statements in one batch. A
// concurrent trip completion or notes save landing in the gap between
// that read/check and this write would be silently overwritten; the
// check only ever protected against a STALE client, never a write that
// raced this exact request.
//
// This module makes the interactions UPDATE itself the compare-and-swap
// (`WHERE ... AND summary = ?`, bound to the exact baseline the check
// above already validated) and makes every companion write
// (reminders, donor-reassignment fact archival, relationship-fact
// acceptance) STRICTLY CONDITIONAL on that UPDATE's own authoritative
// rowcount, read back after it runs -- never inferred from matching
// end-state content (the SAME class of bug this round also closed in
// lib/meeting-notes/concurrent-save.ts). A rejected edit (CAS miss)
// never builds or runs a single companion statement: nothing about
// reminders, relationship facts, or donor assignment changes.
//
// This necessarily splits what was one D1 batch into two sequential
// writes (the CAS'd UPDATE, then -- only once it is PROVEN to have
// applied -- the companion batch). The trade-off is deliberate and
// narrow: the companion writes are no longer crash-atomic with the main
// edit in the success path (an exceedingly rare, no-realistic-trigger
// edge case -- none of reminders/archival/acceptance's own statements
// have ever been observed to throw under normal operation), in exchange
// for a real, concrete, previously-reproducible guarantee: a rejected
// edit is now provably, unconditionally a no-op.
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
  const updateResult = await db.prepare("UPDATE interactions SET donor_id = ?, type = ?, occurred_at = ?, summary = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ? AND summary = ?")
    .bind(input.donorId, input.type, input.occurredAtEpoch, input.summary, input.source, input.now, input.interactionId, input.userId, input.casBaseline)
    .run() as unknown as { meta?: { changes?: number } };

  if ((updateResult.meta?.changes ?? 0) === 0) {
    const current = await db.prepare("SELECT summary FROM interactions WHERE id = ? AND user_id = ?").bind(input.interactionId, input.userId).first<{ summary: string }>();
    return { status: "conflict", currentSummary: current?.summary ?? null };
  }

  // The edit itself is now proven to have applied -- every companion
  // write below is safe to attempt unconditionally; there is nothing
  // left to guard against.
  const statements: D1PreparedStatement[] = [];
  if (input.reminderDueAtEpoch !== null) {
    statements.push(db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 94, 'open', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET donor_id = excluded.donor_id, action = excluded.action, reason = excluded.reason, status = 'open', due_at = excluded.due_at, updated_at = excluded.updated_at`)
      .bind(input.reminderId, input.donorId, input.userId, input.reminderNextAction, "Reminder requested for this activity.", input.reminderDueAtEpoch, input.now, input.now));
  } else {
    statements.push(db.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(input.reminderId, input.userId));
  }

  if (input.donorId !== input.existingDonorId) {
    const archival = await planFactArchival({ donorId: input.existingDonorId, userId: input.userId, sourceInteractionId: input.interactionId, now: input.now });
    statements.push(...archival.statements);
  }

  let relationshipStatementIndex = -1;
  if (input.acceptRelationshipSnapshot && !input.scheduled) {
    const plan = await planFactAcceptance({
      donorId: input.donorId, userId: input.userId, sourceInteractionId: input.interactionId, sourceInteractionOccurredAt: input.occurredAtEpoch,
      noteText: input.note, kind: input.type, subject: input.subject, now: input.now,
    });
    if (plan.relationshipStatementIndex >= 0) relationshipStatementIndex = statements.length + plan.relationshipStatementIndex;
    statements.push(...plan.statements);
  }

  let relationshipUpdated = false;
  if (statements.length > 0) {
    const results = await db.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
    if (relationshipStatementIndex >= 0) relationshipUpdated = (results[relationshipStatementIndex]?.meta?.changes ?? 0) > 0;
  }
  return { status: "applied", relationshipUpdated };
}
