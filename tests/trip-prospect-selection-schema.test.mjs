import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Trip Planning -- Deliberate Prospect Selection (2026-10-18, see
// docs/AI-HANDOFF.md). Schema-level verification of migration 0047
// against a fresh, isolated, in-memory SQLite database built from every
// real committed migration in order (same convention as
// tests/trip-financial-attribution-schema.test.mjs) -- no real donor
// data, no network, no Workers runtime.
//
// Unlike that file, this test builds the database up through migration
// 0046 FIRST, inserts fixture `trip_prospects` rows representing every
// real shape the owner's existing data can take, and only THEN applies
// 0047's own SQL -- a fresh database built from every migration at once
// would run 0047's backfill against an empty table, proving nothing
// about the backfill logic itself. This is the actual proof that the
// backfill correctly distinguishes a legacy row the owner has visibly
// acted on (promoted to selected) from one with zero signal of any kind
// (left as an unselected candidate), exactly the "do not assume every
// auto_region + not_contacted row is disposable or unwanted" / "do not
// silently classify ambiguous rows" requirement.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const TARGET_MIGRATION = "0047_trip_prospect_selection.sql";
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

const NOW = Math.floor(Date.parse("2026-10-18T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)").run(id, userId, displayName, NOW, NOW);
}
function seedTrip(db, { id, userId = "u1" }) {
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at)
    VALUES (?, ?, 'Baltimore Trip', ?, ?, 'planning', ?, ?)`).run(id, userId, NOW, NOW + 7 * 86400, NOW, NOW);
}
function seedProspect(db, {
  id, tripId, donorId, addedMethod, status = "not_contacted", tripNotes = null, nextAction = null,
  manualRank = null, meetingAt = null, linkedInteractionId = null, createdAt = NOW, updatedAt = NOW,
}) {
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, trip_notes, next_action, manual_rank, meeting_at, linked_interaction_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tripId, donorId, addedMethod, status, tripNotes, nextAction, manualRank, meetingAt, linkedInteractionId, createdAt, updatedAt);
}
function attribute(db, { id, userId = "u1", tripId, donorId, givingActivityId, removedAt = null }) {
  db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, userId, tripId, donorId, givingActivityId, NOW, removedAt);
}
function seedInteraction(db, { id, donorId, userId = "u1" }) {
  db.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at)
    VALUES (?, ?, ?, 'meeting', ?, 'Trip meeting', ?, ?)`).run(id, donorId, userId, NOW, NOW, NOW);
}
function seedGivingActivity(db, { id, donorId, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, 100000, 0, 100000, 'open_pledge', 'live', 'active', '{}', ?, ?)`).run(id, donorId, userId, id, NOW, NOW);
}

{
  const db = databaseBeforeTarget();
  seedUser(db);
  seedDonor(db, { id: "d-manual", displayName: "Manually Added Donor" });
  seedDonor(db, { id: "d-no-signal", displayName: "Untouched Candidate" });
  seedDonor(db, { id: "d-status-changed", displayName: "Status Changed Donor" });
  seedDonor(db, { id: "d-notes", displayName: "Has Notes Donor" });
  seedDonor(db, { id: "d-next-action", displayName: "Has Next Action Donor" });
  seedDonor(db, { id: "d-manual-rank", displayName: "Has Manual Rank Donor" });
  seedDonor(db, { id: "d-meeting", displayName: "Has Meeting Donor" });
  seedDonor(db, { id: "d-interaction", displayName: "Has Linked Interaction Donor" });
  seedDonor(db, { id: "d-active-attribution", displayName: "Has Active Attribution Donor" });
  seedDonor(db, { id: "d-removed-attribution-only", displayName: "Has Only Removed Attribution Donor" });
  seedTrip(db, { id: "trip-1" });

  // --- A deliberate manual add was always selected as of its own
  // creation, regardless of any other field. ---
  seedProspect(db, { id: "p-manual", tripId: "trip-1", donorId: "d-manual", addedMethod: "manual", createdAt: NOW - 1000, updatedAt: NOW - 1000 });

  // --- A legacy auto_region row with ZERO visible signal must stay an
  // unselected candidate -- the owner never acted on it, so this
  // migration must never promote it on its own. ---
  seedProspect(db, { id: "p-no-signal", tripId: "trip-1", donorId: "d-no-signal", addedMethod: "auto_region" });

  // --- Each of these auto_region rows carries exactly one real signal
  // of deliberate attention, and must be promoted using its own
  // updated_at (never created_at). ---
  seedProspect(db, { id: "p-status", tripId: "trip-1", donorId: "d-status-changed", addedMethod: "auto_region", status: "contacted", createdAt: NOW - 5000, updatedAt: NOW - 500 });
  seedProspect(db, { id: "p-notes", tripId: "trip-1", donorId: "d-notes", addedMethod: "auto_region", tripNotes: "Met at shul last week.", createdAt: NOW - 5000, updatedAt: NOW - 400 });
  seedProspect(db, { id: "p-next-action", tripId: "trip-1", donorId: "d-next-action", addedMethod: "auto_region", nextAction: "Call Tuesday", createdAt: NOW - 5000, updatedAt: NOW - 300 });
  seedProspect(db, { id: "p-manual-rank", tripId: "trip-1", donorId: "d-manual-rank", addedMethod: "auto_region", manualRank: 1, createdAt: NOW - 5000, updatedAt: NOW - 200 });
  seedProspect(db, { id: "p-meeting", tripId: "trip-1", donorId: "d-meeting", addedMethod: "auto_region", meetingAt: NOW + 86400, createdAt: NOW - 5000, updatedAt: NOW - 150 });
  seedInteraction(db, { id: "interaction-abc", donorId: "d-interaction" });
  seedProspect(db, { id: "p-interaction", tripId: "trip-1", donorId: "d-interaction", addedMethod: "auto_region", linkedInteractionId: "interaction-abc", createdAt: NOW - 5000, updatedAt: NOW - 100 });

  // --- An ACTIVE financial attribution is also a real signal... ---
  seedGivingActivity(db, { id: "ga-active", donorId: "d-active-attribution" });
  seedProspect(db, { id: "p-active-attribution", tripId: "trip-1", donorId: "d-active-attribution", addedMethod: "auto_region", createdAt: NOW - 5000, updatedAt: NOW - 50 });
  attribute(db, { id: "attr-active", tripId: "trip-1", donorId: "d-active-attribution", givingActivityId: "ga-active" });

  // --- ...but a REMOVED (soft-deleted) attribution is not -- it is no
  // longer real evidence of a current, active link to this trip. ---
  seedGivingActivity(db, { id: "ga-removed", donorId: "d-removed-attribution-only" });
  seedProspect(db, { id: "p-removed-attribution-only", tripId: "trip-1", donorId: "d-removed-attribution-only", addedMethod: "auto_region" });
  attribute(db, { id: "attr-removed", tripId: "trip-1", donorId: "d-removed-attribution-only", givingActivityId: "ga-removed", removedAt: NOW - 10 });

  applyTargetMigration(db);

  const selectedAt = (id) => db.prepare("SELECT selected_at FROM trip_prospects WHERE id = ?").get(id).selected_at;

  assert.equal(selectedAt("p-manual"), NOW - 1000, "a manual add is selected as of its own created_at");
  assert.equal(selectedAt("p-no-signal"), null, "a legacy auto_region row with zero signal must remain an unselected candidate, never silently promoted");
  assert.equal(selectedAt("p-status"), NOW - 500, "a status change away from not_contacted is a real signal, promoted using updated_at");
  assert.equal(selectedAt("p-notes"), NOW - 400, "trip notes are a real signal");
  assert.equal(selectedAt("p-next-action"), NOW - 300, "a next action is a real signal");
  assert.equal(selectedAt("p-manual-rank"), NOW - 200, "a manual priority rank is a real signal");
  assert.equal(selectedAt("p-meeting"), NOW - 150, "a scheduled/completed meeting time is a real signal");
  assert.equal(selectedAt("p-interaction"), NOW - 100, "a linked real interaction is a real signal");
  assert.equal(selectedAt("p-active-attribution"), NOW - 50, "an ACTIVE financial attribution is a real signal");
  assert.equal(selectedAt("p-removed-attribution-only"), null, "a REMOVED financial attribution alone is not a real signal -- must not promote");

  // --- Nothing else about any row was touched -- the backfill only ever
  // writes selected_at, never recreates or reorders a row. ---
  const rowCount = db.prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE trip_id = 'trip-1'").get().n;
  assert.equal(rowCount, 10, "every pre-existing row survives the migration -- none deleted or recreated");
  assert.equal(db.prepare("SELECT trip_notes FROM trip_prospects WHERE id = 'p-notes'").get().trip_notes, "Met at shul last week.", "an existing note is preserved verbatim");
  assert.equal(db.prepare("SELECT status FROM trip_prospects WHERE id = 'p-status'").get().status, "contacted", "an existing status is preserved, not reset");

  // --- The new column and its supporting index both exist structurally. ---
  const columns = db.prepare("PRAGMA table_info(trip_prospects)").all().map((c) => c.name);
  assert.ok(columns.includes("selected_at"), "selected_at column must exist after migration");
  const indexes = db.prepare("PRAGMA index_list(trip_prospects)").all().map((i) => i.name);
  assert.ok(indexes.includes("trip_prospects_trip_selected_idx"), "the supporting index must exist after migration");
}

// --- Going forward, a direct insert (the shape selectTripProspect()
// uses) can set selected_at immediately -- the column accepts a real
// value, not just NULL from the backfill. ---
{
  const db = databaseBeforeTarget();
  applyTargetMigration(db);
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Fresh Donor" });
  seedTrip(db, { id: "trip-2" });
  db.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, selected_at, created_at, updated_at)
    VALUES ('p1', 'trip-2', 'd1', 'manual', 'not_contacted', ?, ?, ?)`).run(NOW, NOW, NOW);
  const row = db.prepare("SELECT selected_at FROM trip_prospects WHERE id = 'p1'").get();
  assert.equal(row.selected_at, NOW, "a freshly selected prospect can be inserted with selected_at already set");
}

process.stdout.write("trip-prospect-selection-schema.test.mjs: all assertions passed\n");
