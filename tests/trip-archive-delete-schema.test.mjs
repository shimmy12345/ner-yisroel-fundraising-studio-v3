import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Add Archive and Delete Options to Trip Planner (2026-11-02, see
// docs/AI-HANDOFF.md). Schema-level verification of migration 0056
// against a fresh, isolated, in-memory SQLite database built from
// every real committed migration in order (same convention as
// tests/trip-multi-region-schema.test.mjs) -- no real donor data, no
// network, no Workers runtime.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const TARGET_MIGRATION = "0056_trip_archive_delete.sql";
assert.ok(migrations.includes(TARGET_MIGRATION), "the migration under test must exist in drizzle/");
const priorMigrations = migrations.filter((name) => name < TARGET_MIGRATION);

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of priorMigrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  database.exec(fs.readFileSync(path.join(migrationDirectory, TARGET_MIGRATION), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-11-02T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}

// --- Every existing trip gains a real, NULL archived_at column -- no
// trip is retroactively archived by this migration. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-1', 'u1', 'Chicago Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  const row = db.prepare("SELECT archived_at FROM trips WHERE id = 'trip-1'").get();
  assert.equal(row.archived_at, null, "an existing/newly-created trip must default to NOT archived");

  // Archiving and restoring is a plain column write -- no other row is
  // ever touched.
  db.prepare("UPDATE trips SET archived_at = ? WHERE id = 'trip-1'").run(NOW);
  assert.equal(db.prepare("SELECT archived_at FROM trips WHERE id = 'trip-1'").get().archived_at, NOW);
  db.prepare("UPDATE trips SET archived_at = NULL WHERE id = 'trip-1'").run();
  assert.equal(db.prepare("SELECT archived_at FROM trips WHERE id = 'trip-1'").get().archived_at, null, "restoring clears archived_at back to NULL");

  // The new index exists and actually indexes (owner_user_id, archived_at).
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'trips_owner_archived_idx'").get();
  assert.ok(index, "trips_owner_archived_idx must exist");
  assert.match(index.sql, /owner_user_id/);
  assert.match(index.sql, /archived_at/);
}

// --- Deleting an EMPTY trip (no prospects, no regions, no financial
// activity) succeeds in one FK-respecting batch, children before the
// parent -- the exact order deleteTrip() in trips-data.ts uses. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-empty', 'u1', 'Empty Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);

  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM trip_prospect_commitments WHERE trip_id = ?").run("trip-empty");
  db.prepare("DELETE FROM trip_financial_attributions WHERE trip_id = ?").run("trip-empty");
  db.prepare("DELETE FROM trip_prospects WHERE trip_id = ?").run("trip-empty");
  db.prepare("DELETE FROM trip_destination_regions WHERE trip_id = ?").run("trip-empty");
  db.prepare("DELETE FROM trips WHERE id = ? AND owner_user_id = ?").run("trip-empty", "u1");
  db.exec("COMMIT");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE id = 'trip-empty'").get().n, 0, "the trip row itself must be gone");
}

// --- Deleting the WRONG order (parent before child) must genuinely
// fail with a real foreign-key violation -- proving the order in
// deleteTrip() is load-bearing, not merely a style preference. Node's
// node:sqlite DatabaseSync enforces foreign keys by default (unlike
// raw SQLite), matching D1's own unconditional enforcement. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Jane Donor', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-wrong-order', 'u1', 'Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, selected_at, created_at, updated_at)
    VALUES ('p1', 'trip-wrong-order', 'd1', 'manual', 'not_contacted', ?, ?, ?)`).run(NOW, NOW, NOW);

  assert.throws(
    () => db.prepare("DELETE FROM trips WHERE id = 'trip-wrong-order'").run(),
    /FOREIGN KEY constraint failed/i,
    "deleting the trips row while a real trip_prospects row still references it must be rejected by the database itself",
  );
  // The trip and its prospect both survive the failed attempt -- D1's
  // FK enforcement protects against exactly this mistake.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE id = 'trip-wrong-order'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE id = 'p1'").get().n, 1);
}

// --- A trip_prospect_commitments row referencing a trip_financial_
// attributions row via migrated_attribution_id must be deleted BEFORE
// that attribution row -- the specific ordering requirement this
// feature's own code comment calls out. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Jane Donor', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-migrated', 'u1', 'Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, selected_at, created_at, updated_at)
    VALUES ('p1', 'trip-migrated', 'd1', 'manual', 'not_contacted', ?, ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
      VALUES ('ga1', 'u1', 'd1', 'Fundraising OS', 'ga1', 'ga1', ?, 50000, 0, 50000, 'Pledge', 'pending_pledge', 'live', 'active', '{}', ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at, removed_at)
    VALUES ('attr1', 'u1', 'trip-migrated', 'd1', 'ga1', ?, ?)`).run(NOW, NOW); // already soft-removed (reconciled away)
  db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, created_at, migrated_giving_activity_id, migrated_attribution_id, migrated_at)
    VALUES ('c1', 'u1', 'trip-migrated', 'p1', 'pending_pledge', 50000, ?, 'ga1', 'attr1', ?)`).run(NOW, NOW);

  // Deleting the attribution first (wrong order) must fail -- the
  // commitment still references it.
  assert.throws(
    () => db.prepare("DELETE FROM trip_financial_attributions WHERE id = 'attr1'").run(),
    /FOREIGN KEY constraint failed/i,
  );

  // The correct order (commitments, then attributions, then prospects,
  // then regions, then the trip) succeeds atomically.
  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM trip_prospect_commitments WHERE trip_id = ?").run("trip-migrated");
  db.prepare("DELETE FROM trip_financial_attributions WHERE trip_id = ?").run("trip-migrated");
  db.prepare("DELETE FROM trip_prospects WHERE trip_id = ?").run("trip-migrated");
  db.prepare("DELETE FROM trip_destination_regions WHERE trip_id = ?").run("trip-migrated");
  db.prepare("DELETE FROM trips WHERE id = ? AND owner_user_id = ?").run("trip-migrated", "u1");
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE id = 'trip-migrated'").get().n, 0);

  // The real giving_activities row (and the donor) are COMPLETELY
  // untouched -- only the trip's own thin link/workflow rows were
  // removed.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM giving_activities WHERE id = 'ga1'").get().n, 1, "the real pledge record must survive the trip's deletion");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM donors WHERE id = 'd1'").get().n, 1, "the donor record must survive the trip's deletion");
}

// --- Deleting a trip never touches interactions, recommendations, or
// calendar_event_links -- AI Meeting Notes and real meeting history
// live entirely on the donor's own interaction row, independent of
// the trip. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Jane Donor', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO interactions (id, user_id, donor_id, type, occurred_at, summary, source, created_at, updated_at)
    VALUES ('int1', 'u1', 'd1', 'meeting', ?, 'AI meeting notes: discussed capital campaign', 'capture-completed:1:completed:capture-scheduled:trip:trip-notes:meeting', ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-notes', 'u1', 'Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, linked_interaction_id, selected_at, created_at, updated_at)
    VALUES ('p1', 'trip-notes', 'd1', 'manual', 'meeting_completed', 'int1', ?, ?, ?)`).run(NOW, NOW, NOW);

  db.exec("BEGIN IMMEDIATE");
  db.prepare("DELETE FROM trip_prospect_commitments WHERE trip_id = ?").run("trip-notes");
  db.prepare("DELETE FROM trip_financial_attributions WHERE trip_id = ?").run("trip-notes");
  db.prepare("DELETE FROM trip_prospects WHERE trip_id = ?").run("trip-notes");
  db.prepare("DELETE FROM trip_destination_regions WHERE trip_id = ?").run("trip-notes");
  db.prepare("DELETE FROM trips WHERE id = ? AND owner_user_id = ?").run("trip-notes", "u1");
  db.exec("COMMIT");

  const interaction = db.prepare("SELECT summary FROM interactions WHERE id = 'int1'").get();
  assert.ok(interaction, "the real interaction row (the donor's permanent meeting record) must survive the trip's deletion");
  assert.equal(interaction.summary, "AI meeting notes: discussed capital campaign", "the AI meeting notes text itself must be completely unaffected");
}

// --- Final Safety Fix (2026-11-03, see docs/AI-HANDOFF.md): the
// recorded-activity GUARD ITSELF (the exact `NOT EXISTS (...)` clause
// lib/relationships/trips-data.ts's deleteTrip() embeds in every delete
// statement), exercised directly at the SQL level against a real
// trip_prospects row with linked_interaction_id set. Proves the guard
// makes the whole batch a true no-op -- never a partial delete -- when
// a trip has a recorded meeting, with zero financial activity at all. ---
{
  const db = freshDatabase();
  seedUser(db);
  db.prepare(`INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Jane Donor', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO interactions (id, user_id, donor_id, type, occurred_at, summary, source, created_at, updated_at)
    VALUES ('int2', 'u1', 'd1', 'meeting', ?, 'Completed meeting notes', 'capture-completed:1:completed:capture-scheduled:trip:trip-guard:meeting', ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-guard', 'u1', 'Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, linked_interaction_id, selected_at, created_at, updated_at)
    VALUES ('p-guard', 'trip-guard', 'd1', 'manual', 'meeting_completed', 'int2', ?, ?, ?)`).run(NOW, NOW, NOW);

  const guard = `NOT EXISTS (
      SELECT 1 FROM trip_prospects WHERE trip_id = ? AND linked_interaction_id IS NOT NULL
      UNION ALL SELECT 1 FROM trip_financial_attributions WHERE trip_id = ?
      UNION ALL SELECT 1 FROM trip_prospect_commitments WHERE trip_id = ?
    )`;
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`DELETE FROM trip_prospect_commitments WHERE trip_id = ? AND ${guard}`).run("trip-guard", "trip-guard", "trip-guard", "trip-guard");
  db.prepare(`DELETE FROM trip_financial_attributions WHERE trip_id = ? AND ${guard}`).run("trip-guard", "trip-guard", "trip-guard", "trip-guard");
  db.prepare(`DELETE FROM trip_prospects WHERE trip_id = ? AND ${guard}`).run("trip-guard", "trip-guard", "trip-guard", "trip-guard");
  db.prepare(`DELETE FROM trip_destination_regions WHERE trip_id = ? AND ${guard}`).run("trip-guard", "trip-guard", "trip-guard", "trip-guard");
  const tripsResult = db.prepare(`DELETE FROM trips WHERE id = ? AND owner_user_id = ? AND ${guard}`).run("trip-guard", "u1", "trip-guard", "trip-guard", "trip-guard");
  db.exec("COMMIT");

  assert.equal(tripsResult.changes, 0, "the guarded delete of the trips row must affect zero rows when a recorded meeting exists");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE id = 'trip-guard'").get().n, 1, "the trip itself must still exist -- the guard made the WHOLE batch a no-op, not a partial delete");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE trip_id = 'trip-guard'").get().n, 1, "the trip_prospects row must still exist too");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE id = 'int2'").get().n, 1, "the real interaction is, as always, never even referenced by these statements");
}

process.stdout.write("trip-archive-delete-schema.test.mjs: all assertions passed\n");
