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

// --- Pending-Gift Reconciliation Fix (2026-10-15, independent review, see
// docs/AI-HANDOFF.md). Exercises the EXACT SQL lib/relationships/
// trips-data.ts's listTripFinancialAttributions and
// listEligibleGivingActivitiesForDonor run (reproduced verbatim here,
// against a real schema built from every migration), since that code
// itself imports "cloudflare:workers" and cannot run in plain Node --
// same established constraint tests/trip-financial-attribution-schema.test.mjs's
// other blocks above already work around by asserting SQL/schema behavior
// directly. ---

const LIST_ATTRIBUTIONS_SQL = `SELECT tfa.id AS attribution_id, tfa.giving_activity_id, tfa.donor_id, d.display_name AS donor_display_name,
      CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.category ELSE ga.category END AS category,
      CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.workspace_status ELSE ga.workspace_status END AS workspace_status,
      CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.committed_cents ELSE ga.committed_cents END AS committed_cents,
      CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.paid_cents ELSE ga.paid_cents END AS paid_cents,
      CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.balance_cents ELSE ga.balance_cents END AS balance_cents,
      (ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL) AS resolved_via_import_match,
      tfa.note, tfa.created_at
    FROM trip_financial_attributions tfa
    JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
    LEFT JOIN giving_activities confirmed ON confirmed.id = ga.confirmed_by_activity_id AND confirmed.owner_user_id = tfa.user_id
    JOIN donors d ON d.id = tfa.donor_id
    JOIN trips t ON t.id = tfa.trip_id
    WHERE tfa.trip_id = ? AND tfa.removed_at IS NULL AND t.owner_user_id = ?
    ORDER BY tfa.created_at DESC`;

const ELIGIBLE_ACTIVITIES_SQL = `SELECT ga.id, ga.category, ga.workspace_status, ga.committed_cents, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description
    FROM giving_activities ga
    WHERE ga.owner_user_id = ? AND ga.donor_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
      AND ga.category IN ('open_pledge','partially_paid_pledge','completed_gift','pending_gift','pending_pledge')
      AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa WHERE tfa.giving_activity_id = ga.id AND tfa.removed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa JOIN giving_activities pending ON pending.id = tfa.giving_activity_id WHERE pending.confirmed_by_activity_id = ga.id AND tfa.removed_at IS NULL)
    ORDER BY ga.activity_date DESC`;

const SHADOW_OF_ATTRIBUTED_PENDING_SQL = `SELECT 1 FROM trip_financial_attributions tfa JOIN giving_activities pending ON pending.id = tfa.giving_activity_id WHERE pending.confirmed_by_activity_id = ? AND tfa.removed_at IS NULL LIMIT 1`;

function seedPendingGift(db, { id, donorId, committedCents, userId = "u1", workspaceStatus = "active", confirmedByActivityId = null }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, confirmed_by_activity_id, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'manual-entry', 'hh-1', ?, ?, 0, 0, 'pending_gift', 'live', ?, ?, '{}', ?, ?)`)
    .run(id, donorId, userId, id, committedCents, workspaceStatus, confirmedByActivityId, NOW, NOW);
}

// A pending gift, attributed to a trip, that the JL import's own
// reconciliation later matches to a brand-new confirmed donation: the
// attribution row is never moved, but reading it back now resolves to the
// CONFIRMED record's own live figures -- not the stale pending snapshot --
// and flags resolved_via_import_match so the UI can label it.
{
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Pending Donor" });
  seedTrip(db, { id: "trip-1", goalCents: 10_000_00 });
  seedPendingGift(db, { id: "pending-1", donorId: "d1", committedCents: 5_000_00 });
  attribute(db, { id: "attr-1", tripId: "trip-1", donorId: "d1", givingActivityId: "pending-1" });

  const before = db.prepare(LIST_ATTRIBUTIONS_SQL).all("trip-1", "u1");
  assert.equal(before.length, 1);
  assert.equal(before[0].category, "pending_gift", "before any import match, the attribution reads the pending gift's own category");
  assert.equal(before[0].resolved_via_import_match, 0);

  // The JL import's own reconciliation (CONFIRM_PENDING_GIFT_SQL, see
  // lib/giving/management.ts) runs: a brand-new giving_activities row is
  // inserted for the real confirmed donation, and the ORIGINAL pending row
  // is flipped to workspace_status='merged' with confirmed_by_activity_id
  // pointing at it -- reproduced here exactly as app/api/import/route.ts's
  // pendingMergeStatements does it, never a second/competing mechanism.
  seedGivingActivity(db, { id: "confirmed-1", donorId: "d1", committedCents: 5_000_00, paidCents: 5_000_00, balanceCents: 0, category: "completed_gift" });
  db.prepare("UPDATE giving_activities SET workspace_status='merged', confirmed_by_activity_id=? WHERE id=?").run("confirmed-1", "pending-1");

  const after = db.prepare(LIST_ATTRIBUTIONS_SQL).all("trip-1", "u1");
  assert.equal(after.length, 1, "the SAME attribution row is reused -- never duplicated");
  assert.equal(after[0].attribution_id, "attr-1");
  assert.equal(after[0].giving_activity_id, "pending-1", "the attribution's own giving_activity_id is deliberately never rewritten");
  assert.equal(after[0].category, "completed_gift", "reading it back now resolves to the CONFIRMED record's category");
  assert.equal(after[0].workspace_status, "active");
  assert.equal(after[0].committed_cents, 5_000_00);
  assert.equal(after[0].paid_cents, 5_000_00);
  assert.equal(after[0].balance_cents, 0);
  assert.equal(after[0].resolved_via_import_match, 1, "flagged so the UI can show 'Confirmed via import'");

  // Double-counting guard: the confirmed row must never be offered as a
  // separate, unattributed opportunity -- it would double-count the same
  // real dollars under a second attribution row.
  const eligible = db.prepare(ELIGIBLE_ACTIVITIES_SQL).all("u1", "d1");
  assert.ok(!eligible.some((row) => row.id === "confirmed-1"), "the confirmed row must be excluded from 'Associate existing' once its pending predecessor is attributed");

  // Same guard, enforced at the actual write path (attributeGivingActivityToTrip),
  // never relying on the UI-filtered eligibility list alone.
  const shadow = db.prepare(SHADOW_OF_ATTRIBUTED_PENDING_SQL).get("confirmed-1");
  assert.ok(shadow, "a direct attempt to attribute the confirmed row must be detected and rejected, exactly like an already-attributed record");
}

// Rollback scenario (app/api/import/rollback/route.ts): the import is
// undone -- the new confirmed row is deleted and the original pending row
// is restored to workspace_status='active' with confirmed_by_activity_id
// cleared. The resolution must revert cleanly, with nothing left dangling.
{
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Rollback Donor" });
  seedTrip(db, { id: "trip-1", goalCents: null });
  seedPendingGift(db, { id: "pending-1", donorId: "d1", committedCents: 3_000_00 });
  attribute(db, { id: "attr-1", tripId: "trip-1", donorId: "d1", givingActivityId: "pending-1" });
  seedGivingActivity(db, { id: "confirmed-1", donorId: "d1", committedCents: 3_000_00, paidCents: 3_000_00, balanceCents: 0, category: "completed_gift" });
  db.prepare("UPDATE giving_activities SET workspace_status='merged', confirmed_by_activity_id=? WHERE id=?").run("confirmed-1", "pending-1");

  // Rollback: delete the confirmed row, restore the pending row.
  db.prepare("DELETE FROM giving_activities WHERE id = ?").run("confirmed-1");
  db.prepare("UPDATE giving_activities SET workspace_status='active', confirmed_by_activity_id=NULL WHERE id=?").run("pending-1");

  const rolledBack = db.prepare(LIST_ATTRIBUTIONS_SQL).all("trip-1", "u1");
  assert.equal(rolledBack.length, 1, "the attribution row survives the rollback untouched -- it was never rewritten in the first place");
  assert.equal(rolledBack[0].giving_activity_id, "pending-1");
  assert.equal(rolledBack[0].category, "pending_gift", "reverts cleanly to the pending gift's own figures -- nothing dangling, nothing to clean up");
  assert.equal(rolledBack[0].committed_cents, 3_000_00);
  assert.equal(rolledBack[0].resolved_via_import_match, 0);
}

process.stdout.write("trip-financial-attribution-schema.test.mjs: all assertions passed\n");
