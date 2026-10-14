import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildTestSendClaimQuery, buildTestSendCommitQuery, buildTestSendFailureQuery, TEST_SEND_CLAIM_ID } from "../lib/agenda/test-send-log.ts";

// October 14 2026 incident (docs/AI-HANDOFF.md) -- the temporary
// Production Gmail OAuth verification mechanism's atomic, persistent,
// one-time claim. Real node:sqlite database built from the actual
// committed migrations (including this round's
// 0044_agenda_manual_test_send_log.sql), exercising the REAL query
// strings buildTestSendClaimQuery/buildTestSendCommitQuery/
// buildTestSendFailureQuery produce (app/api/agenda/test-send/route.ts
// imports and executes these verbatim against env.DB -- never
// reimplemented here). No real donor data anywhere in this file.
//
// Unlike tests/agenda-send-idempotency-e2e.test.mjs (the recurring daily
// agenda's own claim, which deliberately allows a stale claim to be
// reclaimed after a timeout), this mechanism is a true one-time-ever
// action: the central property under test is that NOTHING -- a
// concurrent request, an immediate retry, a retry after the first
// attempt succeeded, or a retry after the first attempt failed -- can
// ever claim the slot a second time. There is no staleness window and
// no reclaim path by design.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-10-14T16:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, "owner@example.test", NOW, NOW);
}

function claim(db, userId, now) {
  const query = buildTestSendClaimQuery(userId, now);
  return db.prepare(query.sql).run(...query.params);
}

function commitSent(db, now) {
  const query = buildTestSendCommitQuery(now);
  return db.prepare(query.sql).run(...query.params);
}

function commitFailed(db, now, outcome) {
  const query = buildTestSendFailureQuery(now, outcome);
  return db.prepare(query.sql).run(...query.params);
}

function row(db) {
  return db.prepare("SELECT id, user_id, status, claimed_at, sent_at, outcome FROM agenda_manual_test_send_log WHERE id = ?").get(TEST_SEND_CLAIM_ID);
}

async function run() {
  // --- 1. A fresh claim succeeds exactly once. ---
  {
    const db = freshDatabase();
    seedUser(db);
    const result = claim(db, "u1", NOW);
    assert.equal(Number(result.changes), 1, "a fresh claim must report exactly one changed row");
    const stored = row(db);
    assert.equal(stored.status, "pending");
    assert.equal(stored.user_id, "u1");
    assert.equal(stored.sent_at, null);
  }

  // --- 2. Concurrent / immediate-retry claim attempts all fail -- the
  // core atomicity property this mechanism exists to guarantee. ---
  {
    const db = freshDatabase();
    seedUser(db);
    const first = claim(db, "u1", NOW);
    assert.equal(Number(first.changes), 1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = claim(db, "u1", NOW + attempt + 1);
      assert.equal(Number(retry.changes), 0, `retry attempt ${attempt} while the first claim is still pending must change zero rows`);
    }
    assert.equal(row(db).claimed_at, NOW, "no retry may ever overwrite the original claim's timestamp");
  }

  // --- 3. Once marked 'sent', the claim can NEVER be reclaimed again --
  // not immediately, and not after any amount of time (unlike the
  // recurring daily agenda's own claim, there is no staleness window at
  // all for this one-time mechanism). ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", NOW);
    const committed = commitSent(db, NOW + 5);
    assert.equal(Number(committed.changes), 1);
    assert.equal(row(db).status, "sent");

    const immediateRetry = claim(db, "u1", NOW + 6);
    assert.equal(Number(immediateRetry.changes), 0, "a 'sent' claim must never be reclaimed immediately");

    const farFutureRetry = claim(db, "u1", NOW + 100_000_000);
    assert.equal(Number(farFutureRetry.changes), 0, "a 'sent' claim must never be reclaimed no matter how much time passes -- there is no staleness window for this one-time mechanism");
  }

  // --- 4. Once marked 'failed', the claim is ALSO permanently
  // terminal -- deliberately, unlike the recurring daily agenda's own
  // claim, which allows a stale 'pending' row to be reclaimed after a
  // failure. This mechanism requires a human to explicitly clear the row
  // before any second real attempt is possible. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", NOW);
    const failed = commitFailed(db, NOW + 5, "Gmail send failed: HTTP 401 Unauthorized");
    assert.equal(Number(failed.changes), 1);
    const stored = row(db);
    assert.equal(stored.status, "failed");
    assert.equal(stored.outcome, "Gmail send failed: HTTP 401 Unauthorized");
    assert.doesNotMatch(stored.outcome, /client_secret|refresh_token|Bearer /i, "the recorded outcome must never contain a credential or token value");

    const immediateRetry = claim(db, "u1", NOW + 6);
    assert.equal(Number(immediateRetry.changes), 0, "a 'failed' claim must never be automatically reclaimed -- no retry path exists for this one-time mechanism");

    const farFutureRetry = claim(db, "u1", NOW + 100_000_000);
    assert.equal(Number(farFutureRetry.changes), 0, "a 'failed' claim must never become reclaimable no matter how much time passes");
  }

  // --- 5. A still-'pending' claim (e.g. the Worker crashed mid-flight)
  // is ALSO never automatically reclaimed -- the complete opposite of
  // the recurring daily agenda's own stale-claim-reclaim design, and
  // exactly the intended behavior for a mechanism meant to run exactly
  // once under direct human supervision. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", NOW);
    const muchLaterRetry = claim(db, "u1", NOW + 100_000_000);
    assert.equal(Number(muchLaterRetry.changes), 0, "a still-'pending' claim must never be automatically reclaimed, regardless of elapsed time");
    assert.equal(row(db).status, "pending", "an abandoned pending claim stays pending forever -- only an explicit, deliberate human action (clearing the row) could ever allow a second attempt");
  }

  // --- 6. This mechanism's claim is completely independent of the real
  // daily agenda's own agenda_send_log idempotency table -- confirmed by
  // using a real, separate table (not just a different key within the
  // same one), so it is structurally impossible for this mechanism to
  // mark any calendar date (including October 15) as sent in that
  // other table. ---
  {
    const db = freshDatabase();
    seedUser(db);
    claim(db, "u1", NOW);
    commitSent(db, NOW + 5);
    const agendaSendLogCount = db.prepare("SELECT COUNT(*) AS count FROM agenda_send_log").get().count;
    assert.equal(agendaSendLogCount, 0, "a successful test-send claim must leave the real agenda_send_log table completely untouched");
  }

  console.log("agenda-test-send-idempotency-e2e: all assertions passed");
}

await run();
