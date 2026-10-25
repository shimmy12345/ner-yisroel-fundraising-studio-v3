import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Trip Planner -- Multi-Region Prospect Selection + Manually Added
// Prospects (2026-10-25, see docs/AI-HANDOFF.md). Schema-level
// verification of migration 0054 against a fresh, isolated, in-memory
// SQLite database built from every real committed migration in order
// (same convention as tests/trip-prospect-selection-schema.test.mjs) --
// no real donor data, no network, no Workers runtime.
//
// Builds the database up through migration 0053 FIRST, seeds existing
// trip_prospects rows exactly as they existed under the OLD schema, and
// only THEN applies 0054's own table rebuild -- the actual proof that
// every pre-existing row survives the rebuild byte-for-byte, not just
// that a brand-new database can apply the migration.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const TARGET_MIGRATION = "0054_trip_manual_prospects.sql";
assert.ok(migrations.includes(TARGET_MIGRATION), "the migration under test must exist in drizzle/");
const priorMigrations = migrations.filter((name) => name < TARGET_MIGRATION);

function databaseBeforeTarget() {
  const database = new DatabaseSync(":memory:");
  for (const migration of priorMigrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

function applyTargetMigration(database) {
  database.exec(fs.readFileSync(path.join(migrationDirectory, TARGET_MIGRATION), "utf8"));
}

const NOW = Math.floor(Date.parse("2026-10-25T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)").run(id, userId, displayName, NOW, NOW);
}
function seedTrip(db, { id, userId = "u1" }) {
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES (?, ?, 'Chicago Trip', ?, ?, 'planning', ?, ?)`).run(id, userId, NOW, NOW + 7 * 86400, NOW, NOW);
}

// --- Every pre-existing (always donor-linked) row survives the rebuild
// with every column value preserved exactly. ---
{
  const db = databaseBeforeTarget();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Existing Donor" });
  seedTrip(db, { id: "trip-1" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, trip_notes, next_action, manual_rank, selected_at, created_at, updated_at)
    VALUES ('p1', 'trip-1', 'd1', 'auto_region', 'contacted', 'Existing note', 'Call back', 2, ?, ?, ?)`).run(NOW - 1000, NOW - 1000, NOW - 500);

  applyTargetMigration(db);

  const row = db.prepare("SELECT * FROM trip_prospects WHERE id = 'p1'").get();
  assert.equal(row.donor_id, "d1");
  assert.equal(row.added_method, "auto_region");
  assert.equal(row.status, "contacted");
  assert.equal(row.trip_notes, "Existing note");
  assert.equal(row.next_action, "Call back");
  assert.equal(row.manual_rank, 2);
  assert.equal(row.selected_at, NOW - 1000);
  assert.equal(row.created_at, NOW - 1000);
  assert.equal(row.updated_at, NOW - 500);
  assert.equal(row.manual_name, null, "a pre-existing, donor-linked row has no manual_name");

  const columns = db.prepare("PRAGMA table_info(trip_prospects)").all().map((c) => c.name);
  for (const expected of ["manual_name", "manual_city", "manual_region_id", "manual_phone", "manual_email", "manual_notes"]) {
    assert.ok(columns.includes(expected), `${expected} column must exist after migration`);
  }
  const donorIdColumn = db.prepare("PRAGMA table_info(trip_prospects)").all().find((c) => c.name === "donor_id");
  assert.equal(donorIdColumn.notnull, 0, "donor_id must now be nullable");

  const indexes = db.prepare("PRAGMA index_list(trip_prospects)").all().map((i) => i.name);
  for (const expected of ["trip_prospects_trip_donor_idx", "trip_prospects_donor_idx", "trip_prospects_trip_selected_idx"]) {
    assert.ok(indexes.includes(expected), `${expected} index must still exist after migration`);
  }
}

// --- An unlinked (not-yet-in-FOS) prospect can be inserted with
// donor_id NULL and a real manual_name -- the new, additive case this
// migration exists for. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedTrip(db, { id: "trip-2" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, manual_city, manual_region_id, manual_phone, manual_email, manual_notes, added_method, status, selected_at, created_at, updated_at)
    VALUES ('p2', 'trip-2', NULL, 'Jane Prospect', 'Chicago', 'chicago-suburbs', '555-123-4567', 'jane@example.test', 'Met at a shul event.', 'manual', 'not_contacted', ?, ?, ?)`)
    .run(NOW, NOW, NOW);
  const row = db.prepare("SELECT * FROM trip_prospects WHERE id = 'p2'").get();
  assert.equal(row.donor_id, null);
  assert.equal(row.manual_name, "Jane Prospect");
  assert.equal(row.manual_city, "Chicago");
  assert.equal(row.manual_region_id, "chicago-suburbs");
}

// --- The new CHECK constraint rejects a row with neither a donor_id
// NOR a real manual_name -- no trip_prospects row can ever have no
// identity at all. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedTrip(db, { id: "trip-3" });
  assert.throws(() => {
    db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
      VALUES ('p3', 'trip-3', NULL, NULL, 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  }, /CHECK constraint failed/, "a row with no donor_id and no manual_name must be rejected");
  assert.throws(() => {
    db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
      VALUES ('p3b', 'trip-3', NULL, '   ', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  }, /CHECK constraint failed/, "a row with a blank/whitespace-only manual_name must also be rejected");
}

// --- Multiple unlinked prospects can coexist on the same trip without
// colliding on the UNIQUE(trip_id, donor_id) index -- standard SQL NULL
// semantics mean two NULLs never collide. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedTrip(db, { id: "trip-4" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p4a', 'trip-4', NULL, 'First Unlinked Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p4b', 'trip-4', NULL, 'Second Unlinked Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  const count = db.prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE trip_id = 'trip-4'").get().n;
  assert.equal(count, 2, "two unlinked prospects on the same trip must both be allowed");
}

// --- Linking an unlinked prospect to a real donor is a plain UPDATE of
// donor_id on the SAME row -- id, status, trip notes are all preserved. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedDonor(db, { id: "d-linked", displayName: "Newly Linked Donor" });
  seedTrip(db, { id: "trip-5" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, trip_notes, created_at, updated_at)
    VALUES ('p5', 'trip-5', NULL, 'Soon Linked', 'manual', 'contacted', 'Spoke on the phone.', ?, ?)`).run(NOW, NOW);
  db.prepare("UPDATE trip_prospects SET donor_id = ?, updated_at = ? WHERE id = ? AND donor_id IS NULL").run("d-linked", NOW + 10, "p5");
  const row = db.prepare("SELECT * FROM trip_prospects WHERE id = 'p5'").get();
  assert.equal(row.donor_id, "d-linked");
  assert.equal(row.status, "contacted", "status is preserved across linking");
  assert.equal(row.trip_notes, "Spoke on the phone.", "trip notes are preserved across linking");
  assert.equal(row.manual_name, "Soon Linked", "manual_name is left in place as a historical record, never cleared");
}

// --- trip_prospect_commitments: the new unlinked-prospect fundraising
// ledger. A pledge can be recorded against an unlinked prospect with no
// giving_activities row or donor_id anywhere. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedTrip(db, { id: "trip-6" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p6', 'trip-6', NULL, 'Pledge Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, activity_date, designation, note, created_at)
    VALUES ('c1', 'u1', 'trip-6', 'p6', 'pending_pledge', 500000, ?, 'Capital campaign', 'Verbal commitment on site.', ?)`).run(NOW, NOW);
  const row = db.prepare("SELECT * FROM trip_prospect_commitments WHERE id = 'c1'").get();
  assert.equal(row.committed_cents, 500000);
  assert.equal(row.category, "pending_pledge");
  assert.equal(row.migrated_at, null, "a freshly recorded commitment is never pre-migrated");

  assert.throws(() => {
    db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, created_at)
      VALUES ('c-bad', 'u1', 'trip-6', 'p6', 'open_pledge', 100, ?)`).run(NOW);
  }, /CHECK constraint failed/, "category must be one of pending_gift/pending_pledge -- never a real, already-JL category");

  // --- Migrating marks the commitment, never deletes it. The FK targets
  // must be real rows -- seeded here the same way a real migration
  // (linkProspectToDonor/convertProspectToNewDonor) would have just
  // created them. ---
  seedDonor(db, { id: "d-migrated", displayName: "Migrated Donor" });
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES ('ga-1', 'd-migrated', 'u1', 'Fundraising OS', 'd-migrated', 'ga-1', 500000, 0, 500000, 'pending_pledge', 'live', 'active', '{}', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at)
    VALUES ('attr-1', 'u1', 'trip-6', 'd-migrated', 'ga-1', ?)`).run(NOW);
  db.prepare(`UPDATE trip_prospect_commitments SET migrated_giving_activity_id = ?, migrated_attribution_id = ?, migrated_at = ? WHERE id = ?`)
    .run("ga-1", "attr-1", NOW + 100, "c1");
  const migrated = db.prepare("SELECT * FROM trip_prospect_commitments WHERE id = 'c1'").get();
  assert.equal(migrated.migrated_giving_activity_id, "ga-1");
  assert.equal(migrated.committed_cents, 500000, "the original commitment figures are never altered by migrating");
}

// --- JL-duplicate verification (2026-10-26, see docs/AI-HANDOFF.md's
// "Verification: Manual-Prospect JL Duplicate Risk" entry). A real
// defect this round fixes: migrateProspectCommitments used to
// unconditionally create a brand-new pending_gift/pending_pledge
// giving_activities row for every commitment, even when the donor
// already had a real, already-JL-imported record for the exact same
// pledge/gift. These tests exercise the EXACT SQL the fix's own
// candidate-lookup query (lib/relationships/trips-data.ts's
// migrateProspectCommitments) runs, proving it against a real database
// rather than trusting the application code in isolation -- trips-
// data.ts itself cannot be imported here (it requires the Workers
// runtime's "cloudflare:workers" module), matching this file's own
// established convention. The pure matching DECISION (which candidate,
// if any, is unambiguous) is unit-tested directly in
// tests/trip-model.test.mjs against matchExistingGivingActivityForCommitment. ---
function candidateQuery(db, userId, donorId) {
  return db.prepare(`SELECT id, category, committed_cents, activity_date FROM giving_activities
      WHERE owner_user_id = ? AND donor_id = ? AND record_origin = 'live' AND workspace_status = 'active'
        AND category IN ('completed_gift','open_pledge','partially_paid_pledge')
        AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa WHERE tfa.giving_activity_id = giving_activities.id AND tfa.removed_at IS NULL)`)
    .all(userId, donorId);
}

// Scenario 1: "a manual prospect has a recorded donation or pledge that
// already exists in JL before linking." The candidate query must find
// that real, pre-existing, unattributed pledge -- the fix then
// attributes it directly instead of creating a second, duplicate
// pending_pledge row.
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedDonor(db, { id: "d-already-jl", displayName: "Already In JL Donor" });
  seedTrip(db, { id: "trip-7" });
  // The donor's REAL pledge, already imported from JL before this
  // prospect is ever linked to them.
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES ('ga-real-1', 'd-already-jl', 'u1', 'jl', 'hh-1', 'jl-fp-1', ?, 500000, 0, 500000, 'open_pledge', 'live', 'active', '{}', ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p7', 'trip-7', NULL, 'Verbal Pledge Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, activity_date, note, created_at)
    VALUES ('c-real-1', 'u1', 'trip-7', 'p7', 'pending_pledge', 500000, ?, 'Verbal commitment -- turns out this is their real DIN2025 pledge.', ?)`).run(NOW, NOW);

  const candidatesBefore = candidateQuery(db, "u1", "d-already-jl");
  assert.equal(candidatesBefore.length, 1, "the real, unattributed pledge must be found as a candidate");
  assert.equal(candidatesBefore[0].id, "ga-real-1");

  // The fix's own behavior: attribute the REAL record directly, never
  // insert a second giving_activities row.
  const givingActivityCountBefore = db.prepare("SELECT COUNT(*) AS n FROM giving_activities WHERE donor_id = 'd-already-jl'").get().n;
  db.prepare(`UPDATE trip_prospects SET donor_id = ? WHERE id = ?`).run("d-already-jl", "p7");
  db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, commitment_kind, donor_confirmed_at, created_at)
    VALUES ('attr-real-1', 'u1', 'trip-7', 'd-already-jl', 'ga-real-1', 'Verbal commitment.', 'new_commitment', NULL, ?)`).run(NOW);
  db.prepare(`UPDATE trip_prospect_commitments SET migrated_giving_activity_id = ?, migrated_attribution_id = ?, migrated_at = ? WHERE id = ?`)
    .run("ga-real-1", "attr-real-1", NOW, "c-real-1");

  const givingActivityCountAfter = db.prepare("SELECT COUNT(*) AS n FROM giving_activities WHERE donor_id = 'd-already-jl'").get().n;
  assert.equal(givingActivityCountAfter, givingActivityCountBefore, "no new giving_activities row must be created when a real match exists -- this is the whole fix");
  const migratedRow = db.prepare("SELECT migrated_giving_activity_id FROM trip_prospect_commitments WHERE id = 'c-real-1'").get();
  assert.equal(migratedRow.migrated_giving_activity_id, "ga-real-1", "the commitment must point at the REAL pre-existing record, not a synthetic one");

  // The real pledge is now attributed -- the candidate query must no
  // longer offer it (NOT EXISTS correctly excludes an actively-
  // attributed record).
  assert.deepEqual(candidateQuery(db, "u1", "d-already-jl"), [], "an actively-attributed real record must never be offered as a candidate again");

  // Scenario 4 (no double counting): the partial UNIQUE index is the
  // real, database-level backstop -- a second attempt to attribute the
  // SAME real record (e.g. a concurrent request, or a second commitment
  // that also matched it) must fail outright, never silently succeed.
  assert.throws(() => {
    db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at)
      VALUES ('attr-real-2', 'u1', 'trip-7', 'd-already-jl', 'ga-real-1', ?)`).run(NOW);
  }, /UNIQUE constraint failed/, "the same real giving_activities row can never be actively attributed twice");
}

// Scenario 2: "a manual prospect is linked before the corresponding JL
// import." No real match exists yet, so the candidate query correctly
// returns nothing -- the existing (unchanged) fallback path then
// creates a new pending_pledge row exactly as before this round, which
// JL import's own pendingPledgeMatches/CONFIRM_PENDING_PLEDGE_SQL
// (lib/giving/management.ts, unmodified by this round) will reconcile
// normally once the real pledge is later imported -- proven by that
// module's own existing, unmodified test coverage
// (tests/pending-pledge-matching.test.mjs), not re-proven here.
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedDonor(db, { id: "d-not-yet-imported", displayName: "Not Yet Imported Donor" });
  seedTrip(db, { id: "trip-8" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p8', 'trip-8', NULL, 'Pre-Import Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, activity_date, created_at)
    VALUES ('c-pre-import', 'u1', 'trip-8', 'p8', 'pending_pledge', 250000, ?, ?)`).run(NOW, NOW);
  assert.deepEqual(candidateQuery(db, "u1", "d-not-yet-imported"), [], "no real record exists yet -- the fix must never invent a match");
}

// Scenario 3: "the same prospect is linked or converted more than
// once." A concurrency fix this round also closes: convertProspectToNewDonor
// used to skip checking whether its own donor_id UPDATE actually
// affected a row, so a losing request in a race left an orphaned donor
// account behind AND attributed the prospect's commitments to it
// instead of the real (winning) donor. The fix's own cleanup -- delete
// the donor_contact_audits row, then the donors row, both just created
// by this same losing request and referenced by nothing else yet --
// must succeed without any FK violation.
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  db.prepare(`INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d-orphan', 'u1', 'live', 'Orphaned By Race', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO donor_contact_audits (id, user_id, donor_id, action, changed_fields, after_json, created_at) VALUES ('audit-orphan', 'u1', 'd-orphan', 'created', '[]', '{}', ?)`).run(NOW);

  db.prepare("DELETE FROM donor_contact_audits WHERE id = ?").run("audit-orphan");
  db.prepare("DELETE FROM donors WHERE id = ?").run("d-orphan");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM donors WHERE id = 'd-orphan'").get().n, 0, "the losing request's own orphaned donor must be fully removed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM donor_contact_audits WHERE donor_id = 'd-orphan'").get().n, 0);

  // And the structural guarantee the fix relies on: a prospect's own
  // donor_id UPDATE is a no-op (0 rows changed) once another request has
  // already linked it -- the exact condition that must trigger the
  // cleanup above rather than proceeding to migrate commitments onto
  // the wrong donor.
  seedTrip(db, { id: "trip-9" });
  seedDonor(db, { id: "d-winner", displayName: "Winning Donor" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, added_method, status, created_at, updated_at)
    VALUES ('p9', 'trip-9', 'd-winner', 'Raced Prospect', 'manual', 'not_contacted', ?, ?)`).run(NOW, NOW);
  const result = db.prepare("UPDATE trip_prospects SET donor_id = ? WHERE id = ? AND donor_id IS NULL").run("d-orphan-2", "p9");
  assert.equal(result.changes, 0, "a losing request's own donor_id UPDATE must affect zero rows once the winner already linked this prospect");
}

process.stdout.write("trip-manual-prospects-schema.test.mjs: all assertions passed\n");
