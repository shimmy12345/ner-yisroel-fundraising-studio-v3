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
  retainBackupSecurely,
  applyRepairBatchGuardedByRetention,
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

// =============================================================================
// retainBackupSecurely() -- the fix for a real bug this round's review
// caught: an earlier version of this sequence, written as a CI shell step
// with `set -uo pipefail` (missing `-e`), could print a success message
// and then unconditionally shred every local backup copy even when
// compression, encryption, or upload had actually failed -- silently
// destroying the only recoverable backup. Every synthetic case below
// injects a failure at exactly one stage and asserts: `ok: false`, a
// reason naming that stage, and -- critically -- that the ORIGINAL
// backup file was NEVER shredded on any failure path.
// =============================================================================

function fakeRetentionDeps(overrides = {}) {
  const shredCalls = [];
  return {
    shredCalls,
    deps: {
      compress: () => {},
      encrypt: () => {},
      upload: () => {},
      verifyRemoteObject: () => true,
      statSize: () => 1234,
      shred: (path) => shredCalls.push(path),
      ...overrides,
    },
  };
}

test("retainBackupSecurely: compression failure never shreds the original backup", () => {
  const { deps, shredCalls } = fakeRetentionDeps({ compress: () => { throw new Error("disk full"); } });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Compression failed.*disk full/s);
  assert.deepEqual(shredCalls, [], "nothing should be shredded if compression never even produced a .gz file");
});

test("retainBackupSecurely: encryption failure never shreds the original backup (only the reproducible .gz intermediate)", () => {
  const { deps, shredCalls } = fakeRetentionDeps({ encrypt: () => { throw new Error("gpg: no default secret key"); } });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Encryption failed/);
  assert.deepEqual(shredCalls, ["/tmp/before.sql.gz"], "only the reproducible .gz intermediate may be cleaned up -- never the original");
  assert.ok(!shredCalls.includes("/tmp/before.sql"), "the original backup must never be shredded on an encryption failure");
});

test("retainBackupSecurely: upload failure never shreds the original backup or the ciphertext", () => {
  const { deps, shredCalls } = fakeRetentionDeps({ upload: () => { throw new Error("AccessDenied"); } });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Upload failed.*AccessDenied/s);
  assert.ok(!shredCalls.includes("/tmp/before.sql"), "the original backup must never be shredded on an upload failure -- it is the only recoverable copy at this point");
  assert.ok(!shredCalls.includes("/tmp/before.sql.gz.gpg"), "the ciphertext must not be destroyed on a failed upload either");
});

test("retainBackupSecurely: a remote verification that reports a mismatch (not a thrown error) is treated as failure, never success", () => {
  const { deps, shredCalls } = fakeRetentionDeps({ verifyRemoteObject: () => false });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match the uploaded content/);
  assert.ok(!shredCalls.includes("/tmp/before.sql"), "the original backup must never be shredded when remote verification fails");
});

test("retainBackupSecurely: a thrown error during remote verification is also treated as failure, never success", () => {
  const { deps, shredCalls } = fakeRetentionDeps({ verifyRemoteObject: () => { throw new Error("network timeout"); } });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Remote verification failed.*network timeout/s);
  assert.ok(!shredCalls.includes("/tmp/before.sql"));
});

test("retainBackupSecurely: the happy path reports success and ONLY THEN removes the local plaintext and ciphertext", () => {
  const { deps, shredCalls } = fakeRetentionDeps();
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, true);
  assert.equal(result.remoteKey, "repair-0049/before.sql.gz.gpg");
  assert.ok(shredCalls.includes("/tmp/before.sql.gz"), "the intermediate .gz must be cleaned up");
  assert.ok(shredCalls.includes("/tmp/before.sql.gz.gpg"), "the ciphertext must be cleaned up once retained remotely");
  assert.ok(shredCalls.includes("/tmp/before.sql"), "the original plaintext may only be removed once a verified remote copy exists");
});

test("retainBackupSecurely: a shred failure is never escalated into a retention failure (best-effort cleanup only)", () => {
  const { deps } = fakeRetentionDeps({ shred: () => { throw new Error("permission denied"); } });
  const result = retainBackupSecurely("/tmp/before.sql", "repair-0049", deps);
  assert.equal(result.ok, true, "a cleanup failure must never turn an otherwise-successful, verified retention into a reported failure");
});

// =============================================================================
// applyRepairBatchGuardedByRetention() -- proves the repair batch is
// structurally UNREACHABLE when pre-repair retention fails, per this
// round's own instruction ("prove the repair is never invoked when
// pre-repair retention fails").
// =============================================================================

function fakeGuardedDb() {
  const batchCalls = [];
  return {
    batchCalls,
    db: {
      prepare: (sql) => ({ sql }),
      async batch(statements) {
        batchCalls.push(statements);
        return { success: true };
      },
    },
  };
}

test("applyRepairBatchGuardedByRetention never calls db.batch() when retention reports failure", async () => {
  const { db, batchCalls } = fakeGuardedDb();
  const retainPreRepairBackup = () => ({ ok: false, reason: "upload failed" });
  await assert.rejects(
    () => applyRepairBatchGuardedByRetention(db, ["CREATE TABLE x (id text)"], retainPreRepairBackup),
    (error) => {
      assert.ok(error instanceof PhaseError);
      assert.equal(error.phase, "pre-repair-retention");
      assert.match(error.message, /upload failed/);
      return true;
    },
  );
  assert.deepEqual(batchCalls, [], "db.batch() must never be called when the pre-repair backup could not be retained securely");
});

test("applyRepairBatchGuardedByRetention calls db.batch() with the given statements once retention succeeds", async () => {
  const { db, batchCalls } = fakeGuardedDb();
  const retainPreRepairBackup = () => ({ ok: true, remoteKey: "repair-0049/before.sql.gz.gpg" });
  const statements = ["CREATE TABLE x (id text)", "DROP TABLE y"];
  const result = await applyRepairBatchGuardedByRetention(db, statements, retainPreRepairBackup);
  assert.equal(result.ok, true);
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].map((s) => s.sql), statements);
});

test("applyRepairBatchGuardedByRetention supports an async retainPreRepairBackup", async () => {
  const { db, batchCalls } = fakeGuardedDb();
  const retainPreRepairBackup = async () => ({ ok: true, remoteKey: "repair-0049/before.sql.gz.gpg" });
  await applyRepairBatchGuardedByRetention(db, ["SELECT 1"], retainPreRepairBackup);
  assert.equal(batchCalls.length, 1);
});

// =============================================================================
// describeFailure for the two new retention-related phases.
// =============================================================================

test("describeFailure for pre-repair-retention says nothing was touched -- same as any other pre-repair phase", () => {
  const message = describeFailure(new PhaseError("pre-repair-retention", "could not retain the pre-repair backup"));
  assert.match(message, /Nothing on Staging was touched/);
});

test("describeFailure for post-repair-retention fails loudly but never recommends reverting the already-verified repair", () => {
  const message = describeFailure(new PhaseError("post-repair-retention", "could not retain the post-repair backup"));
  assert.match(message, /already committed successfully/i);
  assert.match(message, /Do NOT restore/i);
});
