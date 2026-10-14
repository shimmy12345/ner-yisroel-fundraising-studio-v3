// Concurrency-safe, persistent idempotency for the Daily Fundraising
// Agenda send (October 14 2026 incident -- docs/AI-HANDOFF.md). Pure
// query-building functions, directly unit-testable without a Workers
// runtime or a real D1 binding; the one caller (lib/agenda/send-agenda.ts)
// executes these against env.DB and is itself exercised only via source
// inspection and the real-sqlite end-to-end test
// (tests/agenda-send-idempotency-e2e.test.mjs), matching this codebase's
// established split for every other "cloudflare:workers"-importing file.
//
// --- Delivery semantics (read this before changing anything here) ---
//
// Gmail's send API has no idempotency-key support, so there is no way to
// make a single logical send request-level idempotent against Gmail
// itself -- "exactly once" is not achievable from this side alone. This
// design deliberately chooses AT-LEAST-ONCE delivery: on any ambiguous or
// failed outcome, the next eligible invocation is allowed to retry, which
// means an occasional genuine DUPLICATE email is accepted as the price of
// never silently missing a day. This matches the Daily Agenda's own
// existing failure philosophy (its scheduled handler already logs AND
// rethrows every send failure, rather than swallowing it) and this
// codebase's established preference (see lib/backup-alert/run.ts's own
// header comment) for "duplicate is annoying, silent miss is worse" on a
// low-stakes, single-recipient internal digest -- never a donor-facing or
// financial message.
//
// The mechanism: one row per (user, Eastern calendar day). A single
// atomic UPSERT claims the row (buildAgendaClaimQuery) -- D1/SQLite
// serializes concurrent writers, so of any number of simultaneous claim
// attempts for the same day, exactly one can ever succeed; every other
// invocation observes zero rows changed and must not send. After a
// successful send, a second statement marks the row 'sent'
// (buildAgendaSentCommitQuery) -- a 'sent' row can never be re-claimed
// (the claim query's WHERE clause only ever matches 'pending' rows),
// so once a send is confirmed, nothing can duplicate it for that day.
//
// If a claimed invocation fails (sendGmail throws) or is abandoned
// outright (the Worker is killed mid-flight, e.g. a crash or an
// exceeded CPU/wall-clock limit), its row is left 'pending' with
// whatever claimed_at the failed/abandoned attempt last wrote. There is
// deliberately no separate "release the claim on failure" step -- a row
// still 'pending' after AGENDA_CLAIM_STALE_AFTER_SECONDS is, by
// definition, eligible for the exact same atomic claim query to retry,
// so crash recovery and explicit-failure recovery share one code path
// rather than two.
//
// --- Remaining risk, disclosed rather than hidden ---
//
// Duplicate-send risk: if sendGmail's HTTP call to Gmail actually
// succeeds but the response is lost before this code observes success
// (a network partition, a Worker CPU-limit cutoff between the send and
// the commit), the row stays 'pending', a later invocation reclaims it
// after the staleness window, and genuinely sends a second real email
// for a day that was already, unknowably, delivered. This is the
// accepted cost of at-least-once semantics and cannot be fully closed
// without Gmail-side idempotency-key support, which does not exist.
//
// Missed-delivery risk: the claim-eligible window is bounded to the one
// Eastern-9am hour each day (isDailyAgendaSendHour). If every attempt
// made during that specific 60-minute window fails (e.g. a Gmail OAuth
// outage spanning the whole hour), the day's email is genuinely not
// sent, and no further automatic retry happens until the same hour the
// next day. This is visible, not silent: every failed attempt is still
// logged and rethrown by runScheduledAgendaSend, so it surfaces in
// Observability even though no user-facing retry occurs that day.

// How long a 'pending' claim is honored before a later invocation may
// steal it and retry. Generous enough that a normal Gmail OAuth refresh
// + send (observed well under a few seconds) is never mistaken for an
// abandoned attempt while it is still legitimately in flight -- which
// would otherwise risk two invocations sending concurrently -- while
// still short enough that a genuine crash or hang is retried promptly
// within the same 60-minute send-hour window rather than only the
// following day.
export const AGENDA_CLAIM_STALE_AFTER_SECONDS = 120;

export interface SqlQuery {
  sql: string;
  params: readonly (string | number)[];
}

// Atomically attempts to claim the (userId, sendDate) row for a real send
// attempt. Executes as a single D1/SQLite statement, so concurrent callers
// are naturally serialized by the database itself -- no application-level
// lock is needed. The caller must check the executed statement's reported
// changed-row count: exactly 1 means this invocation won the claim and
// must proceed to send; 0 means another invocation already holds a fresh
// claim, or this day was already sent, and this invocation must return
// without sending.
export function buildAgendaClaimQuery(userId: string, sendDate: string, now: number): SqlQuery {
  return {
    sql: `INSERT INTO agenda_send_log (user_id, send_date, status, claimed_at)
          VALUES (?, ?, 'pending', ?)
          ON CONFLICT(user_id, send_date) DO UPDATE SET claimed_at = excluded.claimed_at
            WHERE agenda_send_log.status = 'pending' AND agenda_send_log.claimed_at < ?`,
    params: [userId, sendDate, now, now - AGENDA_CLAIM_STALE_AFTER_SECONDS],
  };
}

// Marks a successfully-completed send as 'sent', permanently closing out
// that day's claim (the claim query above can never match a non-'pending'
// row again, regardless of how stale sent_at becomes). Scoped to
// status = 'pending' so this is itself a no-op, not an error, if somehow
// called twice for the same day.
export function buildAgendaSentCommitQuery(userId: string, sendDate: string, now: number): SqlQuery {
  return {
    sql: `UPDATE agenda_send_log SET status = 'sent', sent_at = ? WHERE user_id = ? AND send_date = ? AND status = 'pending'`,
    params: [now, userId, sendDate],
  };
}
