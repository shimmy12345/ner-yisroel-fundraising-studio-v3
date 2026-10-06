import assert from "node:assert/strict";
import fs from "node:fs";
import { generateBaseline } from "../scripts/generate-production-baseline.mjs";

// Donor <-> Rebbi relationship behavior tested against a real, fresh
// in-memory SQLite database built from this branch's own current schema
// (generateBaseline(), the same mechanism tests/production-baseline.test.mjs
// uses) -- this exercises the REAL donor_rebbeim composite primary key and
// foreign keys, not a mock. API-route-level concerns with no D1/env test
// harness in this repo (ownership checks, route wiring) are verified by
// reading the real, committed source instead, matching this codebase's
// own established convention (see tests/asks.test.mjs's own header
// comment).

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function freshDatabase() {
  const { canonical } = generateBaseline();
  canonical.exec("PRAGMA foreign_keys = ON");
  return canonical;
}

function seedUserAndDonors(db, donorCount = 1) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("user-1", "owner@example.com", now, now);
  const donorIds = [];
  for (let i = 0; i < donorCount; i++) {
    const id = `donor-${i + 1}`;
    db.prepare("INSERT INTO donors (id, owner_user_id, display_name, donor_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, "user-1", `Donor ${i + 1}`, String(10000 + i), now, now);
    donorIds.push(id);
  }
  return donorIds;
}

function seedRebbi(db, id, displayName) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO rebbeim (id, user_id, display_name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, "user-1", displayName, displayName.replace(/^harav /i, "").toLowerCase(), now, now);
}

function connect(db, donorId, rebbiId, source = "manual") {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("INSERT INTO donor_rebbeim (donor_id, rebbi_id, user_id, source, created_at) VALUES (?, ?, ?, ?, ?)").run(donorId, rebbiId, "user-1", source, now);
}

function guardedConnect(db, donorId, rebbiId) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`INSERT INTO donor_rebbeim (donor_id, rebbi_id, user_id, source, created_at)
    SELECT ?, ?, ?, 'manual', ?
    WHERE NOT EXISTS (SELECT 1 FROM donor_rebbeim WHERE donor_id = ? AND rebbi_id = ?)`).run(donorId, rebbiId, "user-1", now, donorId, rebbiId);
}

// --- Donor can have zero, one, or multiple Rebbeim ---

{
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  const count = db.prepare("SELECT COUNT(*) c FROM donor_rebbeim WHERE donor_id = ?").get(donorId).c;
  assert.equal(count, 0, "a donor must be able to have zero Rebbeim");
}
{
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  seedRebbi(db, "rebbi-1", "Harav Berkowitz");
  connect(db, donorId, "rebbi-1");
  const count = db.prepare("SELECT COUNT(*) c FROM donor_rebbeim WHERE donor_id = ?").get(donorId).c;
  assert.equal(count, 1, "a donor must be able to have exactly one Rebbi");
}
{
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  seedRebbi(db, "rebbi-1", "Harav Berkowitz");
  seedRebbi(db, "rebbi-2", "Harav Frand");
  connect(db, donorId, "rebbi-1");
  connect(db, donorId, "rebbi-2");
  const count = db.prepare("SELECT COUNT(*) c FROM donor_rebbeim WHERE donor_id = ?").get(donorId).c;
  assert.equal(count, 2, "a donor must be able to have multiple Rebbeim");
}

// --- Duplicate pair rejected/no-op ---

{
  // The composite PRIMARY KEY itself rejects a raw duplicate insert.
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  seedRebbi(db, "rebbi-1", "Harav Berkowitz");
  connect(db, donorId, "rebbi-1");
  assert.throws(() => connect(db, donorId, "rebbi-1"), /UNIQUE constraint|PRIMARY KEY/i, "the composite primary key must reject a raw duplicate (donor_id, rebbi_id) insert");
}
{
  // The app's own guarded INSERT (used by both the manual-add route and
  // the bulk-import commit route) is a safe, idempotent no-op instead of
  // throwing.
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  seedRebbi(db, "rebbi-1", "Harav Berkowitz");
  const first = guardedConnect(db, donorId, "rebbi-1");
  const second = guardedConnect(db, donorId, "rebbi-1");
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0, "a duplicate guarded add must affect zero rows, never throw or create a second row");
  const count = db.prepare("SELECT COUNT(*) c FROM donor_rebbeim WHERE donor_id = ? AND rebbi_id = ?").get(donorId, "rebbi-1").c;
  assert.equal(count, 1);
}

// --- Removing a relationship keeps the canonical Rebbi record ---

{
  const db = freshDatabase();
  const [donorId] = seedUserAndDonors(db);
  seedRebbi(db, "rebbi-1", "Harav Berkowitz");
  connect(db, donorId, "rebbi-1");
  db.prepare("DELETE FROM donor_rebbeim WHERE donor_id = ? AND rebbi_id = ?").run(donorId, "rebbi-1");
  const relationshipCount = db.prepare("SELECT COUNT(*) c FROM donor_rebbeim WHERE donor_id = ?").get(donorId).c;
  const rebbiStillExists = db.prepare("SELECT COUNT(*) c FROM rebbeim WHERE id = ?").get("rebbi-1").c;
  assert.equal(relationshipCount, 0, "the relationship must be gone");
  assert.equal(rebbiStillExists, 1, "the canonical Rebbi record must remain, untouched, in the directory");
}

// --- Query: selecting a Rebbi returns all associated donors; a donor with
// multiple Rebbeim appears under each; unrelated donors never appear ---

{
  const db = freshDatabase();
  const [donorA, donorB, donorC] = seedUserAndDonors(db, 3);
  seedRebbi(db, "rebbi-berkowitz", "Harav Berkowitz");
  seedRebbi(db, "rebbi-frand", "Harav Frand");
  connect(db, donorA, "rebbi-berkowitz");
  connect(db, donorB, "rebbi-berkowitz");
  connect(db, donorB, "rebbi-frand"); // donorB connected to both
  connect(db, donorC, "rebbi-frand");

  const donorsForBerkowitz = db.prepare(`
    SELECT d.id FROM donor_rebbeim dr JOIN donors d ON d.id = dr.donor_id
    WHERE dr.rebbi_id = ? AND dr.user_id = ?
  `).all("rebbi-berkowitz", "user-1").map((r) => r.id);
  assert.deepEqual(donorsForBerkowitz.sort(), [donorA, donorB].sort(), "exactly the donors connected to Berkowitz, never donorC");

  const donorsForFrand = db.prepare(`
    SELECT d.id FROM donor_rebbeim dr JOIN donors d ON d.id = dr.donor_id
    WHERE dr.rebbi_id = ? AND dr.user_id = ?
  `).all("rebbi-frand", "user-1").map((r) => r.id);
  assert.deepEqual(donorsForFrand.sort(), [donorB, donorC].sort(), "donorB must appear under BOTH Rebbeim it is connected to");
}

// --- Manual UX: route-level concerns, verified by reading the real
// committed source (no D1/env test harness in this repo -- see
// tests/asks.test.mjs's own header comment for this established
// convention) ---

{
  const addRoute = read("app/api/donors/[id]/rebbeim/route.ts");
  // Add existing Rebbi: the route looks up rebbiId against the real
  // `rebbeim` table -- it never accepts or inserts arbitrary free text as
  // a new canonical Rebbi.
  assert.match(addRoute, /SELECT id, display_name FROM rebbeim WHERE id=\? AND user_id=\?/, "the add route must look up an existing canonical Rebbi by id, never create one from free text");
  assert.doesNotMatch(addRoute, /INSERT INTO rebbeim/, "the donor-add route must never insert into the canonical rebbeim table itself");
  // Duplicate add blocked (idempotent no-op): guarded INSERT ... WHERE NOT EXISTS.
  assert.match(addRoute, /WHERE NOT EXISTS \(SELECT 1 FROM donor_rebbeim WHERE donor_id = \? AND rebbi_id = \?\)/, "the add route must guard against duplicate relationships with WHERE NOT EXISTS");
  // Ownership scoping, matching the rest of this app's donor-scoped routes.
  assert.match(addRoute, /owner_user_id=\?.*data_source='live'.*archived_at IS NULL/, "the add route must scope to the authenticated owner's live, unarchived donor");
}
{
  const removeRoute = read("app/api/donors/[id]/rebbeim/[rebbiId]/route.ts");
  // Remove works, and removes ONLY the relationship -- the canonical
  // rebbeim table is never touched by this route.
  assert.match(removeRoute, /DELETE FROM donor_rebbeim WHERE donor_id=\? AND rebbi_id=\? AND user_id=\?/, "the remove route must delete only the donor_rebbeim relationship row");
  assert.doesNotMatch(removeRoute, /DELETE FROM rebbeim\b/, "the remove route must never delete from the canonical rebbeim table");
}
{
  const listRoute = read("app/api/rebbeim/route.ts");
  assert.doesNotMatch(listRoute, /INSERT INTO rebbeim|UPDATE rebbeim|DELETE FROM rebbeim/, "the canonical-directory listing route must be read-only in V1 (no create/edit)");
}

process.stdout.write("Rebbeim relationship checks passed.\n");
