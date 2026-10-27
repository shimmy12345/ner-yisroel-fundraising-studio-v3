import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildAgendaClaimQuery,
  buildAgendaSentCommitQuery,
  buildAgendaSendStateQuery,
  resolveAgendaSendState,
  decideAgendaSendAction,
  AGENDA_CLAIM_STALE_AFTER_SECONDS,
} from "../lib/agenda/send-log.ts";
import { isDailyAgendaSendHour, isDailyAgendaRecoveryHour } from "../lib/agenda/timezone.ts";

// Same-day recovery window for the Daily Fundraising Agenda send
// (2026-10-27 missed-send investigation -- docs/AI-HANDOFF.md). On that
// date, Production's 9 AM tick never reached the claim INSERT at all --
// zero agenda_send_log row for the day, confirmed hours later by direct
// D1 read and independently by a Gmail search. This file covers the
// five scenarios that round's fix was required to handle: normal
// delivery, missed execution, successful recovery, duplicate prevention
// (including overlapping cron executions), and uncertain send status.
//
// Two layers, matching this codebase's established pure/impure split:
//   1. Pure decision-matrix assertions against decideAgendaSendAction
//      and resolveAgendaSendState -- no D1, no sqlite, every input
//      combination.
//   2. A real node:sqlite database built from the actual committed
//      migrations (same technique as
//      tests/agenda-send-idempotency-e2e.test.mjs), exercising the real
//      buildAgendaClaimQuery/buildAgendaSentCommitQuery/
//      buildAgendaSendStateQuery SQL verbatim, orchestrated through a
//      thin `simulateTick()` helper in this file that mirrors
//      lib/agenda/send-agenda.ts's runScheduledAgendaSend exactly (same
//      order of operations, same functions) but with the actual Gmail
//      send stubbed -- there is no reimplemented SQL anywhere in this
//      file, and no real Workers runtime or Gmail call either.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

function seedUser(db, userId = "u1", now = 0) {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, now, now);
}

function readRow(db, userId, sendDate) {
  return db.prepare("SELECT status, claimed_at, sent_at FROM agenda_send_log WHERE user_id = ? AND send_date = ?").get(userId, sendDate);
}

function readState(db, userId, sendDate) {
  const query = buildAgendaSendStateQuery(userId, sendDate);
  const row = db.prepare(query.sql).get(...query.params);
  return resolveAgendaSendState(row ?? null);
}

function claim(db, userId, sendDate, now) {
  const query = buildAgendaClaimQuery(userId, sendDate, now);
  return db.prepare(query.sql).run(...query.params);
}

function commitSent(db, userId, sendDate, now) {
  const query = buildAgendaSentCommitQuery(userId, sendDate, now);
  return db.prepare(query.sql).run(...query.params);
}

// Mirrors runScheduledAgendaSend's real control flow one-for-one (hour
// gate -> conditional state read -> decideAgendaSendAction -> claim ->
// send -> commit), using only the real exported query builders and the
// real pure decision function -- the one thing it does NOT do is call
// the real sendDailyAgenda()/sendGmail(), which require a Workers
// runtime; `sendResult` stands in for that one call so each scenario can
// choose "succeeds" or "throws" without ever touching a real credential.
function simulateTick(db, userId, sendDate, now, sendResult = "succeeds") {
  const isSendHour = isDailyAgendaSendHour(now);
  const isRecoveryHour = isDailyAgendaRecoveryHour(now);
  if (!isSendHour && !isRecoveryHour) return { action: "outside_window", claimed: false, sent: false };

  const state = isRecoveryHour ? readState(db, userId, sendDate) : null;
  const action = decideAgendaSendAction({ isSendHour, isRecoveryHour, state });
  if (action === "skip_already_sent" || action === "skip_uncertain_status") {
    return { action, claimed: false, sent: false };
  }

  const claimResult = claim(db, userId, sendDate, now);
  if (Number(claimResult.changes) === 0) return { action, claimed: false, sent: false };

  if (sendResult === "throws") return { action, claimed: true, sent: false };
  commitSent(db, userId, sendDate, now);
  return { action, claimed: true, sent: true };
}

// A fixed 2026-10-27-style calendar day, expressed as the real UTC
// instants for each Eastern hour this file cares about (EDT, UTC-4,
// still in effect -- DST does not end until 2026-11-01).
const SEND_DATE = "2026-10-27";
const NINE_AM = Math.floor(Date.parse("2026-10-27T13:00:00Z") / 1000);
const TEN_AM = Math.floor(Date.parse("2026-10-27T14:00:00Z") / 1000);
const ELEVEN_AM = Math.floor(Date.parse("2026-10-27T15:00:00Z") / 1000);
const NOON = Math.floor(Date.parse("2026-10-27T16:00:00Z") / 1000);

async function run() {
  // =====================================================================
  // 1. Pure decision matrix -- every (isSendHour, isRecoveryHour, state)
  //    combination that can actually occur, no D1 involved.
  // =====================================================================
  {
    assert.equal(decideAgendaSendAction({ isSendHour: false, isRecoveryHour: false, state: null }), "outside_window", "neither window: no-op, matching the pre-existing 23-of-24-hours behavior");
    assert.equal(decideAgendaSendAction({ isSendHour: true, isRecoveryHour: false, state: null }), "attempt_send", "the primary 9 AM hour is unconditional, exactly as before this round -- state is never even consulted");
    assert.equal(decideAgendaSendAction({ isSendHour: false, isRecoveryHour: true, state: "absent" }), "attempt_send", "recovery hour + no row for today at all = safe, unambiguous recovery");
    assert.equal(decideAgendaSendAction({ isSendHour: false, isRecoveryHour: true, state: "sent" }), "skip_already_sent", "recovery hour + already sent = nothing to do");
    assert.equal(decideAgendaSendAction({ isSendHour: false, isRecoveryHour: true, state: "pending" }), "skip_uncertain_status", "recovery hour + a claim of uncertain outcome = never auto-retry, per this round's explicit requirement");

    assert.equal(resolveAgendaSendState(null), "absent");
    assert.equal(resolveAgendaSendState(undefined), "absent");
    assert.equal(resolveAgendaSendState({ status: "sent" }), "sent");
    assert.equal(resolveAgendaSendState({ status: "pending" }), "pending");
    assert.equal(resolveAgendaSendState({ status: "some-future-status-this-code-has-never-seen" }), "pending", "an unrecognized status must fail toward the conservative never-auto-retry branch, not toward 'absent'");
  }

  // =====================================================================
  // 2. Normal delivery -- the 9 AM path is unchanged by this round. Real
  //    DB proof, not just the decision matrix above.
  // =====================================================================
  {
    const db = freshDatabase();
    seedUser(db);
    const result = simulateTick(db, "u1", SEND_DATE, NINE_AM);
    assert.equal(result.action, "attempt_send");
    assert.equal(result.sent, true);
    assert.equal(readRow(db, "u1", SEND_DATE).status, "sent", "a normal 9 AM send must still result in a 'sent' row exactly as before this round");

    // The schedule's own close: 10/11 AM after a successful 9 AM send
    // must be a no-op, never a second send.
    const tenAmAfterSuccess = simulateTick(db, "u1", SEND_DATE, TEN_AM);
    assert.equal(tenAmAfterSuccess.action, "skip_already_sent");
    assert.equal(tenAmAfterSuccess.sent, false);
  }

  // =====================================================================
  // 3. Missed execution + successful recovery -- the exact 2026-10-27
  //    incident: no row at all survives past 9 AM (the real, observed
  //    failure mode -- execution never reached the claim). The next
  //    hourly tick, now in the recovery window, must recover it exactly
  //    once, and the window must then correctly recognize the day is
  //    done.
  // =====================================================================
  {
    const db = freshDatabase();
    seedUser(db);
    assert.equal(readRow(db, "u1", SEND_DATE), undefined, "precondition: no row exists yet, matching the real incident");

    // The 9 AM tick is deliberately never simulated here -- it is the one
    // that was missed. The very next tick is the 10 AM recovery tick.
    const recovered = simulateTick(db, "u1", SEND_DATE, TEN_AM);
    assert.equal(recovered.action, "attempt_send", "an absent row at the first recovery-window tick must be treated as safe to recover");
    assert.equal(recovered.sent, true, "the recovery attempt must actually result in a send");
    assert.equal(readRow(db, "u1", SEND_DATE).status, "sent");

    // The window's second tick (11 AM) must see it is already done and
    // do nothing -- preventing a duplicate within the recovery window
    // itself.
    const secondTick = simulateTick(db, "u1", SEND_DATE, ELEVEN_AM);
    assert.equal(secondTick.action, "skip_already_sent");
    assert.equal(secondTick.sent, false);

    // And the window's firm close (noon) is a no-op regardless of state.
    const afterWindow = simulateTick(db, "u1", SEND_DATE, NOON);
    assert.equal(afterWindow.action, "outside_window");
  }

  // =====================================================================
  // 4. Duplicate prevention, including overlapping cron executions --
  //    two invocations of the SAME recovery-hour tick (a genuine
  //    Cloudflare duplicate cron delivery, the same class of event
  //    tests/agenda-send-idempotency-e2e.test.mjs already proves for the
  //    primary 9 AM hour) must never both send. Both see "absent"
  //    (neither has committed yet) and both reach the real atomic claim
  //    query -- exactly one must win.
  // =====================================================================
  {
    const db = freshDatabase();
    seedUser(db);
    const stateBeforeEither = readState(db, "u1", SEND_DATE);
    assert.equal(stateBeforeEither, "absent");

    const first = simulateTick(db, "u1", SEND_DATE, TEN_AM);
    // The second "overlapping" invocation is simulated at the exact same
    // instant, after the first has already claimed (and sent) --
    // reusing claim() directly (not simulateTick, since by the time this
    // second invocation's own state-read would run, the row is no longer
    // absent -- the real-world race is at the claim statement itself,
    // which is exactly what this asserts).
    const secondClaimAttempt = claim(db, "u1", SEND_DATE, TEN_AM);
    assert.equal(first.sent, true, "the winning invocation must complete its send");
    assert.equal(Number(secondClaimAttempt.changes), 0, "a second, overlapping claim attempt at the same instant must change zero rows -- the existing atomic UPSERT's concurrency guarantee, now exercised by the recovery window too");
    assert.equal(readRow(db, "u1", SEND_DATE).status, "sent", "only one send's commit may ever be reflected");
  }

  // =====================================================================
  // 5. Uncertain send status -- a 'pending' row exists (a 9 AM claim was
  //    made and a send was genuinely attempted; its outcome is unknown)
  //    by the time a recovery-hour tick runs. Per this round's explicit
  //    requirement, this must NEVER be auto-retried, even though the
  //    existing claim query's own staleness window would, by itself,
  //    treat this exact row as reclaimable.
  // =====================================================================
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", SEND_DATE, NINE_AM); // simulates the 9 AM attempt making its claim, then never resolving (crash, or Gmail outcome unknown)
    assert.equal(readRow(db, "u1", SEND_DATE).status, "pending");

    const recoveryTick = simulateTick(db, "u1", SEND_DATE, TEN_AM);
    assert.equal(recoveryTick.action, "skip_uncertain_status", "a pending claim must be surfaced for investigation, never silently retried");
    assert.equal(recoveryTick.claimed, false, "the recovery path must never even attempt the claim statement when the status is uncertain");
    assert.equal(readRow(db, "u1", SEND_DATE).status, "pending", "the row itself must be left exactly as-is for manual investigation");

    // Contrast proof: by TEN_AM (one hour after the NINE_AM claim, well
    // past AGENDA_CLAIM_STALE_AFTER_SECONDS), the row IS, in isolation,
    // old enough that the raw claim query would normally treat it as
    // reclaimable -- demonstrating precisely why the recovery path must
    // check state first rather than ever calling the plain claim query
    // unconditionally during the recovery window.
    assert.ok(TEN_AM - NINE_AM > AGENDA_CLAIM_STALE_AFTER_SECONDS, "sanity check: the gap between 9 AM and 10 AM exceeds the staleness window");
    const rawClaimWouldSucceed = claim(db, "u1", SEND_DATE, TEN_AM);
    assert.equal(Number(rawClaimWouldSucceed.changes), 1, "the underlying claim query alone (not this round's own state-check gate) would have reclaimed and resent -- proving the state check is the thing actually preventing an ambiguous retry");
  }

  // =====================================================================
  // 6. Window boundaries -- the recovery window opens at 10 AM and closes
  //    before noon; nothing outside [10, 12) Eastern ever attempts
  //    anything, regardless of today's state.
  // =====================================================================
  {
    assert.equal(isDailyAgendaRecoveryHour(NINE_AM), false, "9 AM is the primary hour, not the recovery window");
    assert.equal(isDailyAgendaRecoveryHour(TEN_AM), true);
    assert.equal(isDailyAgendaRecoveryHour(ELEVEN_AM), true);
    assert.equal(isDailyAgendaRecoveryHour(NOON), false, "noon is deliberately the first tick that does not attempt recovery");

    const db = freshDatabase();
    seedUser(db);
    const atNoonWithNoRowEver = simulateTick(db, "u1", SEND_DATE, NOON);
    assert.equal(atNoonWithNoRowEver.action, "outside_window");
    assert.equal(readRow(db, "u1", SEND_DATE), undefined, "a tick outside both windows must never write anything, even when today's send is still genuinely missing");
  }

  console.log("agenda-recovery: all assertions passed");
}

await run();
