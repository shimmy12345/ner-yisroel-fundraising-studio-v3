import assert from "node:assert/strict";
import {
  isSubsequence,
  planRestoreSyncPatch,
  renderProductionBaselineTsPatch,
  scanForDestructiveKeywords,
  tableFieldsFromSql,
} from "../lib/operations/restore-sync-generator.ts";

// D1 Migration Sync Automation (see docs/AI-HANDOFF.md and
// docs/D1-MIGRATION-SYNC-PROCESS.md) -- synthetic, table-name-agnostic
// coverage for the conservative generator behind the "prepare-sync" CI
// job, matching tests/restore-drift-guard.test.mjs's own established
// style. Every "unsafe" scenario here proves the generator REFUSES
// rather than attempts a guess; the one "self-verify backstop" scenario
// proves that even a gap in the conservative checks themselves could
// never let an incomplete patch through silently.

const ROOTS = ["production_schema_baseline", "users", "onboarding_preferences", "backup_alert_state"];
const USERS = { type: "table", name: "users", sql: "CREATE TABLE `users` (`id` text PRIMARY KEY NOT NULL)" };
const DONORS = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };

function state({ ddlTopology, sourceMigrations, restoreOrder, skipDataTables = [] }) {
  return { ddlTopology, sourceMigrations, restoreOrder, skipDataTables };
}

// ---- tableFieldsFromSql ----

{
  const fields = tableFieldsFromSql(DONORS.sql);
  assert.deepEqual(fields, ["`id` text PRIMARY KEY NOT NULL", "`owner_user_id` text NOT NULL", "FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`)"]);
}
{
  // A comma inside a nested paren (a CHECK clause) must never split a field.
  const sql = "CREATE TABLE `plans` (`id` text PRIMARY KEY NOT NULL, `day` integer, CHECK (`day` IN (1, 2, 3)))";
  const fields = tableFieldsFromSql(sql);
  assert.deepEqual(fields, ["`id` text PRIMARY KEY NOT NULL", "`day` integer", "CHECK (`day` IN (1, 2, 3))"]);
}
{
  assert.equal(tableFieldsFromSql("not a create table statement"), null);
}

// ---- isSubsequence ----

{
  assert.equal(isSubsequence(["a", "b"], ["a", "x", "b", "y"]), true, "fields may be freely inserted anywhere");
  assert.equal(isSubsequence(["a", "b"], ["a"]), false, "a removed field must fail");
  assert.equal(isSubsequence(["a", "b"], ["b", "a"]), false, "reordered fields must fail");
  assert.equal(isSubsequence(["a", "b"], ["a", "b changed"]), false, "a retyped/changed field's old text is gone -- must fail");
  assert.equal(isSubsequence([], ["a", "b"]), true, "no prior fields -- anything is a superset");
}

// ---- scanForDestructiveKeywords ----

{
  assert.equal(scanForDestructiveKeywords({ "0041_add_col.sql": "ALTER TABLE `t` ADD COLUMN `c` integer;" }), null);
  assert.match(scanForDestructiveKeywords({ "0041_x.sql": "ALTER TABLE `t` DROP COLUMN `c`;" }), /DROP\/RENAME/);
  assert.match(scanForDestructiveKeywords({ "0041_x.sql": "ALTER TABLE `t` RENAME COLUMN `c` TO `d`;" }), /DROP\/RENAME/);
  assert.match(scanForDestructiveKeywords({ "0041_x.sql": "DROP TABLE `t`;" }), /DROP\/RENAME/);
  assert.match(scanForDestructiveKeywords({ "0041_x.sql": "drop column `c`" }), /DROP\/RENAME/, "case-insensitive");
}

// ---- planRestoreSyncPatch ----

// 1. Already synchronized -> safe, no-op.
{
  const feature = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, {});
  assert.deepEqual(plan, { safe: true, alreadySynced: true });
}

// 2. Pure additive column on an existing table -> safe.
{
  const DONORS_PLUS_COLUMN = { ...DONORS, sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` text NOT NULL, `archived_at` integer, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS_PLUS_COLUMN], sourceMigrations: ["0000_a.sql", "0001_archive.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_archive.sql": "ALTER TABLE `donors` ADD COLUMN `archived_at` integer;" });
  assert.deepEqual(plan, { safe: true, alreadySynced: false, migrations: ["0001_archive.sql"], newMigrationCount: 2 });
}

// 3. Pure additive index -> safe.
{
  const INDEX = { type: "index", name: "donors_owner_idx", sql: "CREATE INDEX `donors_owner_idx` ON `donors` (`owner_user_id`)" };
  const feature = state({ ddlTopology: [USERS, DONORS, INDEX], sourceMigrations: ["0000_a.sql", "0001_index.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_index.sql": "CREATE INDEX `donors_owner_idx` ON `donors` (`owner_user_id`);" });
  assert.equal(plan.safe, true);
  assert.equal(plan.alreadySynced, false);
}

// 4. A brand-new table -> refused (restore-order placement needs human judgment).
{
  const ASKS = { type: "table", name: "asks", sql: "CREATE TABLE `asks` (`id` text PRIMARY KEY NOT NULL, `donor_id` text NOT NULL, FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS, ASKS], sourceMigrations: ["0000_a.sql", "0001_asks.sql"], restoreOrder: [...ROOTS, "donors", "asks"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_asks.sql": "CREATE TABLE `asks` (...);" });
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /New table\(s\) introduced: asks/);
}

// 5. A table removed from the canonical branch -> refused.
{
  const feature = state({ ddlTopology: [USERS], sourceMigrations: ["0000_a.sql", "0001_remove_donors.sql"], restoreOrder: [...ROOTS] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_remove_donors.sql": "DROP TABLE `donors`;" });
  assert.equal(plan.safe, false);
  // The destructive-keyword scan fires first, which is fine -- either
  // refusal path is correct; both must never produce `safe: true`.
  assert.match(plan.reason, /DROP\/RENAME|removed from the canonical branch/);
}

// 6. A column removed (not just added) on an existing table -> refused,
// even though no DROP/RENAME keyword appears in the migration SQL (e.g.
// a hand-written migration that just omits the column from a rebuilt
// table without using DROP COLUMN syntax).
{
  const DONORS_MISSING_OWNER = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)" };
  const feature = state({ ddlTopology: [USERS, DONORS_MISSING_OWNER], sourceMigrations: ["0000_a.sql", "0001_rebuild.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_rebuild.sql": "CREATE TABLE donors_new (id text); INSERT INTO donors_new SELECT id FROM donors;" });
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /not a pure column\/constraint addition/);
}

// 7. A column retyped (same name, different type) -> refused.
{
  const DONORS_RETYPED = { type: "table", name: "donors", sql: "CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `owner_user_id` integer NOT NULL, FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`))" };
  const feature = state({ ddlTopology: [USERS, DONORS_RETYPED], sourceMigrations: ["0000_a.sql", "0001_retype.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_retype.sql": "-- retype owner_user_id" });
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /not a pure column\/constraint addition/);
}

// 8. main ahead of (or diverged from) the canonical branch -> refused,
// never attempted (this generator only ever handles main being behind).
{
  const feature = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "donors"] });
  const main = state({ ddlTopology: [USERS, DONORS], sourceMigrations: ["0000_a.sql", "0001_not_on_feature.sql"], restoreOrder: [...ROOTS, "donors"] });
  const plan = planRestoreSyncPatch(feature, main, {});
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /never AHEAD of or diverged from it/);
}

// 9. Self-verification backstop: a new FK column is ADDED to an existing
// table (passes the field-subsequence check -- nothing was removed,
// only appended), but main's UNCHANGED restore order no longer
// guarantees the new FK's ordering requirement. The conservative checks
// above have no specific rule for this (restore-order placement is only
// checked for brand-new TABLES, not new FKs on existing ones) -- proving
// the final self-verify step is a genuine backstop, not just a
// restatement of the checks above it.
{
  const PLANS_NO_FK = { type: "table", name: "pledge_payment_plans", sql: "CREATE TABLE `pledge_payment_plans` (`id` text PRIMARY KEY NOT NULL)" };
  const PLANS_WITH_NEW_FK = { type: "table", name: "pledge_payment_plans", sql: "CREATE TABLE `pledge_payment_plans` (`id` text PRIMARY KEY NOT NULL, `donor_id` text, FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`))" };
  // main's restore order has pledge_payment_plans BEFORE donors -- valid
  // today, since main's own ddlTopology has no FK between them yet.
  const main = state({ ddlTopology: [USERS, DONORS, PLANS_NO_FK], sourceMigrations: ["0000_a.sql"], restoreOrder: [...ROOTS, "pledge_payment_plans", "donors"] });
  const feature = state({ ddlTopology: [USERS, DONORS, PLANS_WITH_NEW_FK], sourceMigrations: ["0000_a.sql", "0001_link_plans.sql"], restoreOrder: [...ROOTS, "donors", "pledge_payment_plans"] });
  const plan = planRestoreSyncPatch(feature, main, { "0001_link_plans.sql": "ALTER TABLE `pledge_payment_plans` ADD COLUMN `donor_id` text REFERENCES `donors`(`id`);" });
  assert.equal(plan.safe, false, "the self-verify backstop must catch the resulting FK-order violation even though no earlier check was specifically written for this shape");
  assert.match(plan.reason, /safety backstop/);
  assert.match(plan.reason, /pledge_payment_plans must be restored after donors/);
}

// ---- renderProductionBaselineTsPatch ----

{
  const oldText = [
    "export const PRODUCTION_BASELINE_TABLES = [];",
    "// 39 as of 0038_x.sql",
    "// some more prose here",
    'export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 39;',
    "export const ACCOUNT_CONFIGURATION_TABLES = [];",
  ].join("\n");
  const result = renderProductionBaselineTsPatch(oldText, 41, ["0039_a.sql", "0040_b.sql"], "2026-10-09T00:00:00Z");
  assert.equal(result.ok, true);
  assert.match(result.newText, /PRODUCTION_BASELINE_SOURCE_MIGRATIONS\.length === 41;/);
  assert.doesNotMatch(result.newText, /length === 39/);
  assert.doesNotMatch(result.newText, /some more prose here/, "the old comment block must be fully replaced, not appended to");
  assert.match(result.newText, /^export const PRODUCTION_BASELINE_TABLES = \[\];/, "lines before the comment block must be preserved byte-identical");
  assert.match(result.newText, /export const ACCOUNT_CONFIGURATION_TABLES = \[\];$/, "lines after the assertion must be preserved byte-identical");
}
{
  const result = renderProductionBaselineTsPatch("export const SOMETHING_ELSE = 1;", 41, ["0039_a.sql"], "2026-10-09T00:00:00Z");
  assert.equal(result.ok, false, "a file shape this generator doesn't recognize must refuse, never guess");
}

process.stdout.write("Restore sync generator checks passed.\n");
