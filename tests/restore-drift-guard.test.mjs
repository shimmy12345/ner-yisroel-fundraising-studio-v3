import assert from "node:assert/strict";
import {
  compareCrossBranchRestoreState,
  diffMigrationLists,
  extractForeignKeyTargets,
  formatDriftReport,
  validateRestoreOrderAgainstSchema,
} from "../lib/operations/restore-drift-guard.ts";

// Generic D1 restore/schema drift guard -- preventative test coverage for
// the failure class behind GitHub Actions run 36887668901 (donor_source_
// attributions existed in the real backup but was absent from main's
// separately-synced restore order/manifest). Every scenario here is
// synthetic and table-name-agnostic on purpose: none of it ever
// references "donor_source_attributions" by name, proving the guard
// works for any future migration/table, not just the one that already
// happened.

const USERS = { type: "table", name: "users", sql: "CREATE TABLE `users` (`id` text PRIMARY KEY NOT NULL)" };
const DONORS = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
const ROOTS = ["production_schema_baseline", "users", "onboarding_preferences", "backup_alert_state"];

function state({ ddlTopology, sourceMigrations, restoreOrder, skipDataTables = [] }) {
  return { ddlTopology, sourceMigrations, restoreOrder, skipDataTables };
}

// ---- extractForeignKeyTargets ----

{
  const targets = extractForeignKeyTargets(DONORS.sql);
  assert.deepEqual(targets, ["users"]);
}
{
  const selfRef = "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `merged_into_donor_id` text, FOREIGN KEY (`merged_into_donor_id`) REFERENCES `donors`(`id`), FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))";
  assert.deepEqual(extractForeignKeyTargets(selfRef), ["donors", "users"]);
}

// ---- validateRestoreOrderAgainstSchema ----

{
  // Correct order: users before donors.
  const issues = validateRestoreOrderAgainstSchema([USERS, DONORS], ["users", "donors"]);
  assert.deepEqual(issues, []);
}
{
  // donors missing entirely from the order.
  const issues = validateRestoreOrderAgainstSchema([USERS, DONORS], ["users"]);
  assert.deepEqual(issues, [{ kind: "missing_from_order", table: "donors" }]);
}
{
  // donors present but BEFORE users -- its own real FK target.
  const issues = validateRestoreOrderAgainstSchema([USERS, DONORS], ["donors", "users"]);
  assert.deepEqual(issues, [{ kind: "fk_order_violation", table: "donors", mustFollow: "users" }]);
}
{
  // Self-reference must never be flagged as a violation.
  const selfRefTable = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `merged_into_donor_id` text, FOREIGN KEY (`merged_into_donor_id`) REFERENCES `donors`(`id`))" };
  const issues = validateRestoreOrderAgainstSchema([selfRefTable], ["donors"]);
  assert.deepEqual(issues, []);
}
{
  // Skip-data tables (import_preview_sessions-style) are exempt from the
  // "must appear in order" requirement.
  const ephemeral = { type: "table", name: "import_preview_sessions", sql: "CREATE TABLE `import_preview_sessions` (`id` text PRIMARY KEY NOT NULL)" };
  const issues = validateRestoreOrderAgainstSchema([ephemeral], [], ["import_preview_sessions"]);
  assert.deepEqual(issues, []);
}

// ---- diffMigrationLists ----

{
  const diff = diffMigrationLists(["0000_a.sql", "0001_b.sql"], ["0000_a.sql"]);
  assert.deepEqual(diff, { onlyOnFeature: ["0001_b.sql"], onlyOnMain: [] });
}

// ---- compareCrossBranchRestoreState: the 8 required scenarios ----

// 1. Identical schema on both sides -> PASS.
{
  const feature = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, true, formatDriftReport(report));
}

// 2. New table on feature, missing from main's restore order -> FAIL.
{
  const NEW_TABLE = { type: "table", name: "asks", sql: "CREATE TABLE `asks` (`id` text PRIMARY KEY NOT NULL, `donor_id` text NOT NULL, FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS, NEW_TABLE], sourceMigrations: ["0000_a.sql", "0001_asks.sql"], restoreOrder: [...ROOTS, "donors", "asks"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.deepEqual(report.missingFromMainOrder, ["asks"]);
}

// 3. New table present in main's restore order but absent from main's own
// baseline manifest (hand-edited order without syncing the manifest) -> FAIL.
{
  const NEW_TABLE = { type: "table", name: "asks", sql: "CREATE TABLE `asks` (`id` text PRIMARY KEY NOT NULL)" };
  const feature = state({ ddlTopology: [USERS, DONORS, NEW_TABLE], sourceMigrations: ["0000_a.sql", "0001_asks.sql"], restoreOrder: [...ROOTS, "donors", "asks"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql", "0001_asks.sql"], restoreOrder: [...ROOTS, "donors", "asks"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.equal(report.missingFromMainOrder.length, 0, "the table IS present in main's order, so this is not a missing-from-order case");
  assert.equal(report.schemaComparison.matches, false);
  assert.match(report.schemaComparison.differences.join(" "), /Missing table: asks/);
}

// 4. Migration count differs -> FAIL.
{
  const feature = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql", "0001_b.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.deepEqual(report.migrationDrift, { onlyOnFeature: ["0001_b.sql"], onlyOnMain: [] });
}

// 5. Existing table gains columns on feature but main's manifest is stale -> FAIL.
{
  const DONORS_WITH_NEW_COLUMN = { ...DONORS, sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, `archived_at` integer, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS_WITH_NEW_COLUMN], sourceMigrations: ["0000_a.sql", "0001_archive.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql", "0001_archive.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.match(report.schemaComparison.differences.join(" "), /Table definition differs: donors/);
}

// 6. New foreign key changes dependency requirements; main's restore order
// no longer guarantees correct ordering -> FAIL.
{
  const PLEDGE_PLANS = { type: "table", name: "pledge_payment_plans", sql: "CREATE TABLE `pledge_payment_plans` (`id` text PRIMARY KEY NOT NULL, `donor_id` text NOT NULL, FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS, PLEDGE_PLANS], sourceMigrations: ["0000_a.sql", "0001_plans.sql"], restoreOrder: [...ROOTS, "pledge_payment_plans", "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS, PLEDGE_PLANS], sourceMigrations: ["0000_a.sql", "0001_plans.sql"], restoreOrder: [...ROOTS, "pledge_payment_plans", "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.deepEqual(report.restoreOrderIssues, [{ kind: "fk_order_violation", table: "pledge_payment_plans", mustFollow: "donors" }]);
}

// 7. Extra stale table on main (removed from the canonical schema, but
// main's restore order still lists it) -> detected and reported, not
// silently ignored.
{
  const feature = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors", "a_removed_table"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.deepEqual(report.staleInMainOrder, ["a_removed_table"]);
}

// 8. Real current repository state (after commit ad80cf6) -> PASS. This is
// an integration-style check exercised separately by
// scripts/check-main-restore-sync.mjs against the real branches (see
// docs/AI-HANDOFF.md for that run's result) -- not duplicated here since
// it requires reading another git ref, which this file's synthetic
// fixtures deliberately avoid needing.
{
  assert.equal(typeof compareCrossBranchRestoreState, "function");
}

// 9. Regression (2026-11-02, "Final Schema and Deployment Safeguard
// Cleanup", see docs/AI-HANDOFF.md): schemaComparison must use the SAME
// order-independent comparison as lib/data-health/production-baseline.ts's
// own compareSchemaObjects, not a stale, separately hand-maintained copy.
// Before this fix, this module defined its own local re-implementation
// that compared each table's CREATE TABLE text as one opaque,
// order-sensitive string -- so a column that physically landed in a
// different position on one branch than the other (the exact,
// already-confirmed-harmless drift behind the real interactions/
// trip_prospects warnings) registered as a false "Table definition
// differs" here too, even after the real check was fixed to tolerate it.
// A pure column reorder with an otherwise byte-identical column set must
// report in sync.
{
  const DONORS_COLUMN_ORDER_A = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, `archived_at` integer, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const DONORS_COLUMN_ORDER_B = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `archived_at` integer, `owner_user_id` text NOT NULL, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS_COLUMN_ORDER_A], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS_COLUMN_ORDER_B], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, true, formatDriftReport(report));
}
// And a genuinely missing column across branches must still fail -- the
// fix must not have traded a false positive for a false negative.
{
  const DONORS_WITH_EXTRA_COLUMN = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, `archived_at` integer, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS_WITH_EXTRA_COLUMN], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const report = compareCrossBranchRestoreState(feature, main);
  assert.equal(report.inSync, false);
  assert.match(report.schemaComparison.differences.join(" "), /Table definition differs: donors/);
}

process.stdout.write("Restore drift guard checks passed.\n");
