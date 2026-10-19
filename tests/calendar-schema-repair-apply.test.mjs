import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  PhaseError,
  normalizeRow,
  normalizeRows,
  looksLikeCleanRejection,
  snapshotCalendarTablesViaBinding,
  verifyBackupRestoresAndMatches,
  describeFailure,
} from "../lib/operations/calendar-schema-repair-apply.ts";

// Exercises scripts/apply-0049-calendar-schema-repair-staging.mjs's own
// verification and error-reporting logic via injected dependencies --
// node:sqlite (local, built-in) and hand-constructed D1-shaped plain
// objects standing in for the real binding/CLI. No D1, no wrangler, no
// network, no credentials of any kind. These functions are the ones the
// real script calls; nothing here is a reimplementation.

test("normalizeRow fixes a REAL, reproduced bug: a raw node:sqlite row's null prototype fails assert.deepEqual against an identical D1-shaped plain object", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("x", 5);
  const sqliteRow = db.prepare("SELECT * FROM t").get();
  db.close();

  assert.equal(Object.getPrototypeOf(sqliteRow), null, "sanity: a real node:sqlite row really does have a null prototype");
  const d1ShapedRow = { id: "x", n: 5 };

  // The bug this fixes, reproduced directly: identical column values,
  // but assert.deepEqual (deepStrictEqual under node:assert/strict)
  // still throws, purely because of the prototype mismatch.
  assert.throws(() => assert.deepEqual(sqliteRow, d1ShapedRow));

  const normalized = normalizeRow(sqliteRow);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.deepEqual(normalized, d1ShapedRow);
  assert.deepEqual(normalized, { id: "x", n: 5 }, "every column value and type must be preserved exactly, nothing added or dropped");
});

test("normalizeRows preserves exact column values/types (including NULL and REAL) across a real node:sqlite result set", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, f REAL, nul TEXT)");
  db.prepare("INSERT INTO t (id, n, f, nul) VALUES (?,?,?,?)").run("a", 1, 1.5, null);
  const rows = db.prepare("SELECT * FROM t").all();
  db.close();

  const normalized = normalizeRows(rows);
  assert.deepEqual(normalized, [{ id: "a", n: 1, f: 1.5, nul: null }]);
  assert.equal(Object.getPrototypeOf(normalized[0]), Object.prototype);
});

test("looksLikeCleanRejection recognizes specific, provable SQL/constraint rejections", () => {
  for (const message of [
    "SQLITE_CONSTRAINT: NOT NULL constraint failed",
    "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
    "D1_ERROR: no such table: this_table_absolutely_does_not_exist_0049",
    'near "CREATE": syntax error',
  ]) {
    assert.equal(looksLikeCleanRejection(new Error(message)), true, `expected a clean rejection for: ${message}`);
  }
});

test("looksLikeCleanRejection treats a generic/unrecognized D1_ERROR as UNCERTAIN, never a confirmed rejection", () => {
  for (const message of ["D1_ERROR: Internal error", "D1_ERROR", "fetch failed", "ECONNRESET", "The operation was aborted due to timeout"]) {
    assert.equal(looksLikeCleanRejection(new Error(message)), false, `expected UNCERTAIN (not a clean rejection) for: ${message}`);
  }
});

test("snapshotCalendarTablesViaBinding reads both tables through an injected D1-like binding and normalizes the rows", async () => {
  const calls = [];
  const fakeDb = {
    prepare(sql) {
      calls.push(sql);
      return {
        async all() {
          if (sql.includes("calendar_event_links")) return { results: [{ id: "link-1", sync_status: "pending" }] };
          return { results: [{ id: "hist-1", link_id: "link-1" }] };
        },
      };
    },
  };
  const snapshot = await snapshotCalendarTablesViaBinding(fakeDb);
  assert.deepEqual(snapshot.links, [{ id: "link-1", sync_status: "pending" }]);
  assert.deepEqual(snapshot.history, [{ id: "hist-1", link_id: "link-1" }]);
  assert.equal(calls.length, 2);
});

test("snapshotCalendarTablesViaBinding tolerates a missing results field without throwing", async () => {
  const fakeDb = { prepare() { return { async all() { return {}; } }; } };
  const snapshot = await snapshotCalendarTablesViaBinding(fakeDb);
  assert.deepEqual(snapshot, { links: [], history: [] });
});

test("verifyBackupRestoresAndMatches restores a real backup into an injected node:sqlite database and confirms it matches a fresh D1-shaped read", () => {
  const backupSqlText = [
    "CREATE TABLE calendar_event_links (id TEXT PRIMARY KEY, sync_status TEXT);",
    "INSERT INTO calendar_event_links (id, sync_status) VALUES('link-1','pending');",
    "CREATE TABLE calendar_event_link_history (id TEXT PRIMARY KEY, link_id TEXT);",
    "INSERT INTO calendar_event_link_history (id, link_id) VALUES('hist-1','link-1');",
  ].join("\n");
  const liveRows = { links: [{ id: "link-1", sync_status: "pending" }], history: [{ id: "hist-1", link_id: "link-1" }] };

  const result = verifyBackupRestoresAndMatches(backupSqlText, liveRows, () => new DatabaseSync(":memory:"));
  assert.equal(result.matches, true, result.mismatchReason);
  assert.deepEqual(result.restored, liveRows);
});

test("verifyBackupRestoresAndMatches detects a genuine mismatch rather than silently passing", () => {
  const backupSqlText = [
    "CREATE TABLE calendar_event_links (id TEXT PRIMARY KEY, sync_status TEXT);",
    "INSERT INTO calendar_event_links (id, sync_status) VALUES('link-1','pending');",
    "CREATE TABLE calendar_event_link_history (id TEXT PRIMARY KEY, link_id TEXT);",
  ].join("\n");
  const liveRows = { links: [{ id: "link-1", sync_status: "SOMETHING_ELSE" }], history: [] };

  const result = verifyBackupRestoresAndMatches(backupSqlText, liveRows, () => new DatabaseSync(":memory:"));
  assert.equal(result.matches, false);
  assert.match(result.mismatchReason, /calendar_event_links/);
});

test("describeFailure for a pre-repair phase says nothing was touched", () => {
  const message = describeFailure(new PhaseError("pre-repair-backup", "export failed"));
  assert.match(message, /Nothing on Staging was touched/);
});

test("describeFailure for a cleanly-rejected repair batch says no recovery action is needed, never suggests read-only inspection", () => {
  const cause = new Error("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT");
  const message = describeFailure(new PhaseError("repair-batch", "The repair batch failed", { cause }));
  assert.match(message, /batch atomicity guarantees/i);
  assert.doesNotMatch(message, /read-only/i);
});

test("describeFailure for an uncertain repair-batch failure (including a generic D1_ERROR) gives read-only inspection guidance, never assumes safety", () => {
  for (const causeMessage of ["D1_ERROR: Internal error", "fetch failed", "ECONNRESET"]) {
    const message = describeFailure(new PhaseError("repair-batch", "The repair batch failed", { cause: new Error(causeMessage) }));
    assert.match(message, /genuinely UNKNOWN/i, causeMessage);
    assert.match(message, /read-only/i, causeMessage);
  }
});

test("describeFailure for post-batch-row-check says data preservation is UNVERIFIED, and never claims it was already confirmed", () => {
  const message = describeFailure(new PhaseError("post-batch-row-check", "Row/column mismatch in calendar_event_links after the repair."));
  assert.doesNotMatch(message, /already confirmed every row/i, "must never claim row preservation was already confirmed when THIS is the check that just failed");
  assert.match(message, /UNVERIFIED|MISMATCHED/i);
  assert.match(message, /read-only/i);
});

test("describeFailure for a post-success verification phase never recommends reverting an already-verified repair", () => {
  for (const phase of ["fk-integrity-check", "schema-health-check", "post-repair-restore-check"]) {
    const message = describeFailure(new PhaseError(phase, "some later check failed"));
    assert.match(message, /already committed successfully/i, phase);
    assert.match(message, /Do NOT restore/i, phase);
  }
});

test("describeFailure for an unrecognized phase defaults to UNCERTAIN, never to the 'already succeeded' message", () => {
  const message = describeFailure(new PhaseError("some-future-phase-nobody-classified", "whatever"));
  assert.doesNotMatch(message, /already committed successfully/i);
  assert.match(message, /UNCERTAIN/i);
  assert.match(message, /read-only/i);
});

test("describeFailure for a non-PhaseError also defaults to UNCERTAIN rather than guessing a phase", () => {
  const message = describeFailure(new Error("something unexpected"));
  assert.match(message, /phase "unknown"/);
  assert.match(message, /UNCERTAIN/i);
});
