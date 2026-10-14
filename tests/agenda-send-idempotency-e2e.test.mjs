import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildAgendaClaimQuery, buildAgendaSentCommitQuery, AGENDA_CLAIM_STALE_AFTER_SECONDS } from "../lib/agenda/send-log.ts";

// October 14 2026 email incident (docs/AI-HANDOFF.md) -- concurrency-safe,
// persistent idempotency for the Daily Fundraising Agenda send. Real
// node:sqlite database built from the actual committed migrations
// (including this round's 0043_agenda_send_log.sql), exercising the REAL
// query strings buildAgendaClaimQuery/buildAgendaSentCommitQuery produce
// (lib/agenda/send-agenda.ts imports and executes these verbatim against
// env.DB -- never reimplemented here), so a real SQL/SQLite bug in the
// claim's UPSERT or its staleness WHERE clause would fail this test, not
// just a reimplemented stand-in. No real donor data anywhere in this
// file -- every row is a synthetic fixture.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-10-14T13:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}

function claim(db, userId, sendDate, now) {
  const query = buildAgendaClaimQuery(userId, sendDate, now);
  return db.prepare(query.sql).run(...query.params);
}

function commitSent(db, userId, sendDate, now) {
  const query = buildAgendaSentCommitQuery(userId, sendDate, now);
  return db.prepare(query.sql).run(...query.params);
}

function row(db, userId, sendDate) {
  return db.prepare("SELECT status, claimed_at, sent_at FROM agenda_send_log WHERE user_id = ? AND send_date = ?").get(userId, sendDate);
}

async function run() {
  // --- 1. A fresh claim succeeds exactly once. ---
  {
    const db = freshDatabase();
    seedUser(db);
    const result = claim(db, "u1", "2026-10-14", NOW);
    assert.equal(Number(result.changes), 1, "a fresh claim must report exactly one changed row");
    const stored = row(db, "u1", "2026-10-14");
    assert.equal(stored.status, "pending");
    assert.equal(stored.sent_at, null);
  }

  // --- 2. Simultaneous/second claim attempt for the same (user, day),
  // while the first claim is still fresh, must NOT succeed -- this is the
  // concurrency-safety property: two overlapping scheduled() invocations
  // (a genuine double-fire, or exactly the October 14 failure mode of a
  // lingering Staging trigger alongside Production's own) must never both
  // believe they own the send. ---
  {
    const db = freshDatabase();
    seedUser(db);
    const first = claim(db, "u1", "2026-10-14", NOW);
    assert.equal(Number(first.changes), 1);
    const second = claim(db, "u1", "2026-10-14", NOW + 1);
    assert.equal(Number(second.changes), 0, "a second claim attempt while the first is still fresh must change zero rows");
    const stored = row(db, "u1", "2026-10-14");
    assert.equal(stored.status, "pending");
    assert.equal(stored.claimed_at, NOW, "the losing claim attempt must never overwrite the winner's claimed_at");
  }

  // --- 3. Once marked 'sent', the day can never be re-claimed again --
  // not immediately, and not even after the staleness window would
  // otherwise allow a reclaim for a still-'pending' row. This is what
  // makes a confirmed send permanent. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", "2026-10-14", NOW);
    const committed = commitSent(db, "u1", "2026-10-14", NOW + 5);
    assert.equal(Number(committed.changes), 1, "the commit must successfully close out the pending claim it owns");
    assert.equal(row(db, "u1", "2026-10-14").status, "sent");

    const immediateRetry = claim(db, "u1", "2026-10-14", NOW + 6);
    assert.equal(Number(immediateRetry.changes), 0, "a 'sent' day must never be re-claimed immediately");

    const farFutureRetry = claim(db, "u1", "2026-10-14", NOW + AGENDA_CLAIM_STALE_AFTER_SECONDS * 1000);
    assert.equal(Number(farFutureRetry.changes), 0, "a 'sent' day must never be re-claimed no matter how much time passes -- staleness only ever applies to 'pending' rows");
  }

  // --- 4. Crash/failure recovery: a 'pending' claim older than
  // AGENDA_CLAIM_STALE_AFTER_SECONDS (an attempt that threw, or a Worker
  // that was killed mid-flight before ever reaching the commit) IS
  // eligible to be reclaimed and retried. This is the deliberate
  // at-least-once choice -- see send-log.ts's own header comment. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", "2026-10-14", NOW);
    // Not yet stale: one second short of the threshold must still refuse.
    const tooSoon = claim(db, "u1", "2026-10-14", NOW + AGENDA_CLAIM_STALE_AFTER_SECONDS - 1);
    assert.equal(Number(tooSoon.changes), 0, "a 'pending' claim must not be reclaimable before it is actually stale");

    const reclaim = claim(db, "u1", "2026-10-14", NOW + AGENDA_CLAIM_STALE_AFTER_SECONDS + 1);
    assert.equal(Number(reclaim.changes), 1, "a 'pending' claim older than the staleness window must be reclaimable");
    assert.equal(row(db, "u1", "2026-10-14").claimed_at, NOW + AGENDA_CLAIM_STALE_AFTER_SECONDS + 1, "reclaiming must update claimed_at to the new attempt's own timestamp");

    // The reclaiming attempt can still complete normally afterward.
    const committed = commitSent(db, "u1", "2026-10-14", NOW + AGENDA_CLAIM_STALE_AFTER_SECONDS + 2);
    assert.equal(Number(committed.changes), 1);
    assert.equal(row(db, "u1", "2026-10-14").status, "sent");
  }

  // --- 5. Different Eastern calendar days for the same user are fully
  // independent -- yesterday's claim (sent, pending, or stale) must never
  // block or interfere with today's. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", "2026-10-13", NOW - 86400);
    commitSent(db, "u1", "2026-10-13", NOW - 86400 + 5);
    const today = claim(db, "u1", "2026-10-14", NOW);
    assert.equal(Number(today.changes), 1, "a prior day's sent claim must never block a new day's claim");
    assert.equal(row(db, "u1", "2026-10-13").status, "sent", "a prior day's row must be untouched by claiming a different day");
  }

  // --- 6. Different users are fully independent. ---
  {
    const db = freshDatabase();
    seedUser(db, "u1");
    seedUser(db, "u2");
    claim(db, "u1", "2026-10-14", NOW);
    commitSent(db, "u1", "2026-10-14", NOW + 5);
    const otherUser = claim(db, "u2", "2026-10-14", NOW + 6);
    assert.equal(Number(otherUser.changes), 1, "one user's sent claim must never block a different user's claim for the same calendar day");
  }

  console.log("agenda-send-idempotency-e2e: all assertions passed");
}

await run();
