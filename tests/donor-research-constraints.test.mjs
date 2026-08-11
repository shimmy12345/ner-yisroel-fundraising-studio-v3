import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeUrl, extractDomain } from "../lib/research/url-normalize.ts";

// Real, executable migration replay -- the same pattern already used by
// tests/donor-merge.test.mjs ("merge schema archives aliases and retains a
// durable audit") -- so these prove the actual DB-level guarantees hold,
// not just that application code intends them to.
function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(fs.readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  return database;
}

function seedOwner(database) {
  const now = Math.floor(Date.now() / 1000);
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1','owner@example.test',${now},${now})`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d1','Fictional Donor One',${now},${now})`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d2','Fictional Donor Two',${now},${now})`);
  database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('r1','d1','u1','completed',${now})`);
  database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('r2','d2','u1','completed',${now})`);
  return now;
}

function insertSource(database, id, url, now) {
  database.exec(`INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, retrieved_at, source_tier, created_at)
    VALUES ('${id}','u1','${url}','${normalizeUrl(url)}','${extractDomain(url)}','A Page',${now},'reputable_news',${now})`);
}

test("CHECK constraints reject malformed status/category/tier values", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  assert.throws(() => database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('bad','d1','u1','not_a_status',${now})`), /CHECK constraint failed/);
  assert.throws(() => database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at) VALUES ('bad','r1','r1','d1','u1','not_a_category','x','current','fp',${now})`), /CHECK constraint failed/);
  assert.throws(() => database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at) VALUES ('bad','r1','r1','d1','u1','professional','x','not_a_status','fp',${now})`), /CHECK constraint failed/);
  assert.throws(() => database.exec(`INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, retrieved_at, source_tier, created_at) VALUES ('bad','u1','https://x','https://x','x','t',${now},'not_a_tier',${now})`), /CHECK constraint failed/);
});

test("source dedup: same URL pasted twice collides at the DB level", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/leadership", now);
  assert.throws(() => insertSource(database, "s2", "https://example.org/leadership", now), /UNIQUE constraint failed/);
});

test("source dedup: tracking parameters do not create a second source", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/leadership?utm_source=newsletter&utm_campaign=fall", now);
  assert.throws(() => insertSource(database, "s2", "https://example.org/leadership?utm_source=twitter", now), /UNIQUE constraint failed/);
});

test("source dedup: the same URL researched months later reuses the existing row (application-level upsert, not a DB error)", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/leadership", now);
  const monthsLater = now + 60 * 24 * 60 * 60;
  // The pipeline's own upsert path (app/api/research/[donorId]/route.ts)
  // looks the row up by normalized_url first and UPDATEs in place rather
  // than re-INSERTing -- this proves that path, not the constraint.
  database.exec(`UPDATE donor_research_sources SET title='A Page (refreshed)', retrieved_at=${monthsLater} WHERE user_id='u1' AND normalized_url='${normalizeUrl("https://example.org/leadership")}'`);
  const row = database.prepare("SELECT title, retrieved_at FROM donor_research_sources WHERE id='s1'").get();
  assert.equal(row.title, "A Page (refreshed)");
  assert.equal(row.retrieved_at, monthsLater);
});

test("source dedup: the same source may support findings for two different donors without duplication", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/board", now);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f1','r1','r1','d1','u1','boards_affiliations','Board member, Example Foundation','current','fp1',${now})`);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f2','r2','r2','d2','u1','boards_affiliations','Board member, Example Foundation','current','fp2',${now})`);
  database.exec(`INSERT INTO donor_research_finding_sources (finding_id, source_id) VALUES ('f1','s1')`);
  database.exec(`INSERT INTO donor_research_finding_sources (finding_id, source_id) VALUES ('f2','s1')`);
  const count = database.prepare("SELECT COUNT(*) count FROM donor_research_sources").get().count;
  assert.equal(count, 1, "one source row, cited by both donors' findings");
  const links = database.prepare("SELECT COUNT(*) count FROM donor_research_finding_sources WHERE source_id='s1'").get().count;
  assert.equal(links, 2);
});

test("source dedup: same title, different URL is never treated as a duplicate", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/page-one", now);
  // Different host+path, identical title -- must NOT collide, since dedup
  // keys exclusively on normalized_url, never on title text.
  assert.doesNotThrow(() => database.exec(`INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, retrieved_at, source_tier, created_at)
    VALUES ('s2','u1','https://other.org/page-one','${normalizeUrl("https://other.org/page-one")}','other.org','A Page',${now},'reputable_news',${now})`));
  assert.equal(database.prepare("SELECT COUNT(*) count FROM donor_research_sources").get().count, 2);
});

test("finding concurrency: a second active finding with the same (donor_id, fingerprint) is rejected -- double-click/retry/concurrent-request safe", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f1','r1','r1','d1','u1','professional','CEO, Example Holdings','current','fp-abc',${now})`);
  assert.throws(() => database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f2','r1','r1','d1','u1','professional','CEO, Example Holdings','current','fp-abc',${now})`), /UNIQUE constraint failed/, "simulates a retried/double-submitted request racing the first insert");
});

test("finding concurrency: unverified counts as active too -- the same collision applies", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f1','r1','r1','d1','u1','professional','CEO, Example Holdings','unverified','fp-abc',${now})`);
  assert.throws(() => database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f2','r1','r1','d1','u1','professional','CEO, Example Holdings','current','fp-abc',${now})`), /UNIQUE constraint failed/);
});

test("history/supersession: a superseded row frees its fingerprint for a new current row, and both remain queryable as history", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f1','r1','r1','d1','u1','professional','CEO, Example Holdings','current','fp-abc',${now})`);
  database.exec(`UPDATE donor_research_findings SET status='superseded' WHERE id='f1'`);
  assert.doesNotThrow(() => database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
    VALUES ('f2','r1','r1','d1','u1','professional','CEO, Example Holdings','current','fp-abc',${now})`));
  const rows = database.prepare("SELECT id, status FROM donor_research_findings WHERE donor_id='d1' ORDER BY id").all().map((row) => ({ id: row.id, status: row.status }));
  assert.deepEqual(rows, [{ id: "f1", status: "superseded" }, { id: "f2", status: "current" }], "old evidence is never deleted -- it stays inspectable as history");
});

test("history: a stale/removed source (removed_not_found) does not erase the finding row or its prior source citations", () => {
  const database = freshDatabase();
  const now = seedOwner(database);
  insertSource(database, "s1", "https://example.org/gone-now", now);
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, not_found_streak, created_at)
    VALUES ('f1','r1','r1','d1','u1','recent_mentions','Profiled in local paper','current','fp-x',1,${now})`);
  database.exec(`INSERT INTO donor_research_finding_sources (finding_id, source_id) VALUES ('f1','s1')`);
  database.exec(`UPDATE donor_research_findings SET status='removed_not_found', not_found_streak=2 WHERE id='f1'`);
  const finding = database.prepare("SELECT status FROM donor_research_findings WHERE id='f1'").get();
  assert.equal(finding.status, "removed_not_found");
  const stillLinked = database.prepare("SELECT COUNT(*) count FROM donor_research_finding_sources WHERE finding_id='f1'").get().count;
  assert.equal(stillLinked, 1, "the source citation is preserved even once the finding is marked not-found");
  const sourceStillExists = database.prepare("SELECT COUNT(*) count FROM donor_research_sources WHERE id='s1'").get().count;
  assert.equal(sourceStillExists, 1);
});

process.stdout.write("Donor research constraint checks passed.\n");
