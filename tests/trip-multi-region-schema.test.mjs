import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Multi-Region Trip Destination (2026-10-26, see docs/AI-HANDOFF.md).
// Schema-level verification of migration 0055 against a fresh,
// isolated, in-memory SQLite database built from every real committed
// migration in order (same convention as
// tests/trip-manual-prospects-schema.test.mjs) -- no real donor data,
// no network, no Workers runtime.
//
// Builds the database up through migration 0054 FIRST, seeds existing
// trips exactly as they existed under the OLD single-region schema, and
// only THEN applies 0055's own backfill -- the actual proof that every
// pre-existing trip's single region survives as a real row, not just
// that a brand-new database can apply the migration.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const TARGET_MIGRATION = "0055_trip_multi_region.sql";
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

const NOW = Math.floor(Date.parse("2026-10-26T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}

// --- Backward compatibility: an existing, single-region trip's own
// region becomes a real row here, preserving the trip itself unchanged. ---
{
  const db = databaseBeforeTarget();
  seedUser(db);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, destination_region_id, destination_region_label, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-single', 'u1', 'Chicago Trip', 'chicago-suburbs', 'Chicago & suburbs', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  // A trip that was created with no region at all must gain no rows.
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, destination_region_id, destination_region_label, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-none', 'u1', 'Manual-Only Trip', NULL, NULL, ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);

  applyTargetMigration(db);

  const singleRows = db.prepare("SELECT region_id FROM trip_destination_regions WHERE trip_id = 'trip-single'").all();
  assert.deepEqual(singleRows.map((r) => r.region_id), ["chicago-suburbs"], "the trip's existing single region becomes exactly one real row");
  const noneRows = db.prepare("SELECT COUNT(*) AS n FROM trip_destination_regions WHERE trip_id = 'trip-none'").get().n;
  assert.equal(noneRows, 0, "a trip with no region at all must gain no rows");

  // The trip row itself, and its old columns, are completely untouched.
  const trip = db.prepare("SELECT * FROM trips WHERE id = 'trip-single'").get();
  assert.equal(trip.name, "Chicago Trip");
  assert.equal(trip.destination_region_id, "chicago-suburbs", "the old column is left in place, not cleared");
  assert.equal(trip.status, "planning");
}

// --- Going forward, a trip can be tagged with multiple regions. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES ('trip-multi', 'u1', 'Multi-Region Trip', ?, ?, 'planning', ?, ?)`).run(NOW, NOW + 7 * 86400, NOW, NOW);
  for (const regionId of ["chicago-suburbs", "nyc-boroughs", "lakewood-ocean-county-nj"]) {
    db.prepare("INSERT INTO trip_destination_regions (id, trip_id, region_id, created_at) VALUES (?, ?, ?, ?)")
      .run(`r-${regionId}`, "trip-multi", regionId, NOW);
  }
  const regions = db.prepare("SELECT region_id FROM trip_destination_regions WHERE trip_id = 'trip-multi' ORDER BY region_id").all().map((r) => r.region_id);
  assert.deepEqual(regions, ["chicago-suburbs", "lakewood-ocean-county-nj", "nyc-boroughs"]);

  // The SAME region can never be attached to a trip twice.
  assert.throws(() => {
    db.prepare("INSERT INTO trip_destination_regions (id, trip_id, region_id, created_at) VALUES (?, ?, ?, ?)")
      .run("r-dup", "trip-multi", "chicago-suburbs", NOW);
  }, /UNIQUE constraint failed/, "a trip can never be tagged with the same region twice");

  // Editing a trip's regions (updateTrip's own "replace the full set"
  // behavior) is a plain delete-then-reinsert -- proven at the SQL level.
  db.prepare("DELETE FROM trip_destination_regions WHERE trip_id = ?").run("trip-multi");
  db.prepare("INSERT INTO trip_destination_regions (id, trip_id, region_id, created_at) VALUES (?, ?, ?, ?)").run("r-new", "trip-multi", "israel", NOW);
  const afterEdit = db.prepare("SELECT region_id FROM trip_destination_regions WHERE trip_id = 'trip-multi'").all().map((r) => r.region_id);
  assert.deepEqual(afterEdit, ["israel"], "replacing a trip's region set removes every prior region and keeps only the new set");
}

process.stdout.write("trip-multi-region-schema.test.mjs: all assertions passed\n");
