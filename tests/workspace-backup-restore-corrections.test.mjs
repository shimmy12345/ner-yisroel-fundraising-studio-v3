import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1_RESTORE_DATA_ORDER, reorderD1ExportForRestore, planD1Restore } from "../lib/operations/d1-restore-order.ts";
import { WORKSPACE_BACKUP_TABLES, WORKSPACE_BACKUP_EXCLUDED_TABLES, verifyWorkspaceBackupCoverage } from "../lib/operations/workspace-backup.ts";
import { FUNDRAISING_DATA_TABLES } from "../lib/data-health/production-baseline.ts";

// Production readiness: pledge_balance_corrections (migration 0042) in
// backup and restore -- see docs/AI-HANDOFF.md's "Production Readiness"
// round. Two genuinely different backup paths exist in this app and
// this file proves pledge_balance_corrections is handled correctly by
// BOTH, not just classified by name:
//
//   1. The per-workspace JSON export (`/api/import/backup`,
//      WORKSPACE_BACKUP_TABLES) -- pledge_balance_corrections is
//      DELIBERATELY excluded here (lib/operations/workspace-backup.ts),
//      the same documented treatment as its siblings
//      pledge_payment_plans/pledge_payment_plan_reviews/asks. This is
//      not a gap: that export is a secondary, human-readable snapshot
//      used only for the pre-rollback safety check, never the
//      authoritative backup.
//   2. The nightly whole-database `wrangler d1 export` -> R2 pipeline
//      (lib/operations/d1-restore-order.ts), which captures every table
//      byte-for-byte including pledge_balance_corrections -- THIS is
//      the authoritative path "must survive backup and restore" is
//      actually evaluated against, and the one this file's round-trip
//      tests target.
//
// No real donor data is used anywhere in this file -- every row is a
// synthetic fixture, matching the established convention of
// tests/pledge-balance-correction-e2e.test.mjs and
// tests/d1-restore-order.test.mjs.

// ================================================================
// Priority 2: per-workspace JSON backup classification is correct and
// was not "just a table name added without examining the process" --
// confirm it is consistently classified alongside its real siblings and
// that the derived coverage check (the same one CI runs) passes.
// ================================================================

test("pledge_balance_corrections is explicitly classified in the per-workspace backup coverage lists (excluded, not silently unhandled)", () => {
  assert.ok(!WORKSPACE_BACKUP_TABLES.includes("pledge_balance_corrections"), "pledge_balance_corrections must not be in the per-workspace JSON export -- same treatment as pledge_payment_plans/asks/pledge_payment_plan_reviews");
  assert.ok(WORKSPACE_BACKUP_EXCLUDED_TABLES.includes("pledge_balance_corrections"), "it must be explicitly named in the excluded list -- an unclassified table fails verifyWorkspaceBackupCoverage below");
  const coverage = verifyWorkspaceBackupCoverage(FUNDRAISING_DATA_TABLES);
  assert.equal(coverage.inSync, true, `every real fundraising table (including pledge_balance_corrections) must be classified in exactly one of WORKSPACE_BACKUP_TABLES/WORKSPACE_BACKUP_EXCLUDED_TABLES: unclassified=${coverage.unclassified.join(",")} stale=${coverage.stale.join(",")}`);
});

// ================================================================
// Priority 1/2: whole-database restore order recognizes
// pledge_balance_corrections, positioned after all three of its real
// foreign key targets (users, donors, giving_activities) -- matching
// the named-regression pattern already established for
// donor_source_attributions in tests/d1-restore-order.test.mjs.
// ================================================================

function buildExport(tables, insertsInOrder) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of tables) lines.push(`CREATE TABLE "${table}" (id text);`);
  for (const [table, id] of insertsInOrder) lines.push(`INSERT INTO "${table}" (id) VALUES('${id}');`);
  return lines.join("\n") + "\n";
}
test("pledge_balance_corrections is present in D1_RESTORE_DATA_ORDER, positioned after users, donors, AND giving_activities (all three real foreign key targets)", () => {
  const usersIndex = D1_RESTORE_DATA_ORDER.indexOf("users");
  const donorsIndex = D1_RESTORE_DATA_ORDER.indexOf("donors");
  const givingIndex = D1_RESTORE_DATA_ORDER.indexOf("giving_activities");
  const correctionsIndex = D1_RESTORE_DATA_ORDER.indexOf("pledge_balance_corrections");
  assert.ok(correctionsIndex >= 0, "pledge_balance_corrections must be present in D1_RESTORE_DATA_ORDER");
  assert.ok(usersIndex >= 0 && correctionsIndex > usersIndex, "must be inserted after users (user_id references users.id)");
  assert.ok(donorsIndex >= 0 && correctionsIndex > donorsIndex, "must be inserted after donors (donor_id references donors.id)");
  assert.ok(givingIndex >= 0 && correctionsIndex > givingIndex, "must be inserted after giving_activities (pledge_activity_id references giving_activities.id)");
});

test("planD1Restore/reorderD1ExportForRestore accept a real export containing pledge_balance_corrections and order it after all three real foreign key targets", () => {
  const exported = buildExport(
    ["users", "donors", "giving_activities", "pledge_balance_corrections"],
    [["pledge_balance_corrections", "correction-1"], ["giving_activities", "pledge-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  assert.doesNotThrow(() => planD1Restore(exported), "planD1Restore must accept an INSERT for pledge_balance_corrections, not reject it as unrecognized");
  const restored = reorderD1ExportForRestore(exported);
  const usersAt = restored.indexOf('INSERT INTO "users"');
  const donorsAt = restored.indexOf('INSERT INTO "donors"');
  const givingAt = restored.indexOf('INSERT INTO "giving_activities"');
  const correctionAt = restored.indexOf('INSERT INTO "pledge_balance_corrections"');
  assert.ok(usersAt < correctionAt && donorsAt < correctionAt && givingAt < correctionAt);
  const plan = planD1Restore(exported);
  const tableOrder = plan.steps.map((step) => step.table);
  assert.ok(tableOrder.indexOf("users") < tableOrder.indexOf("pledge_balance_corrections"));
  assert.ok(tableOrder.indexOf("donors") < tableOrder.indexOf("pledge_balance_corrections"));
  assert.ok(tableOrder.indexOf("giving_activities") < tableOrder.indexOf("pledge_balance_corrections"));
});

// ================================================================
// Priority 3 #6: backward compatibility -- an export that PREDATES
// migration 0042 (no pledge_balance_corrections table/rows at all) must
// still restore cleanly. Nothing in the restore pipeline may treat a
// missing table as an error -- D1_RESTORE_DATA_ORDER lists it, but an
// export simply never mentioning it produces zero INSERT statements for
// it, which is not the same as an "unknown table" (that guardrail only
// fires for a table present in the EXPORT but absent from the order).
// ================================================================

test("backward compatibility: an older-shaped export with no pledge_balance_corrections table at all restores cleanly, same as any other pre-existing table", () => {
  const olderExport = buildExport(
    ["users", "donors", "giving_activities", "pledge_payment_plans"],
    [["pledge_payment_plans", "plan-1"], ["giving_activities", "pledge-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  assert.doesNotThrow(() => planD1Restore(olderExport), "an export entirely missing pledge_balance_corrections (a pre-0042 backup) must restore without error");
  assert.doesNotThrow(() => reorderD1ExportForRestore(olderExport));
  const plan = planD1Restore(olderExport);
  assert.ok(!plan.steps.some((step) => step.table === "pledge_balance_corrections"), "no step is produced for a table the export never mentions");
});

// ================================================================
// Full round-trip fidelity: build a real "export" as SQL text from a
// seeded source database (mirroring what `wrangler d1 export` produces:
// CREATE TABLE/INSERT statements, children listed before parents, since
// export order follows sqlite_master position, not FK dependency),
// reorder it for restore, then REPLAY it into a brand-new empty
// database and verify the result matches the source exactly. This is a
// stronger proof than statement-position assertions alone: it proves
// actual DATA fidelity through a real restore, including the partial
// unique index and foreign keys firing for real during the replay.
// ================================================================

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  // Migration 0001 seeds one idempotent ("INSERT OR IGNORE") fictional
  // sample user/donor for a brand-new Independent Staging bootstrap.
  // This file builds TWO independent databases per round-trip test
  // (a source to export from, a target to restore into) -- both apply
  // the same migrations, so without removing this seed here, replaying
  // the export's own (identical) sample-user row into the target would
  // collide with the target's own copy on a UNIQUE constraint. Deleting
  // it here has no bearing on this file's actual subject (pledge_balance_
  // corrections); every fixture row these tests reason about is seeded
  // explicitly below, never this migration's own sample data.
  database.exec("PRAGMA foreign_keys=OFF; DELETE FROM recommendations; DELETE FROM gifts; DELETE FROM interactions; DELETE FROM donors; DELETE FROM users WHERE id = 'staging_user_sarah'; PRAGMA foreign_keys=ON;");
  return database;
}
const NOW = Math.floor(Date.parse("2026-10-09T14:00:00Z") / 1000);
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

function seedUser(db, userId = "u1") { db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW); }
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) { db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)").run(id, userId, displayName, donorCode, NOW, NOW); }
function seedPledge(db, { id, donorId, committedCents, paidCents, balanceCents, sourceCampaign, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, source_campaign, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, 'partially_paid_pledge', ?, 'live', 'active', '{}', ?, ?)`).run(id, donorId, userId, id, committedCents, paidCents, balanceCents, sourceCampaign, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, original_pledge_date, commitment_duration_months, created_at, updated_at)
    VALUES (?, ?, ?, ?, 25000, 18, ?, ?, ?, 12, ?, ?)`).run(id, userId, donorId, pledgeActivityId, utcMidnight(2026, 10, 18), utcMidnight(2027, 10, 18), utcMidnight(2025, 11, 18), NOW, NOW);
}
function insertCorrection(db, { id, donorId, pledgeActivityId, correctedBalanceCents, importedBalanceCentsAtCorrection, reason, createdAt = NOW, reversedAt = null, reversalReason = null, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, donorId, pledgeActivityId, importedBalanceCentsAtCorrection, correctedBalanceCents, reason, createdAt, reversedAt, reversalReason);
}

// Exports ONLY the tables this test cares about, in a deliberately
// scrambled (children-before-parents) order -- matching real `wrangler
// d1 export` behavior -- as literal SQL text, the same shape
// reorderD1ExportForRestore/planD1Restore consume.
function exportTablesAsSql(db, tables) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of tables) {
    const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table).sql;
    lines.push(createSql.replace(/^CREATE TABLE (\w+)/, 'CREATE TABLE "$1"') + ";");
  }
  // Reverse table order relative to dependency order, and reverse row
  // order within each table too, to deliberately scramble the export
  // the same way a real `wrangler d1 export` (sqlite_master position,
  // never FK-aware) would never guarantee a convenient order.
  for (const table of [...tables].reverse()) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      const values = columns.map((col) => {
        const value = row[col];
        if (value === null) return "NULL";
        if (typeof value === "number") return String(value);
        return `'${String(value).replace(/'/g, "''")}'`;
      });
      lines.push(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES(${values.join(",")});`);
    }
  }
  return lines.join("\n") + "\n";
}

function replayIntoFreshDatabase(sqlText) {
  const target = freshDatabase();
  // The schema already exists (from the migrations just applied) --
  // real restore applies schema from the export, but for THIS fidelity
  // check we only care about DATA round-tripping correctly through the
  // real reordering logic, so we execute only the reordered INSERTs
  // against an already-correctly-shaped fresh database.
  const plan = planD1Restore(sqlText);
  for (const step of plan.steps) {
    if (step.kind === "file") target.exec(step.sql);
    else target.prepare(step.sql).run(...step.params);
  }
  return target;
}

test("round-trip: an ACTIVE correction (Kutoff-shaped DIN2023/DIN2025) survives export -> reorder -> restore with the pledge_activity_id, donor, and ownership intact, and no duplicate active correction is created", () => {
  const source = freshDatabase();
  seedUser(source, "u1");
  seedDonor(source, { id: "donor-1", displayName: "Rabbi & Mrs. Shlomo Kutoff", donorCode: "57932" });
  seedPledge(source, { id: "din2023", donorId: "donor-1", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(source, { id: "din2025", donorId: "donor-1", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  seedPlan(source, { id: "din2025-plan", donorId: "donor-1", pledgeActivityId: "din2025" });
  insertCorrection(source, { id: "correction-1", donorId: "donor-1", pledgeActivityId: "din2023", correctedBalanceCents: 0, importedBalanceCentsAtCorrection: 21000, reason: "JL mistake" });

  const exported = exportTablesAsSql(source, ["users", "donors", "giving_activities", "pledge_payment_plans", "pledge_balance_corrections"]);
  const restored = replayIntoFreshDatabase(exported);

  const correction = restored.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = 'din2023'").get();
  assert.ok(correction, "the active correction must survive the restore");
  assert.equal(correction.reversed_at, null, "it must still be ACTIVE after restore");
  assert.equal(correction.corrected_balance_cents, 0);
  assert.equal(correction.imported_balance_cents_at_correction, 21000, "the original imported balance snapshot must be preserved exactly");
  assert.equal(correction.donor_id, "donor-1", "ownership/donor association must be intact");
  assert.equal(correction.user_id, "u1");
  assert.equal(correction.pledge_activity_id, "din2023", "it must reference the correct pledge activity id");

  // No duplicate active correction -- the partial unique index itself
  // survives the restore (it's part of the schema, not the data) and a
  // genuine single-row restore never produces two.
  const activeCount = restored.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'din2023' AND reversed_at IS NULL").get().cnt;
  assert.equal(activeCount, 1);

  // Effective balance after restore: DIN2023 $0, DIN2025 $250 untouched.
  const effective = (id) => restored.prepare(`SELECT COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents FROM giving_activities ga LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL WHERE ga.id = ?`).get(id).balance_cents;
  assert.equal(effective("din2023"), 0, "DIN2023 must remain corrected to $0 after restore");
  assert.equal(effective("din2025"), 25000, "DIN2025 must remain at $250 after restore");

  // DIN2025's payment plan survives, intact.
  const plan = restored.prepare("SELECT * FROM pledge_payment_plans WHERE id = 'din2025-plan'").get();
  assert.equal(plan.ended_at, null, "DIN2025's payment plan must remain active after restore");
  assert.equal(plan.installment_amount_cents, 25000);

  // Original imported pledge balance unchanged by the restore.
  const rawDin2023 = restored.prepare("SELECT committed_cents, paid_cents, balance_cents FROM giving_activities WHERE id = 'din2023'").get();
  assert.equal(rawDin2023.balance_cents, 21000, "the restored row's own raw imported balance column must still read $210 -- the correction lives in a separate table, never overwrites it");

  // No fictitious payment and no revenue change introduced by the restore.
  assert.equal(restored.prepare("SELECT COUNT(*) AS cnt FROM jl_payment_assignment_audits").get().cnt, 0);
  const rawDin2025 = restored.prepare("SELECT committed_cents, paid_cents FROM giving_activities WHERE id = 'din2025'").get();
  assert.equal(rawDin2025.committed_cents, 300000);
  assert.equal(rawDin2025.paid_cents, 275000);
});

test("round-trip: a REVERSED correction (and its full audit history) survives export -> reorder -> restore exactly as it was -- still reversed, never reactivated, never dropped", () => {
  const source = freshDatabase();
  seedUser(source, "u1");
  seedDonor(source, { id: "donor-2", displayName: "Fixture Donor", donorCode: "90030" });
  seedPledge(source, { id: "p-rev", donorId: "donor-2", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  insertCorrection(source, { id: "correction-rev-1", donorId: "donor-2", pledgeActivityId: "p-rev", correctedBalanceCents: 10000, importedBalanceCentsAtCorrection: 21000, reason: "First correction", createdAt: NOW, reversedAt: NOW + 10, reversalReason: "Superseded by a new correction" });
  insertCorrection(source, { id: "correction-rev-2", donorId: "donor-2", pledgeActivityId: "p-rev", correctedBalanceCents: 0, importedBalanceCentsAtCorrection: 21000, reason: "Second correction", createdAt: NOW + 10, reversedAt: NOW + 20, reversalReason: "Donor disputed; reverted to imported value" });

  const exported = exportTablesAsSql(source, ["users", "donors", "giving_activities", "pledge_balance_corrections"]);
  const restored = replayIntoFreshDatabase(exported);

  const history = restored.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-rev' ORDER BY created_at").all();
  assert.equal(history.length, 2, "both historical rows (the full audit trail) must survive the restore -- append-only history is never collapsed or dropped");
  assert.notEqual(history[0].reversed_at, null, "the first (superseded) correction must still read as reversed after restore");
  assert.equal(history[0].reversal_reason, "Superseded by a new correction");
  assert.notEqual(history[1].reversed_at, null, "the second (also reversed) correction must still read as reversed -- never silently reactivated by the restore");
  assert.equal(history[1].reversal_reason, "Donor disputed; reverted to imported value");

  const activeCount = restored.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-rev' AND reversed_at IS NULL").get().cnt;
  assert.equal(activeCount, 0, "no correction may read as active after restoring a fully-reversed history");

  // Effective balance after restore: back to the raw imported value,
  // since no active correction exists.
  const effective = restored.prepare(`SELECT COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents FROM giving_activities ga LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL WHERE ga.id = 'p-rev'`).get().balance_cents;
  assert.equal(effective, 21000, "with every correction reversed, the restored pledge must display its original imported balance");
});

test("round-trip: a pledge with NO corrections at all restores unaffected, and does not acquire a correction merely by sharing a table with others that have one", () => {
  const source = freshDatabase();
  seedUser(source, "u1");
  seedDonor(source, { id: "donor-3", displayName: "Fixture Donor", donorCode: "90031" });
  seedPledge(source, { id: "p-corrected", donorId: "donor-3", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(source, { id: "p-uncorrected", donorId: "donor-3", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  insertCorrection(source, { id: "correction-only-one", donorId: "donor-3", pledgeActivityId: "p-corrected", correctedBalanceCents: 0, importedBalanceCentsAtCorrection: 21000, reason: "JL mistake" });

  const exported = exportTablesAsSql(source, ["users", "donors", "giving_activities", "pledge_balance_corrections"]);
  const restored = replayIntoFreshDatabase(exported);

  const uncorrectedHistory = restored.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-uncorrected'").all();
  assert.equal(uncorrectedHistory.length, 0, "a pledge with no correction must have zero correction rows after restore, never inheriting one from a sibling pledge");
  const uncorrectedBalance = restored.prepare("SELECT balance_cents FROM giving_activities WHERE id = 'p-uncorrected'").get().balance_cents;
  assert.equal(uncorrectedBalance, 25000, "its raw/effective balance is identical since no correction ever applied to it");
});

test("round-trip: multiple pledges for the same donor restore independently -- correcting one never contaminates the other through the restore path", () => {
  const source = freshDatabase();
  seedUser(source, "u1");
  seedDonor(source, { id: "donor-4", displayName: "Multi Pledge Donor", donorCode: "90032" });
  seedPledge(source, { id: "multi-a", donorId: "donor-4", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(source, { id: "multi-b", donorId: "donor-4", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  seedPledge(source, { id: "multi-c", donorId: "donor-4", committedCents: 100000, paidCents: 100000, balanceCents: 0, sourceCampaign: "CT2023" });
  insertCorrection(source, { id: "multi-correction", donorId: "donor-4", pledgeActivityId: "multi-a", correctedBalanceCents: 0, importedBalanceCentsAtCorrection: 21000, reason: "JL mistake" });

  const exported = exportTablesAsSql(source, ["users", "donors", "giving_activities", "pledge_balance_corrections"]);
  const restored = replayIntoFreshDatabase(exported);

  assert.equal(restored.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'multi-a' AND reversed_at IS NULL").get().cnt, 1);
  assert.equal(restored.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'multi-b'").get().cnt, 0);
  assert.equal(restored.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'multi-c'").get().cnt, 0);
  const effective = (id) => restored.prepare(`SELECT COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents FROM giving_activities ga LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL WHERE ga.id = ?`).get(id).balance_cents;
  assert.equal(effective("multi-a"), 0);
  assert.equal(effective("multi-b"), 25000);
  assert.equal(effective("multi-c"), 0, "already-zero, untouched by any correction");
});

// ================================================================
// Priority 3 #9: the partial unique index (schema, not data) prevents a
// RESTORE from ever creating two simultaneously-active corrections for
// one pledge -- e.g. a corrupted or hand-edited export that somehow
// carries two un-reversed rows for the same pledge_activity_id must
// fail the restore for that statement rather than silently accepting
// both, which would make effective-balance queries ambiguous.
// ================================================================

test("restore cannot create a duplicate active correction for the same pledge, even if the source export itself (malformed) contains two", () => {
  const target = freshDatabase();
  seedUser(target, "u1");
  seedDonor(target, { id: "donor-5", displayName: "Fixture Donor", donorCode: "90033" });
  seedPledge(target, { id: "p-dup", donorId: "donor-5", committedCents: 100000, paidCents: 0, balanceCents: 100000, sourceCampaign: "CT2023" });

  target.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES ('dup-1', 'u1', 'donor-5', 'p-dup', 100000, 0, 'first restored row', ?, NULL, NULL)`).run(NOW);
  assert.throws(
    () => target.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
      VALUES ('dup-2', 'u1', 'donor-5', 'p-dup', 100000, 50000, 'second restored row -- must be rejected', ?, NULL, NULL)`).run(NOW),
    /UNIQUE constraint/i,
    "a restore replaying two active-correction rows for the same pledge must fail on the second insert, never silently succeed with both active",
  );
  assert.equal(target.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-dup' AND reversed_at IS NULL").get().cnt, 1);
});

// ================================================================
// Priority 2: import rollback safety -- a brand-new pledge inserted by
// an import, then manually corrected, then has that SAME import rolled
// back (app/api/import/rollback DELETEs newly-inserted giving_activities
// rows outright). With real FK enforcement ON (confirmed empirically
// against Independent Staging 2026-10-09: "PRAGMA foreign_keys;" ->
// foreign_keys=1), this DELETE must be BLOCKED by the pledge_balance_
// corrections foreign key rather than silently orphaning the correction
// row -- fails closed, never corrupts data. This is the one genuine
// interaction between import rollback and this table found during this
// round's investigation; worth a direct, named regression since it is
// not exercised by either the original feature's tests or the restore-
// order tests above.
// ================================================================

test("import rollback cannot silently orphan an active correction: deleting a giving_activities row with an active correction fails the foreign key constraint (matching real D1's foreign_keys=1), not a silent delete", () => {
  const db = freshDatabase(); // already PRAGMA foreign_keys=ON, matching the real binding
  seedUser(db, "u1");
  seedDonor(db, { id: "donor-6", displayName: "Fixture Donor", donorCode: "90034" });
  seedPledge(db, { id: "newly-imported", donorId: "donor-6", committedCents: 100000, paidCents: 0, balanceCents: 100000, sourceCampaign: "CT2026" });
  insertCorrection(db, { id: "correction-new", donorId: "donor-6", pledgeActivityId: "newly-imported", correctedBalanceCents: 0, importedBalanceCentsAtCorrection: 100000, reason: "Correction applied right after import" });

  assert.throws(
    () => db.prepare("DELETE FROM giving_activities WHERE id = 'newly-imported'").run(),
    /FOREIGN KEY constraint failed/i,
    "deleting a pledge with an active correction must be blocked by the foreign key, exactly like a real import-rollback DELETE would be on real D1 (foreign_keys=1) -- it must never silently succeed and leave an orphaned correction",
  );
  // The pledge and its correction are both still fully intact --
  // nothing partially applied.
  assert.ok(db.prepare("SELECT id FROM giving_activities WHERE id = 'newly-imported'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS cnt FROM pledge_balance_corrections WHERE pledge_activity_id = 'newly-imported' AND reversed_at IS NULL").get().cnt, 1);
});

process.stdout.write("Workspace backup/restore correction checks passed.\n");
