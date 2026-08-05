import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SAMPLE_INTERACTIONS_SQL,
  SAMPLE_REMINDERS_SQL,
  UNCERTAIN_INTERACTIONS_SQL,
  UNCERTAIN_REMINDERS_SQL,
} from "../lib/data-health/legacy-test-cleanup.ts";
import { ORPHANED_INTERACTIONS_SQL, ORPHANED_REMINDERS_SQL } from "../lib/data-health/queries.ts";

const owner = "fictional-owner";
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE donors (id TEXT PRIMARY KEY,owner_user_id TEXT,data_source TEXT,archived_at INTEGER);
    CREATE TABLE interactions (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,source TEXT,summary TEXT,occurred_at INTEGER,updated_at INTEGER);
    CREATE TABLE recommendations (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,status TEXT,action TEXT,due_at INTEGER,updated_at INTEGER);
    CREATE TABLE data_health_repair_audits (id TEXT PRIMARY KEY,user_id TEXT,record_type TEXT,record_id TEXT,action TEXT,previous_donor_id TEXT);
  `);
  db.prepare("INSERT INTO donors VALUES (?,?,?,?)").run("sample-donor", null, "sample", null);
  db.prepare("INSERT INTO donors VALUES (?,?,?,?)").run("live-jl-donor", owner, "live", null);
  db.prepare("INSERT INTO interactions VALUES (?,?,?,?,?,?,?)").run("sample-interaction", "sample-donor", owner, "seed", "Same text", 100, 100);
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?,?,?,?)").run("sample-reminder", "sample-donor", owner, "open", "Same text", 100, 100);
  db.prepare("INSERT INTO interactions VALUES (?,?,?,?,?,?,?)").run("live-interaction", "live-jl-donor", owner, "seed", "Same text", 100, 100);
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?,?,?,?)").run("live-reminder", "live-jl-donor", owner, "open", "Same text", 100, 100);
  db.prepare("INSERT INTO interactions VALUES (?,?,?,?,?,?,?)").run("uncertain-interaction", "missing", owner, "seed", "Same text", 100, 100);
  return db;
}

test("only explicit sample metadata identifies cleanup candidates", () => {
  const db = fixture();
  assert.deepEqual(db.prepare(SAMPLE_INTERACTIONS_SQL).all(owner).map((row) => row.id), ["sample-interaction"]);
  assert.deepEqual(db.prepare(SAMPLE_REMINDERS_SQL).all(owner).map((row) => row.id), ["sample-reminder"]);
  assert.deepEqual(db.prepare(UNCERTAIN_INTERACTIONS_SQL).all(owner, owner).map((row) => row.id), ["uncertain-interaction"]);
  assert.deepEqual(db.prepare(UNCERTAIN_REMINDERS_SQL).all(owner, owner), []);
});

test("soft cleanup preserves rows, excludes samples from health, and leaves identical live JL activity untouched", () => {
  const db = fixture();
  db.prepare(`UPDATE interactions SET source='archived:legacy-test:'||source WHERE user_id=? AND id IN
    (SELECT i.id FROM interactions i INNER JOIN donors d ON d.id=i.donor_id WHERE d.data_source='sample')`).run(owner);
  db.prepare(`UPDATE recommendations SET status='dismissed' WHERE user_id=? AND id IN
    (SELECT r.id FROM recommendations r INNER JOIN donors d ON d.id=r.donor_id WHERE d.data_source='sample')`).run(owner);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM interactions").get().count, 3, "no interaction history is hard-deleted");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM recommendations").get().count, 2, "no reminder history is hard-deleted");
  assert.equal(db.prepare("SELECT source FROM interactions WHERE id='live-interaction'").get().source, "seed");
  assert.equal(db.prepare("SELECT status FROM recommendations WHERE id='live-reminder'").get().status, "open");
  assert.equal(db.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 1, "the uncertain missing-donor record remains visible for manual repair");
  assert.equal(db.prepare(ORPHANED_REMINDERS_SQL).get(owner, owner).count, 0, "sample reminders never enter live health counts");
});

test("cleanup route is owner-authenticated, preview-bound, audited, and never hard-deletes activity", () => {
  const route = read("app/api/health/legacy-test-cleanup/route.ts");
  const ui = read("app/settings/LegacyTestOrphanCleanup.tsx");
  const capture = read("app/api/interactions/route.ts");
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /previewToken !== preview\.previewToken/);
  assert.match(route, /ARCHIVE LEGACY TEST ORPHANS|LEGACY_TEST_CLEANUP_CONFIRMATION/);
  assert.match(route, /legacy_test_cleanup_audits/);
  assert.match(route, /env\.DB\.batch/);
  assert.doesNotMatch(route, /DELETE FROM (interactions|recommendations)/i);
  for (const text of ["Record ID", "Source marker", "Why safe", "uncertain records are blocked", "immutable audit entry"]) assert.match(ui, new RegExp(text, "i"));
  assert.match(capture, /data_source = 'live'/, "new captures cannot attach to sample donors in live mode");
});

test("six-month edge cases rely on provenance rather than mutable content", () => {
  const source = read("lib/data-health/legacy-test-cleanup.ts");
  assert.match(source, /d\.data_source='sample'/);
  assert.doesNotMatch(SAMPLE_INTERACTIONS_SQL + SAMPLE_REMINDERS_SQL, /i\.summary|r\.action|i\.occurred_at|r\.due_at|display_name|donor_code/);
  assert.match(source, /Origin is not proven.*cleanup is blocked/);
  assert.match(source, /i\.user_id=\?/);
  assert.match(source, /r\.user_id=\?/);
});
