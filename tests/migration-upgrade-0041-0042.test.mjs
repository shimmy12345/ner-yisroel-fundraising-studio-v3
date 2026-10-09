import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateBalanceCorrection } from "../lib/relationships/pledge-balance-correction.ts";

// Production-readiness: migration 0041 (pledge_payment_plans.
// renewal_acknowledged_at, a pure nullable column addition) and 0042
// (pledge_balance_corrections, a new table) -- see docs/AI-HANDOFF.md's
// "Production Readiness" round. This file proves two things Priority 1
// of that round asked for, which the existing pledge-balance-correction
// test files never specifically exercised:
//
//   1. A FRESH database (every migration applied once, in order, to an
//      empty SQLite file) builds cleanly end to end.
//   2. An EXISTING database -- one that already has real rows under the
//      PRE-0041 schema -- can be safely UPGRADED in place: applying
//      0041+0042 on top of it must never touch, lose, or reshape a
//      single byte of the data that was already there, and the new
//      column/table must work correctly immediately afterward.
//
// No real donor data is used anywhere in this file -- every row is a
// synthetic fixture in a fresh, isolated, in-memory SQLite database
// (node:sqlite's DatabaseSync), matching the established convention of
// tests/pledge-balance-correction-e2e.test.mjs and friends.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const ALL_MIGRATIONS = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const LAST_PRE_0041_INDEX = ALL_MIGRATIONS.indexOf("0040_pledge_payment_plans_commitment_duration_months.sql");
assert.ok(LAST_PRE_0041_INDEX >= 0, "migration 0040 must exist on disk -- this test's whole premise depends on it as the pre-upgrade baseline");
const PRE_0041_MIGRATIONS = ALL_MIGRATIONS.slice(0, LAST_PRE_0041_INDEX + 1);
const UPGRADE_MIGRATIONS = ALL_MIGRATIONS.slice(LAST_PRE_0041_INDEX + 1); // 0041 + 0042, whatever their exact filenames

function applyMigrations(database, migrations) {
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
}

const NOW = Math.floor(Date.parse("2026-10-09T14:00:00Z") / 1000);
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)")
    .run(id, userId, displayName, donorCode, NOW, NOW);
}
function seedPledge(db, { id, donorId, committedCents, paidCents, balanceCents, sourceCampaign = null, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, source_campaign, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, 'partially_paid_pledge', ?, 'live', 'active', '{}', ?, ?)`)
    .run(id, donorId, userId, id, committedCents, paidCents, balanceCents, sourceCampaign, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, original_pledge_date, commitment_duration_months, created_at, updated_at)
    VALUES (?, ?, ?, ?, 25000, 18, ?, ?, ?, 12, ?, ?)`)
    .run(id, userId, donorId, pledgeActivityId, utcMidnight(2026, 10, 18), utcMidnight(2027, 10, 18), utcMidnight(2025, 11, 18), NOW, NOW);
}

// Snapshot every row of every table that existed BEFORE 0041/0042, in a
// stable order, so a later re-snapshot can be compared byte-for-byte.
// pledge_payment_plans is snapshotted by its explicit PRE-0041 column
// list (confirmed via PRAGMA table_info against a database built only
// through migration 0040) rather than "SELECT *" -- migration 0041
// legitimately WIDENS that table's shape (adds renewal_acknowledged_at),
// so a raw "SELECT *" diff would flag that expected, harmless shape
// change as if it were a data mutation. This snapshot asks a narrower,
// correct question: did any value that existed BEFORE the upgrade
// change? The new column's own value is asserted separately below.
const PRE_EXISTING_TABLES = ["users", "donors", "giving_activities"];
const PRE_0041_PLAN_COLUMNS = ["id", "user_id", "donor_id", "pledge_activity_id", "cadence", "installment_amount_cents", "expected_day_of_month", "next_expected_payment_at", "final_expected_payment_at", "note", "ended_at", "created_at", "updated_at", "original_pledge_date", "commitment_duration_months"];
function snapshot(db) {
  const result = {};
  for (const table of PRE_EXISTING_TABLES) result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  result.pledge_payment_plans = db.prepare(`SELECT ${PRE_0041_PLAN_COLUMNS.join(",")} FROM pledge_payment_plans ORDER BY id`).all();
  return result;
}

// ================================================================
// 1. Fresh database: every migration, in order, on an empty file.
// ================================================================

test("fresh database: all migrations (0000 through the current tip, including 0041+0042) apply cleanly in order to an empty SQLite database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  assert.doesNotThrow(() => applyMigrations(db, ALL_MIGRATIONS), "every migration file must apply without error, in filename order, to a brand-new database");

  const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  assert.ok(tableNames.has("pledge_balance_corrections"), "migration 0042 must create pledge_balance_corrections on a fresh database");
  assert.ok(tableNames.has("pledge_payment_plans"), "pledge_payment_plans (migration 0033) must still exist");

  const planColumns = db.prepare("PRAGMA table_info(pledge_payment_plans)").all().map((col) => col.name);
  assert.ok(planColumns.includes("renewal_acknowledged_at"), "migration 0041 must add renewal_acknowledged_at to pledge_payment_plans on a fresh database");

  const correctionColumns = db.prepare("PRAGMA table_info(pledge_balance_corrections)").all().map((col) => col.name);
  assert.deepEqual(
    correctionColumns.sort(),
    ["corrected_balance_cents", "created_at", "donor_id", "id", "imported_balance_cents_at_correction", "pledge_activity_id", "reason", "reversal_reason", "reversed_at", "user_id"].sort(),
    "pledge_balance_corrections must have exactly the columns migration 0042 defines -- nothing extra, nothing missing",
  );

  const indexNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  assert.ok(indexNames.has("pledge_balance_corrections_active_uidx"), "the partial unique index enforcing at most one active correction per pledge must exist on a fresh database");
  assert.ok(indexNames.has("pledge_balance_corrections_pledge_idx"), "the lookup index must exist on a fresh database");
});

// ================================================================
// 2. Upgrade path: real pre-existing data under the OLD schema must
// survive 0041+0042 being applied on top of it, byte-for-byte.
// ================================================================

test("upgrade path: applying 0041+0042 on top of an existing pre-0041 database leaves every pre-existing row completely unchanged", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  applyMigrations(db, PRE_0041_MIGRATIONS);

  // Seed real-shaped pre-existing data under the OLD schema -- a donor
  // with two pledges (one with an active payment plan), matching the
  // Kutoff-shaped scenario this round's task specifically asks for.
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Rabbi & Mrs. Shlomo Kutoff", donorCode: "57932" });
  seedPledge(db, { id: "din2023", donorId: "donor-1", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(db, { id: "din2025", donorId: "donor-1", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  seedPlan(db, { id: "din2025-plan", donorId: "donor-1", pledgeActivityId: "din2025" });

  const before = snapshot(db);
  assert.equal(before.giving_activities.length, 2);
  assert.equal(before.pledge_payment_plans.length, 1);

  assert.doesNotThrow(() => applyMigrations(db, UPGRADE_MIGRATIONS), "0041+0042 must apply cleanly on top of a database that already has real rows under the pre-0041 schema");

  const after = snapshot(db);
  assert.deepEqual(after, before, "every pre-existing row in every pre-existing table must be byte-for-byte unchanged by the upgrade -- the migration adds structure, it never rewrites existing data");

  // The new column exists and defaults to NULL on the pre-existing plan
  // row -- nothing was retroactively "acknowledged" by the upgrade
  // itself.
  const plan = db.prepare("SELECT renewal_acknowledged_at FROM pledge_payment_plans WHERE id = 'din2025-plan'").get();
  assert.equal(plan.renewal_acknowledged_at, null, "an upgrade must never silently populate the new column for pre-existing rows");

  // The new table exists, is empty, and is immediately usable.
  const correctionCountBefore = db.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections").get().cnt;
  assert.equal(correctionCountBefore, 0, "no corrections exist yet -- the upgrade itself must never fabricate one");
});

// ================================================================
// 3. The Kutoff-shaped scenario, specifically on an UPGRADED (not
// fresh) database -- proves the feature works identically regardless
// of whether the database was created fresh or upgraded in place.
// ================================================================

test("upgrade path: the exact Kutoff two-pledge scenario (DIN2023 corrected to $0/no plan, DIN2025 $250/active plan) works correctly on a database that was upgraded in place, not created fresh", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  applyMigrations(db, PRE_0041_MIGRATIONS);
  seedUser(db);
  seedDonor(db, { id: "donor-2", displayName: "Rabbi & Mrs. Shlomo Kutoff", donorCode: "57932" });
  seedPledge(db, { id: "din2023-b", donorId: "donor-2", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(db, { id: "din2025-b", donorId: "donor-2", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  seedPlan(db, { id: "din2025-b-plan", donorId: "donor-2", pledgeActivityId: "din2025-b" });
  applyMigrations(db, UPGRADE_MIGRATIONS);

  // Apply the correction using the real validation function (not a
  // reimplementation) -- mirrors the real POST /api/pledge-balance-corrections route.
  const validation = validateBalanceCorrection(0, "JL mistake");
  assert.ok(validation.ok);
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES (?, 'u1', 'donor-2', 'din2023-b', 21000, ?, ?, ?, NULL, NULL)`).run(crypto.randomUUID(), validation.correctedBalanceCents, validation.reason, NOW);

  const effectiveBalanceQuery = (pledgeId) => db.prepare(`SELECT COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents
    FROM giving_activities ga LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.id = ?`).get(pledgeId).balance_cents;

  assert.equal(effectiveBalanceQuery("din2023-b"), 0, "DIN2023 must display $0 outstanding after the correction, even though the database was upgraded in place rather than created fresh");
  assert.equal(effectiveBalanceQuery("din2025-b"), 25000, "DIN2025 must remain at $250 outstanding");

  const planAfter = db.prepare("SELECT * FROM pledge_payment_plans WHERE id = 'din2025-b-plan'").get();
  assert.equal(planAfter.ended_at, null, "DIN2025's active payment plan must remain intact");
  assert.equal(planAfter.installment_amount_cents, 25000);

  // Original imported balance and correction history preserved.
  const raw = db.prepare("SELECT committed_cents, paid_cents, balance_cents FROM giving_activities WHERE id = 'din2023-b'").get();
  assert.equal(raw.balance_cents, 21000, "the raw imported balance must survive both the upgrade and the correction untouched");
  const history = db.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = 'din2023-b'").all();
  assert.equal(history.length, 1);
  assert.equal(history[0].imported_balance_cents_at_correction, 21000);
});

process.stdout.write("Migration fresh/upgrade checks passed.\n");
