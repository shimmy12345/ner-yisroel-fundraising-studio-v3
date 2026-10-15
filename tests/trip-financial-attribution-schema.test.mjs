import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
// Schema-level verification of migration 0046 against a fresh, isolated,
// in-memory SQLite database built from every real committed migration in
// order (same convention as tests/pledge-balance-correction-e2e.test.mjs)
// -- no real donor data, no network, no Workers runtime. This proves the
// actual database-level double-counting guard (the partial unique index),
// not just application code that could theoretically be bypassed.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-10-16T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)").run(id, userId, displayName, NOW, NOW);
}
function seedTrip(db, { id, userId = "u1", goalCents = null }) {
  db.prepare(`INSERT INTO trips (id, owner_user_id, name, start_date, end_date, fundraising_goal_cents, status, created_at, updated_at)
    VALUES (?, ?, 'Baltimore Trip', ?, ?, ?, 'planning', ?, ?)`).run(id, userId, NOW, NOW + 7 * 86400, goalCents, NOW, NOW);
}
function seedGivingActivity(db, { id, donorId, committedCents, paidCents, balanceCents, category = "open_pledge", userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, ?, 'live', 'active', '{}', ?, ?)`).run(id, donorId, userId, id, committedCents, paidCents, balanceCents, category, NOW, NOW);
}
function attribute(db, { id, userId = "u1", tripId, donorId, givingActivityId }) {
  db.prepare("INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, tripId, donorId, givingActivityId, NOW);
}

{
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Jane Donor" });
  seedTrip(db, { id: "trip-1", goalCents: 10_000_00 });
  seedTrip(db, { id: "trip-2", goalCents: 5_000_00 });
  seedGivingActivity(db, { id: "ga-1", donorId: "d1", committedCents: 25_000_00, paidCents: 5_000_00, balanceCents: 20_000_00 });

  attribute(db, { id: "attr-1", tripId: "trip-1", donorId: "d1", givingActivityId: "ga-1" });

  // --- No double-counting: the same giving_activity cannot be actively
  // attributed to a SECOND trip while the first attribution is active. ---
  assert.throws(() => attribute(db, { id: "attr-2", tripId: "trip-2", donorId: "d1", givingActivityId: "ga-1" }), /UNIQUE constraint failed/, "a second ACTIVE attribution of the same record to a different trip must be rejected at the database level");

  // --- Duplicate-attribution prevention within the SAME trip too. ---
  assert.throws(() => attribute(db, { id: "attr-3", tripId: "trip-1", donorId: "d1", givingActivityId: "ga-1" }), /UNIQUE constraint failed/, "a second ACTIVE attribution of the same record to the SAME trip must also be rejected");

  // --- Removing (soft-delete) the first attribution frees the record to
  // be attributed elsewhere -- reversible, never a hard delete of
  // history. ---
  db.prepare("UPDATE trip_financial_attributions SET removed_at = ?, removed_reason = ? WHERE id = ?").run(NOW + 60, "Attributed to the wrong trip", "attr-1");
  attribute(db, { id: "attr-4", tripId: "trip-2", donorId: "d1", givingActivityId: "ga-1" });
  const active = db.prepare("SELECT trip_id FROM trip_financial_attributions WHERE giving_activity_id = ? AND removed_at IS NULL").get("ga-1");
  assert.equal(active.trip_id, "trip-2", "after removal, the record is now actively attributed to the new trip only");
  const history = db.prepare("SELECT id, trip_id, removed_at FROM trip_financial_attributions WHERE giving_activity_id = ? ORDER BY created_at").all("ga-1");
  assert.equal(history.length, 2, "the original (now-removed) attribution row is never deleted -- full history is preserved");
  assert.ok(history[0].removed_at !== null, "the original attribution is marked removed, not erased");

  // --- The underlying financial record itself was never touched by any
  // of the above. ---
  const ga = db.prepare("SELECT committed_cents, paid_cents, balance_cents FROM giving_activities WHERE id = ?").get("ga-1");
  assert.equal(ga.committed_cents, 25_000_00);
  assert.equal(ga.paid_cents, 5_000_00);
  assert.equal(ga.balance_cents, 20_000_00);
}

// --- Attributing records from two different donors to the same trip,
// and confirming a donor can have more than one of their own records
// attributed, is allowed (the unique index is scoped to giving_activity_id
// only, never donor_id or trip_id alone). ---
{
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Donor One" });
  seedDonor(db, { id: "d2", displayName: "Donor Two" });
  seedTrip(db, { id: "trip-1", goalCents: null });
  seedGivingActivity(db, { id: "ga-1", donorId: "d1", committedCents: 10_000_00, paidCents: 0, balanceCents: 10_000_00 });
  seedGivingActivity(db, { id: "ga-2", donorId: "d1", committedCents: 2_000_00, paidCents: 2_000_00, balanceCents: 0, category: "completed_gift" });
  seedGivingActivity(db, { id: "ga-3", donorId: "d2", committedCents: 5_000_00, paidCents: 0, balanceCents: 5_000_00 });

  attribute(db, { id: "attr-1", tripId: "trip-1", donorId: "d1", givingActivityId: "ga-1" });
  attribute(db, { id: "attr-2", tripId: "trip-1", donorId: "d1", givingActivityId: "ga-2" });
  attribute(db, { id: "attr-3", tripId: "trip-1", donorId: "d2", givingActivityId: "ga-3" });

  const active = db.prepare("SELECT COUNT(*) AS cnt FROM trip_financial_attributions WHERE trip_id = ? AND removed_at IS NULL").get("trip-1");
  assert.equal(active.cnt, 3, "a donor with multiple real records, and multiple donors, can all be attributed to the same trip independently");
}

process.stdout.write("trip-financial-attribution-schema.test.mjs: all assertions passed\n");
