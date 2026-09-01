import assert from "node:assert/strict";
import { D1_RESTORE_DATA_ORDER, D1_RESTORE_SKIP_DATA_TABLES, reorderD1ExportForRestore, planD1Restore, parseRestoreStatements } from "../lib/operations/d1-restore-order.ts";
import { STAGING_RESET_TABLE_ORDER } from "../lib/operations/staging-reset.ts";
import { PRODUCTION_BASELINE_TABLES, ACCOUNT_CONFIGURATION_TABLES } from "../lib/data-health/production-baseline.ts";

// D1 restore-order -- structural coverage + dependency-order tests
// (D1 Monthly Restore Verification Repair, 2026-09-01). This proves the
// exact failure class from GitHub Actions run 33515781926 (planD1Restore
// rejecting shared_activities/asks/pledge_payment_plans/
// donor_relationship_facts and their change/audit tables as "not present
// in the dependency order") cannot recur silently: Section 1's coverage
// audit is expressed here as a DERIVED assertion against the real current
// schema (PRODUCTION_BASELINE_TABLES), never a second manually-maintained
// list that could itself drift out of sync the same way
// D1_RESTORE_DATA_ORDER did.

// production_schema_baseline is deliberately excluded from
// PRODUCTION_BASELINE_OBJECTS/PRODUCTION_BASELINE_TABLES (it is the
// schema-verification marker table itself, not part of the application's
// own ddlTopology) but IS a real table that appears in every export and
// IS restored -- see d1-restore-order.ts's own header comment for why it
// is prepended as a root rather than derived from the schema manifest.
const EXPECTED_RESTORE_TABLES = new Set([...PRODUCTION_BASELINE_TABLES, "production_schema_baseline"]);

// ---- Section 6: structural coverage -- "a migration/schema adds a new
// data table but nobody updates restore semantics" must fail this test,
// not silently pass. ----
{
  assert.equal(D1_RESTORE_DATA_ORDER.length, new Set(D1_RESTORE_DATA_ORDER).size, "D1_RESTORE_DATA_ORDER must not list any table twice");
  const orderSet = new Set(D1_RESTORE_DATA_ORDER);
  const missingFromOrder = [...EXPECTED_RESTORE_TABLES].filter((table) => !orderSet.has(table));
  const extraInOrder = [...orderSet].filter((table) => !EXPECTED_RESTORE_TABLES.has(table));
  assert.deepEqual(missingFromOrder, [], `every current schema table must be represented in D1_RESTORE_DATA_ORDER -- missing: ${missingFromOrder.join(", ")}`);
  assert.deepEqual(extraInOrder, [], `D1_RESTORE_DATA_ORDER must never reference a table that no longer exists in the current schema -- extra: ${extraInOrder.join(", ")}`);
}

// ---- The specific 8 tables from the failed run are now covered, plus
// backup_alert_state (Section 8 -- present in the export once it ever
// gets a real row, so it must be handled even though the specific failed
// run's export had none yet). ----
{
  const orderSet = new Set(D1_RESTORE_DATA_ORDER);
  for (const table of ["shared_activity_recipient_audits", "shared_activities", "asks", "ask_changes", "pledge_payment_plans", "pledge_payment_plan_changes", "donor_relationship_facts", "donor_relationship_fact_changes", "backup_alert_state"]) {
    assert.ok(orderSet.has(table), `${table} must be present in D1_RESTORE_DATA_ORDER`);
  }
}

// ---- backup_alert_state is a root-like table (only depends on users),
// classified as an ACCOUNT_CONFIGURATION_TABLE, not part of
// STAGING_RESET_TABLE_ORDER's fundraising-data reversal -- confirm it is
// positioned after "users" specifically (its own real FK target). ----
{
  assert.ok(ACCOUNT_CONFIGURATION_TABLES.includes("backup_alert_state"), "backup_alert_state must be classified as account/operational configuration, not fundraising data");
  assert.ok(!STAGING_RESET_TABLE_ORDER.includes("backup_alert_state"), "backup_alert_state must not appear in STAGING_RESET_TABLE_ORDER (it is preserved across a staging reset, like users/onboarding_preferences)");
  const usersIndex = D1_RESTORE_DATA_ORDER.indexOf("users");
  const backupAlertIndex = D1_RESTORE_DATA_ORDER.indexOf("backup_alert_state");
  assert.ok(usersIndex >= 0 && backupAlertIndex > usersIndex, "backup_alert_state must be inserted after users (its own real foreign key target)");
}

// Minimal, deliberately-scrambled `wrangler d1 export`-shaped fixture
// builder -- only what the parser's regexes need (a PRAGMA preamble, one
// CREATE TABLE per referenced table, and one single-row INSERT per row),
// never a full SQL dump.
function buildExport(tables, insertsInOrder) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of tables) lines.push(`CREATE TABLE "${table}" (id text);`);
  for (const [table, id] of insertsInOrder) lines.push(`INSERT INTO "${table}" (id) VALUES('${id}');`);
  return lines.join("\n") + "\n";
}

function insertOrderInOutput(sqlText, ...tables) {
  const parsed = parseRestoreStatements(sqlText);
  return tables.map((table) => sqlText.indexOf([...parsed.insertsByTable.get(table)][0]));
}

// ---- Section 7: dependency-order tests, deliberately wrong source order
// -> safe canonical order. reorderD1ExportForRestore is used here (pure,
// synchronous, and directly demonstrates final statement order); planD1Restore
// is exercised separately below to prove its own step ordering agrees. ----

// shared_activities + shared_activity_recipient_audits (also exercises
// donors, since the audit row's donor_id is a real FK too).
{
  const exported = buildExport(
    ["users", "donors", "shared_activities", "shared_activity_recipient_audits"],
    [["shared_activity_recipient_audits", "audit-1"], ["shared_activities", "activity-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const restored = reorderD1ExportForRestore(exported);
  const [usersAt, donorsAt, activityAt, auditAt] = insertOrderInOutput(restored, "users", "donors", "shared_activities", "shared_activity_recipient_audits");
  assert.ok(usersAt < activityAt, "users must be restored before shared_activities (shared_activities.user_id references users.id)");
  assert.ok(activityAt < auditAt, "shared_activities must be restored before shared_activity_recipient_audits (its shared_activity_id references shared_activities.id)");
  assert.ok(donorsAt < auditAt, "donors must be restored before shared_activity_recipient_audits (its donor_id references donors.id)");
}

// asks + ask_changes (also exercises interactions, since asks.source_interaction_id is a real, if nullable, FK).
{
  const exported = buildExport(
    ["users", "donors", "interactions", "asks", "ask_changes"],
    [["ask_changes", "change-1"], ["asks", "ask-1"], ["interactions", "interaction-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const restored = reorderD1ExportForRestore(exported);
  const [usersAt, donorsAt, interactionsAt, asksAt, changesAt] = insertOrderInOutput(restored, "users", "donors", "interactions", "asks", "ask_changes");
  assert.ok(usersAt < asksAt && donorsAt < asksAt, "users and donors must both precede asks (asks.user_id / asks.donor_id)");
  assert.ok(interactionsAt < asksAt, "interactions must precede asks (asks.source_interaction_id references interactions.id)");
  assert.ok(asksAt < changesAt, "asks must precede ask_changes (ask_changes.ask_id references asks.id)");
}

// pledge_payment_plans + pledge_payment_plan_changes (also exercises
// giving_activities, since pledge_payment_plans.pledge_activity_id is a
// real, non-nullable FK to it).
{
  const exported = buildExport(
    ["users", "donors", "giving_activities", "pledge_payment_plans", "pledge_payment_plan_changes"],
    [["pledge_payment_plan_changes", "change-1"], ["pledge_payment_plans", "plan-1"], ["giving_activities", "activity-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const restored = reorderD1ExportForRestore(exported);
  const [usersAt, donorsAt, givingAt, plansAt, changesAt] = insertOrderInOutput(restored, "users", "donors", "giving_activities", "pledge_payment_plans", "pledge_payment_plan_changes");
  assert.ok(usersAt < plansAt && donorsAt < plansAt, "users and donors must both precede pledge_payment_plans");
  assert.ok(givingAt < plansAt, "giving_activities must precede pledge_payment_plans (pledge_activity_id references giving_activities.id)");
  assert.ok(plansAt < changesAt, "pledge_payment_plans must precede pledge_payment_plan_changes (plan_id references pledge_payment_plans.id)");
}

// donor_relationship_facts + donor_relationship_fact_changes (also
// exercises interactions, since source_interaction_id is a real, if
// nullable, FK).
{
  const exported = buildExport(
    ["users", "donors", "interactions", "donor_relationship_facts", "donor_relationship_fact_changes"],
    [["donor_relationship_fact_changes", "change-1"], ["donor_relationship_facts", "fact-1"], ["interactions", "interaction-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const restored = reorderD1ExportForRestore(exported);
  const [usersAt, donorsAt, interactionsAt, factsAt, changesAt] = insertOrderInOutput(restored, "users", "donors", "interactions", "donor_relationship_facts", "donor_relationship_fact_changes");
  assert.ok(usersAt < factsAt && donorsAt < factsAt, "users and donors must both precede donor_relationship_facts");
  assert.ok(interactionsAt < factsAt, "interactions must precede donor_relationship_facts (source_interaction_id references interactions.id)");
  assert.ok(factsAt < changesAt, "donor_relationship_facts must precede donor_relationship_fact_changes (fact_id references donor_relationship_facts.id)");
}

// backup_alert_state -- only depends on users.
{
  const exported = buildExport(["users", "backup_alert_state"], [["backup_alert_state", "user-1"], ["users", "user-1"]]);
  const restored = reorderD1ExportForRestore(exported);
  const [usersAt, alertAt] = insertOrderInOutput(restored, "users", "backup_alert_state");
  assert.ok(usersAt < alertAt, "users must precede backup_alert_state (backup_alert_state.user_id references users.id)");
}

// interactions must precede shared_activities' own dependent, and
// shared_activities itself must precede interactions (interactions.
// shared_activity_id references shared_activities.id) -- the one
// cross-cluster ordering constraint spanning two of the newly-added
// tables' own neighborhoods, verified explicitly since it is easy to get
// backwards.
{
  const exported = buildExport(
    ["users", "donors", "shared_activities", "interactions"],
    [["interactions", "interaction-1"], ["shared_activities", "activity-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const restored = reorderD1ExportForRestore(exported);
  const [activityAt, interactionsAt] = insertOrderInOutput(restored, "shared_activities", "interactions");
  assert.ok(activityAt < interactionsAt, "shared_activities must precede interactions (interactions.shared_activity_id references shared_activities.id)");
}

// ---- planD1Restore's own step ordering must agree with
// reorderD1ExportForRestore's statement ordering (same underlying order,
// different output shape). ----
{
  const exported = buildExport(
    ["users", "donors", "asks", "ask_changes"],
    [["ask_changes", "change-1"], ["asks", "ask-1"], ["donors", "donor-1"], ["users", "user-1"]],
  );
  const plan = planD1Restore(exported);
  const tablesInStepOrder = plan.steps.map((step) => step.table);
  const usersStepIndex = tablesInStepOrder.indexOf("users");
  const asksStepIndex = tablesInStepOrder.indexOf("asks");
  const changesStepIndex = tablesInStepOrder.indexOf("ask_changes");
  assert.ok(usersStepIndex < asksStepIndex, "planD1Restore's steps must restore users before asks");
  assert.ok(asksStepIndex < changesStepIndex, "planD1Restore's steps must restore asks before ask_changes");
}

// ---- A truly unknown table must still throw -- the guardrail from
// GitHub Actions run 33515781926 must remain intact, not be weakened or
// bypassed as part of this fix. ----
{
  const exported = buildExport(["users", "totally_unknown_table"], [["totally_unknown_table", "row-1"], ["users", "user-1"]]);
  assert.throws(() => reorderD1ExportForRestore(exported), /not present in the dependency order.*totally_unknown_table/s, "an export with an INSERT for a table outside D1_RESTORE_DATA_ORDER must still throw");
  assert.throws(() => planD1Restore(exported), /not present in the dependency order.*totally_unknown_table/s, "planD1Restore must apply the identical guardrail");
}

// ---- D1_RESTORE_SKIP_DATA_TABLES tables are still present in the order
// (their SCHEMA is restored in position) but never throw as "unknown"
// even though this fixture gives them real INSERT rows -- proving the
// skip list and the unknown-table guardrail are two independent,
// correctly-composed mechanisms, not the same one. ----
{
  for (const table of D1_RESTORE_SKIP_DATA_TABLES) assert.ok(D1_RESTORE_DATA_ORDER.includes(table), `${table} (in D1_RESTORE_SKIP_DATA_TABLES) must still be listed in D1_RESTORE_DATA_ORDER -- schema restoration for it is not skipped, only data`);
  const [firstSkip] = D1_RESTORE_SKIP_DATA_TABLES;
  const exported = buildExport(["users", firstSkip], [[firstSkip, "row-1"], ["users", "user-1"]]);
  const plan = planD1Restore(exported);
  assert.deepEqual(plan.skippedTables, [firstSkip]);
  assert.ok(!plan.steps.some((step) => step.table === firstSkip), `${firstSkip}'s data must not appear in any restore step`);
}

process.stdout.write("D1 restore-order checks passed.\n");
