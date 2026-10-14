// Atomic, persistent, one-time claim for the temporary Production Gmail
// OAuth verification mechanism (October 14 2026 incident --
// docs/AI-HANDOFF.md). Pure query-building functions, directly
// unit-testable without a Workers runtime or a real D1 binding; the one
// caller (app/api/agenda/test-send/route.ts) executes these against
// env.DB.
//
// --- Why a single, hardcoded, global claim rather than a per-request or
// per-day key (contrast with lib/agenda/send-log.ts's AGENDA_CLAIM_STALE_
// AFTER_SECONDS reclaim design, which this deliberately does NOT reuse) ---
//
// This mechanism exists to run exactly once, ever, under direct human
// supervision -- not as a recurring background job that must tolerate
// crashes and retry automatically. `TEST_SEND_CLAIM_ID` is a single fixed
// sentinel value: the very first successful `INSERT ... ON CONFLICT(id)
// DO NOTHING` permanently consumes it, and nothing -- a retry, a
// concurrent request, a crashed attempt, a later deploy -- can ever claim
// it again. There is deliberately no staleness window and no reclaim
// path, unlike the recurring daily agenda's own claim: if this one
// attempt fails, a human must explicitly clear the row (or the table)
// before a second real attempt is possible, which is the intended,
// tightly-controlled behavior here, not a gap.
//
// This value has been advanced twice already: the original
// "2026-10-14-production-gmail-oauth-verification" claim recorded a failed
// bare-401 attempt, and "...-verification-2" recorded a failed 401
// (unauthorized_client) attempt after the diagnostic code was added (see
// docs/AI-HANDOFF.md for both). Both rows are untouched and permanent --
// changing this constant to a new, distinct id is the entire mechanism for
// authorizing exactly one more attempt; it does not reset, delete, or in
// any way affect either prior row, which remain keyed by their own,
// different ids in the same table.
export const TEST_SEND_CLAIM_ID = "2026-10-14-production-gmail-oauth-verification-3";

export interface SqlQuery {
  sql: string;
  params: readonly (string | number | null)[];
}

// Atomically attempts to claim the one-time test-send slot. A single
// D1/SQLite statement, so concurrent or repeated callers are naturally
// serialized by the database itself. The caller must check the executed
// statement's reported changed-row count: exactly 1 means this invocation
// won the claim and must proceed; 0 means the claim was already taken
// (pending, sent, or failed -- all three permanently block any further
// claim, by design) and this invocation must refuse, never send.
export function buildTestSendClaimQuery(userId: string, now: number): SqlQuery {
  return {
    sql: `INSERT INTO agenda_manual_test_send_log (id, user_id, status, claimed_at)
          VALUES (?, ?, 'pending', ?)
          ON CONFLICT(id) DO NOTHING`,
    params: [TEST_SEND_CLAIM_ID, userId, now],
  };
}

// Marks the claimed attempt as successfully sent -- a permanent, terminal
// state. Scoped to status = 'pending' so this is a no-op, not an error,
// if ever called more than once for the same claim. `messageId` is
// Gmail's own opaque message id (see gmail-client.ts's own header comment
// on why that one field alone is safe to store) recorded into the same
// `outcome` column the failure path uses for its error message -- never a
// credential or token, and optional since an older/different send path
// might not have one to report.
export function buildTestSendCommitQuery(now: number, messageId?: string): SqlQuery {
  return {
    sql: `UPDATE agenda_manual_test_send_log SET status = 'sent', sent_at = ?, outcome = ? WHERE id = ? AND status = 'pending'`,
    params: [now, messageId ?? null, TEST_SEND_CLAIM_ID],
  };
}

// Records a failed attempt -- also permanent and terminal (see this
// file's own header comment on why there is no reclaim path). `outcome`
// is the caught error's own `.message` only, matching gmail-client.ts's
// own established discipline: never a response body, never anything that
// could echo a credential or token value.
export function buildTestSendFailureQuery(now: number, outcome: string): SqlQuery {
  return {
    sql: `UPDATE agenda_manual_test_send_log SET status = 'failed', sent_at = ?, outcome = ? WHERE id = ? AND status = 'pending'`,
    params: [now, outcome, TEST_SEND_CLAIM_ID],
  };
}
