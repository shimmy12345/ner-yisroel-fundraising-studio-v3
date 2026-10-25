import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { generateBaseline, schemaTopology } from "../scripts/generate-production-baseline.mjs";
import { ACCOUNT_CONFIGURATION_COUNT_SQL, ACCOUNT_CONFIGURATION_TABLES, BUSINESS_DATA_COUNT_SQL, FUNDRAISING_DATA_COUNT_SQL, FUNDRAISING_DATA_TABLES, PRODUCTION_BASELINE_HASH, PRODUCTION_BASELINE_LEVEL, PRODUCTION_BASELINE_SOURCE_MIGRATIONS, PRODUCTION_BASELINE_VERIFIED, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";
import { ACTIVE_DONORS_SQL, DUPLICATE_GIVING_FINGERPRINTS_SQL, DUPLICATE_JL_CODES_SQL, GIVING_RECONCILIATION_SQL, ORPHANED_GIFTS_SQL, ORPHANED_INTERACTIONS_SQL, ORPHANED_PAYMENTS_SQL, ORPHANED_REMINDERS_SQL } from "../lib/data-health/queries.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
// Checkout line-ending normalization (e.g. core.autocrlf) can turn the
// committed LF-only baseline into CRLF on disk without changing its
// contents; normalize only for this comparison, never the files themselves.
const normalizeLineEndings = (text) => text.replace(/\r\n/g, "\n");
const baseline = read("production-baseline/drizzle/0000_production_baseline_0019.sql");
const manifest = JSON.parse(read("production-baseline/schema-manifest.json"));

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(baseline);
  return database;
}

test("authoritative 0019 baseline is reproducible, empty, and replay-safe", () => {
  const generated = generateBaseline();
  assert.equal(normalizeLineEndings(baseline), normalizeLineEndings(generated.baseline));
  assert.deepEqual(manifest, generated.manifest);
  const database = freshDatabase();
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("SELECT schema_hash FROM production_schema_baseline WHERE id='0019'").get().schema_hash, manifest.schemaHash);
  assert.deepEqual(schemaTopology(database), manifest.topology);
  for (const table of manifest.topology.tables) assert.equal(database.prepare(`SELECT COUNT(*) count FROM "${table.name}"`).get().count, 0);
  assert.throws(() => database.exec(baseline), /already exists/);
});

test("fresh workspace integrity checks find no duplicates, orphans, broken links, or inconsistent totals", () => {
  const database = freshDatabase();
  const owner = "fictional-production-owner";
  assert.equal(database.prepare(ACTIVE_DONORS_SQL).get(owner).count, 0);
  assert.equal(database.prepare(DUPLICATE_JL_CODES_SQL).get(owner).count, 0);
  assert.equal(database.prepare(ORPHANED_GIFTS_SQL).get(owner).count, 0);
  assert.equal(database.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 0);
  assert.equal(database.prepare(ORPHANED_REMINDERS_SQL).get(owner, owner).count, 0);
  assert.equal(database.prepare(ORPHANED_PAYMENTS_SQL).get(owner, owner, owner).count, 0);
  assert.equal(database.prepare(DUPLICATE_GIVING_FINGERPRINTS_SQL).get(owner).count, 0);
  const totals = database.prepare(GIVING_RECONCILIATION_SQL).get(owner, owner);
  assert.deepEqual([totals.source_total_cents, totals.linked_total_cents, totals.invalid_rows], [0, 0, 0]);
});

test("schema comparison detects missing, unexpected, and changed constraints or indexes", () => {
  const canonical = manifest.ddlTopology;
  assert.equal(compareSchemaObjects(canonical).matches, true);
  assert.match(compareSchemaObjects(canonical.filter((object) => object.name !== "users")).differences.join(" "), /Missing table: users/);
  assert.match(compareSchemaObjects([...canonical, { type: "table", name: "unexpected", sql: "CREATE TABLE unexpected (id text)" }]).differences.join(" "), /Unexpected table: unexpected/);
  const changed = canonical.map((object) => object.name === "giving_activities" ? { ...object, sql: object.sql.replace("CHECK", "CHECK (1) /* changed */ CHECK") } : object);
  assert.match(compareSchemaObjects(changed).differences.join(" "), /Table definition differs: giving_activities/);
});

test("schema comparison excludes only known platform-managed tables", () => {
  const liveRows = [
    ...manifest.ddlTopology.map((object) => ({ ...object, tbl_name: object.type === "table" ? object.name : "ignored" })),
    { type: "table", name: "__appgarden_migrations", tbl_name: "__appgarden_migrations", sql: "CREATE TABLE __appgarden_migrations (id text)" },
    { type: "table", name: "_cf_KV", tbl_name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key text)" },
    { type: "table", name: "_cf_METADATA", tbl_name: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA (key text)" },
  ];
  assert.equal(compareSchemaObjects(stagingSchemaObjects(liveRows)).matches, true);
  liveRows.push({ type: "table", name: "unrecognized_runtime_table", tbl_name: "unrecognized_runtime_table", sql: "CREATE TABLE unrecognized_runtime_table (id text)" });
  assert.match(compareSchemaObjects(stagingSchemaObjects(liveRows)).differences.join(" "), /Unexpected table: unrecognized_runtime_table/);
});

test("production baseline is isolated from staging and future drift fails closed", () => {
  const migrationFiles = fs.readdirSync(path.join(root, "drizzle")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.deepEqual(manifest.sourceMigrations, migrationFiles, "a new legacy migration requires regenerating and rehearsing the baseline");
  assert.equal(JSON.parse(read("drizzle/meta/_journal.json")).entries.length, 14, "legacy staging history remains untouched and unverified");
  assert.match(read("build/sites-vite-plugin.ts"), /FUNDRAISING_OS_SCHEMA_TRACK === "production-baseline"/);
  assert.doesNotMatch(read(".openai/hosting.json"), /production-baseline/, "staging keeps the legacy migration track by default");
  const stagingHosting = JSON.parse(read(".openai/hosting.json"));
  const productionHosting = JSON.parse(read(".openai/hosting.production.json"));
  assert.notEqual(productionHosting.project_id, stagingHosting.project_id);
  assert.equal(productionHosting.d1, "DB");
  assert.match(read("build/sites-vite-plugin.ts"), /Production packaging requires a distinct production project ID/);
  assert.match(read("app/api/health/route.ts"), /userIdForEmail/);
  assert.doesNotMatch(read("app/api/health/route.ts"), /ensureUserProfile/);
  const liveRows = manifest.ddlTopology.map((object) => ({ ...object, tbl_name: object.type === "table" ? object.name : "ignored" }));
  assert.equal(compareSchemaObjects(stagingSchemaObjects(liveRows)).matches, true);
});

test("fundraising-data count excludes account/configuration tables while the backup-safety gate stays untouched", () => {
  assert.deepEqual(ACCOUNT_CONFIGURATION_TABLES, ["users", "onboarding_preferences", "backup_alert_state", "agenda_send_log", "agenda_manual_test_send_log"]);
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("users"), "users must never count toward fundraising data");
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("onboarding_preferences"), "onboarding_preferences must never count toward fundraising data");
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("backup_alert_state"), "backup_alert_state (backup-alert dedupe state) must never count toward fundraising data");
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("agenda_send_log"), "agenda_send_log (Daily Agenda send dedupe state) must never count toward fundraising data");
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("agenda_manual_test_send_log"), "agenda_manual_test_send_log (temporary Gmail OAuth verification claim state) must never count toward fundraising data");
  assert.ok(FUNDRAISING_DATA_TABLES.includes("donors"));
  assert.ok(FUNDRAISING_DATA_TABLES.includes("gifts"));
  assert.match(BUSINESS_DATA_COUNT_SQL, /"users"/, "the pre-existing backup-safety gate SQL is unchanged and still counts users");

  const database = freshDatabase();
  const now = Math.floor(Date.now() / 1000);
  const count = (sql) => database.prepare(sql).get().count;

  assert.equal(count(FUNDRAISING_DATA_COUNT_SQL), 0, "a fresh baseline has no fundraising data");
  assert.equal(count(ACCOUNT_CONFIGURATION_COUNT_SQL), 0, "a fresh baseline has no owner configured yet");

  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('owner-1', 'sgoldstein@nirc.edu', ${now}, ${now})`);
  assert.equal(count(FUNDRAISING_DATA_COUNT_SQL), 0, "the owner's own account row must never register as fundraising data");
  assert.equal(count(ACCOUNT_CONFIGURATION_COUNT_SQL), 1, "the owner's account is tracked separately");
  assert.equal(count(BUSINESS_DATA_COUNT_SQL), 1, "the untouched backup-safety gate still counts the account row");

  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('donor-1', 'Fictional Donor', ${now}, ${now})`);
  assert.equal(count(FUNDRAISING_DATA_COUNT_SQL), 1, "adding a fictional donor must change fundraising data to non-empty");
  assert.equal(count(ACCOUNT_CONFIGURATION_COUNT_SQL), 1, "adding a donor must not change the account count");
  database.close();
});

test("baseline verification invariant accounts for the data-only 0020 migration", () => {
  // 0020_financial_date_only.sql only UPDATEs existing rows (no CREATE/ALTER
  // TABLE), so replaying it against the empty baseline database must leave
  // the schema level and hash exactly as they were at 0019 — only the
  // source-migration count grows.
  assert.ok(manifest.sourceMigrations.includes("0020_financial_date_only.sql"));
  assert.equal(PRODUCTION_BASELINE_LEVEL, "0019", "a data-only migration must not bump the schema level");
});

test("baseline picks up the schema-changing 0021 and 0022 migrations", () => {
  // 0021_import_preview_sessions.sql adds two new tables and
  // 0022_import_review_drafts.sql adds columns to one of them, so — unlike
  // 0020 — the schema hash must change; the level label stays "0019"
  // regardless, since it identifies the bootstrap file's historical origin,
  // not its current contents.
  assert.ok(manifest.sourceMigrations.includes("0021_import_preview_sessions.sql"));
  assert.ok(manifest.sourceMigrations.includes("0022_import_review_drafts.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0023 donor research migration", () => {
  // 0023_donor_research_stage_a.sql adds six new tables (Donor Research
  // Stage A), so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0023_donor_research_stage_a.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0024 donor historical context migration", () => {
  // 0024_donor_historical_context.sql adds the donor_historical_context
  // table, so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0024_donor_historical_context.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0025 date-only precision migration", () => {
  // 0025_date_only_precision.sql adds occurred_at_date_only/due_at_date_only
  // columns, so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0025_date_only_precision.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0026 gift acknowledgments migration", () => {
  // 0026_gift_acknowledgments.sql adds the gift_acknowledgments table, so
  // the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0026_gift_acknowledgments.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0027 yahrtzeits migration", () => {
  // 0027_yahrtzeits.sql adds the yahrtzeits/yahrtzeit_changes tables, so
  // the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0027_yahrtzeits.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0028 important dates migration", () => {
  // 0028_important_dates.sql adds the important_dates/important_date_changes
  // tables (Birthday/Anniversary), so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0028_important_dates.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0029 date of birth import migration", () => {
  // 0029_important_dates_dob_source.sql widens important_dates.source's
  // CHECK constraint to accept 'import-dob' alongside 'manual' (a table
  // rebuild, not a new table), so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0029_important_dates_dob_source.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0030 shared activities migration", () => {
  // 0030_shared_activities.sql adds the shared_activities/
  // shared_activity_recipient_audits tables and interactions.shared_activity_id/
  // role columns, so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0030_shared_activities.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0031 text message type migration", () => {
  // 0031_interactions_text_type.sql widens shared_activities.type's CHECK
  // constraint to accept 'text' (a table rebuild, not a new table) --
  // interactions.type has no CHECK constraint at all, so it needed no DDL
  // change here, only its own TypeScript enum in db/schema.ts. The schema
  // hash must change again because of the shared_activities rebuild.
  assert.ok(manifest.sourceMigrations.includes("0031_interactions_text_type.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0032 asks migration", () => {
  // 0032_asks.sql adds the asks/ask_changes tables (new tables, not a
  // rebuild), so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0032_asks.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0033 pledge payment plans migration", () => {
  // 0033_pledge_payment_plans.sql adds the pledge_payment_plans/
  // pledge_payment_plan_changes tables (new tables, not a rebuild), so the
  // schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0033_pledge_payment_plans.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0034 donor relationship facts migration", () => {
  // 0034_donor_relationship_facts.sql adds the donor_relationship_facts/
  // donor_relationship_fact_changes tables (Relationship Intelligence
  // Phase 1, new tables, not a rebuild), so the schema hash must change
  // again.
  assert.ok(manifest.sourceMigrations.includes("0034_donor_relationship_facts.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0035 backup alert state migration", () => {
  // 0035_backup_alert_state.sql adds the backup_alert_state table (Backup
  // Scheduling Reliability Stage 3, a new table, not a rebuild), so the
  // schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0035_backup_alert_state.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0036 donor source attributions migration", () => {
  // 0036_donor_source_attributions.sql adds the donor_source_attributions
  // table (Giving Import Third-Party Source Attribution, a new table, not
  // a rebuild) plus two nullable columns on jl_payment_assignment_audits,
  // so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0036_donor_source_attributions.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0037 donor rebbeim migration", () => {
  // 0037_donor_rebbeim.sql adds the rebbeim/donor_rebbeim tables (Donor
  // Rebbeim, two new tables, not a rebuild), so the schema hash must
  // change again.
  assert.ok(manifest.sourceMigrations.includes("0037_donor_rebbeim.sql"));
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});

test("baseline picks up the schema-changing 0038 pledge payment-plan reviews migration", () => {
  // 0038_pledge_payment_plan_reviews.sql adds the pledge payment-plan
  // cleanup review table (one new table, not a rebuild), so the schema
  // hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0038_pledge_payment_plan_reviews.sql"));
});

test("baseline picks up the schema-changing 0039 original pledge date migration", () => {
  // 0039_pledge_payment_plans_original_pledge_date.sql adds one nullable
  // column (original_pledge_date) to the existing pledge_payment_plans
  // table (Annual Renewal Reminders, Part 1; see docs/AI-HANDOFF.md) --
  // an additive column, not a rebuild, so the schema hash must change
  // again.
  assert.ok(manifest.sourceMigrations.includes("0039_pledge_payment_plans_original_pledge_date.sql"));
  const planTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "pledge_payment_plans");
  assert.match(planTable.sql, /original_pledge_date/);
});

test("baseline picks up the schema-changing 0040 commitment duration months migration", () => {
  // 0040_pledge_payment_plans_commitment_duration_months.sql adds one
  // nullable column (commitment_duration_months) to the existing
  // pledge_payment_plans table (Pledge Renewal Reminders,
  // commitment-duration correction; see docs/AI-HANDOFF.md) -- an
  // additive column, not a rebuild, so the schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0040_pledge_payment_plans_commitment_duration_months.sql"));
  const planTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "pledge_payment_plans");
  assert.match(planTable.sql, /commitment_duration_months/);
});

test("baseline picks up the schema-changing 0041 renewal acknowledged at migration", () => {
  // 0041_pledge_payment_plans_renewal_acknowledged_at.sql adds one
  // nullable column (renewal_acknowledged_at) to the existing
  // pledge_payment_plans table (Mark Renewal Addressed; see
  // docs/AI-HANDOFF.md) -- an additive column, not a rebuild, so the
  // schema hash must change again.
  assert.ok(manifest.sourceMigrations.includes("0041_pledge_payment_plans_renewal_acknowledged_at.sql"));
  const planTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "pledge_payment_plans");
  assert.match(planTable.sql, /renewal_acknowledged_at/);
});

test("baseline picks up the schema-adding 0042 pledge balance corrections migration", () => {
  // 0042_pledge_balance_corrections.sql adds one new table
  // (pledge_balance_corrections, Manual Pledge Balance Corrections; see
  // docs/AI-HANDOFF.md) -- including its partial unique index enforcing
  // at most one active correction per pledge -- so the schema hash must
  // change again.
  assert.ok(manifest.sourceMigrations.includes("0042_pledge_balance_corrections.sql"));
  const correctionsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "pledge_balance_corrections");
  assert.ok(correctionsTable, "pledge_balance_corrections must be a real table in the baseline topology");
  assert.match(correctionsTable.sql, /corrected_balance_cents/);
  assert.match(correctionsTable.sql, /imported_balance_cents_at_correction/);
  const activeIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "pledge_balance_corrections_active_uidx");
  assert.ok(activeIndex, "the partial unique index enforcing at most one active correction per pledge must be captured in the baseline");
});

test("baseline picks up the schema-adding 0043 agenda send log migration", () => {
  // 0043_agenda_send_log.sql adds one new table (agenda_send_log, Daily
  // Fundraising Agenda send idempotency; see docs/AI-HANDOFF.md's
  // "October 14 Email Incident" entry) -- so the schema hash must change
  // again.
  assert.ok(manifest.sourceMigrations.includes("0043_agenda_send_log.sql"));
  const sendLogTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "agenda_send_log");
  assert.ok(sendLogTable, "agenda_send_log must be a real table in the baseline topology");
  assert.match(sendLogTable.sql, /send_date/);
  assert.match(sendLogTable.sql, /claimed_at/);
});

test("baseline picks up the schema-adding 0044 agenda manual test send log migration", () => {
  // 0044_agenda_manual_test_send_log.sql adds one new table
  // (agenda_manual_test_send_log, the temporary Production Gmail OAuth
  // verification mechanism's one-time claim record; see
  // docs/AI-HANDOFF.md's "October 14 Email Incident" entry) -- so the
  // schema hash must change again. No longer the LAST migration (0045
  // follows it below), so this only asserts inclusion, matching every
  // earlier migration's own test in this file.
  assert.ok(manifest.sourceMigrations.includes("0044_agenda_manual_test_send_log.sql"));
  const testSendLogTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "agenda_manual_test_send_log");
  assert.ok(testSendLogTable, "agenda_manual_test_send_log must be a real table in the baseline topology");
  assert.match(testSendLogTable.sql, /claimed_at/);
  assert.match(testSendLogTable.sql, /outcome/);
});

test("baseline picks up the schema-adding 0045 trips migration", () => {
  // 0045_trips.sql adds two new tables (trips, trip_prospects --
  // Trip-Based Meeting Planning, see docs/AI-HANDOFF.md). It is no longer
  // the LATEST migration (see the 0046 test below, added 2026-10-16) --
  // this test keeps proving its own tables/index are still correctly
  // captured in the baseline topology, regardless of what migration is
  // added after it.
  const tripsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trips");
  assert.ok(tripsTable, "trips must be a real table in the baseline topology");
  assert.match(tripsTable.sql, /destination_region_id/);
  assert.match(tripsTable.sql, /destination_region_label/);
  const prospectsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_prospects");
  assert.ok(prospectsTable, "trip_prospects must be a real table in the baseline topology");
  assert.match(prospectsTable.sql, /suggested_reason/);
  assert.match(prospectsTable.sql, /linked_interaction_id/);
  const uniqueIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "trip_prospects_trip_donor_idx");
  assert.ok(uniqueIndex, "the UNIQUE(trip_id, donor_id) index enforcing one prospect row per donor per trip must be captured in the baseline");
  assert.match(uniqueIndex.sql, /UNIQUE/i);
});

test("baseline picks up the schema-adding 0046 trip financial attributions migration", () => {
  // 0046_trip_financial_attributions.sql adds one new table (Trip
  // Fundraising Results Dashboard, see docs/AI-HANDOFF.md). No longer the
  // LATEST migration (see the 0047 test below, added 2026-10-18) -- this
  // test keeps proving its own table/index are still correctly captured
  // in the baseline topology, matching the 0044/0045 tests' own "no
  // longer latest" convention above.
  assert.ok(manifest.sourceMigrations.includes("0046_trip_financial_attributions.sql"));
  const attributionsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_financial_attributions");
  assert.ok(attributionsTable, "trip_financial_attributions must be a real table in the baseline topology");
  assert.match(attributionsTable.sql, /giving_activity_id/);
  assert.match(attributionsTable.sql, /removed_at/);
  const uniqueIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "trip_financial_attributions_active_giving_activity_uidx");
  assert.ok(uniqueIndex, "the partial UNIQUE(giving_activity_id) WHERE removed_at IS NULL index -- the real double-counting guard -- must be captured in the baseline");
  assert.match(uniqueIndex.sql, /UNIQUE/i);
  assert.match(uniqueIndex.sql, /WHERE/i);
});

test("baseline picks up the schema-adding 0047 trip prospect selection migration", () => {
  // 0047_trip_prospect_selection.sql adds one new column
  // (trip_prospects.selected_at) and its supporting index -- Trip
  // Planning's Deliberate Prospect Selection round, see
  // docs/AI-HANDOFF.md. No longer the latest migration (0048 is, see the
  // test below) -- same "included, not necessarily last" convention as
  // 0046's own test above, which this test previously violated by
  // asserting `.at(-1)` instead.
  assert.ok(manifest.sourceMigrations.includes("0047_trip_prospect_selection.sql"));
  const prospectsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_prospects");
  assert.ok(prospectsTable, "trip_prospects must still be a real table in the baseline topology");
  assert.match(prospectsTable.sql, /selected_at/);
  const selectedIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "trip_prospects_trip_selected_idx");
  assert.ok(selectedIndex, "the (trip_id, selected_at) index must be captured in the baseline");
});

test("baseline picks up the schema-adding 0048 Google Calendar sync migration", () => {
  // 0048_google_calendar_sync.sql adds two new tables
  // (calendar_event_links, calendar_event_link_history), four new
  // nullable columns (interactions.all_day/all_day_date/end_at/location,
  // mirrored on trip_prospects), and one new boolean
  // (users.calendar_sync_enabled) -- see
  // docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md and docs/AI-HANDOFF.md.
  // No longer the latest migration (0050 is, see the test below -- 0049
  // is deliberately skipped, see that test's own comment) -- same
  // "included, not necessarily last" convention as 0047's own test above.
  // NOT applied to any remote database (Staging or Production) as of
  // this round -- this baseline/manifest update is still correct to make
  // now: it tracks the canonical branch's own intended schema, not yet
  // what any environment currently runs.
  assert.ok(manifest.sourceMigrations.includes("0048_google_calendar_sync.sql"));
  const linksTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "calendar_event_links");
  assert.ok(linksTable, "calendar_event_links must be a real table in the baseline topology");
  assert.match(linksTable.sql, /desired_state/);
  assert.match(linksTable.sql, /lease_owner/);
  const historyTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "calendar_event_link_history");
  assert.ok(historyTable, "calendar_event_link_history must be a real table in the baseline topology");
  const uniqueIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "calendar_event_links_interaction_uidx");
  assert.ok(uniqueIndex, "the UNIQUE(interaction_id) duplicate-prevention backstop must be captured in the baseline");
  assert.match(uniqueIndex.sql, /UNIQUE/i);
  const interactionsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "interactions");
  assert.match(interactionsTable.sql, /all_day_date/, "interactions.all_day_date must be captured in the baseline");
});

test("baseline picks up the schema-adding 0050 donor-confirmation correction migration", () => {
  // 0050_trip_attribution_confirmation.sql adds four new, nullable (or
  // safely-defaulted) columns to the EXISTING trip_financial_attributions
  // table -- donor_confirmed_at, commitment_kind, reported_cash_collected_cents,
  // reconciled_pending_attribution_id (see docs/AI-HANDOFF.md's
  // donor-confirmation correction entry). No longer the latest migration
  // (0054 is, see the tests below) -- same "included, not necessarily
  // last" convention as 0048's own test above.
  //
  // "0049" is deliberately skipped: drizzle/pending-review/0049_fix_
  // calendar_schema_text_staging_repair.sql already reserves that number
  // for a separate, unrelated, not-yet-reviewed draft kept OUTSIDE
  // drizzle/ for exactly this reason (it is never picked up by this
  // manifest at all -- confirmed by the exact migration count in 0051's
  // own test below).
  //
  // NOT applied to Production as of this round -- applied to
  // fundraising-os-staging-db (2026-10-21, see docs/AI-HANDOFF.md).
  assert.ok(manifest.sourceMigrations.includes("0050_trip_attribution_confirmation.sql"));
  const attributionsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_financial_attributions");
  assert.ok(attributionsTable, "trip_financial_attributions must still be a real table in the baseline topology");
  assert.match(attributionsTable.sql, /donor_confirmed_at/);
  assert.match(attributionsTable.sql, /commitment_kind/);
  assert.match(attributionsTable.sql, /reported_cash_collected_cents/);
  assert.match(attributionsTable.sql, /reconciled_pending_attribution_id/);
});

test("baseline picks up the schema-adding 0051 reconciliation concurrency guard migration", () => {
  // 0051_trip_reconciliation_concurrency_guard.sql adds one new partial
  // UNIQUE index to the EXISTING trip_financial_attributions table --
  // trip_financial_attributions_active_reconciled_pending_uidx (see
  // docs/AI-HANDOFF.md's reconciliation-concurrency-fix entry). No
  // longer the latest migration (0054 is, see the tests below).
  //
  // NOT applied to Production as of this round -- applied to
  // fundraising-os-staging-db (2026-10-21, see docs/AI-HANDOFF.md).
  assert.ok(manifest.sourceMigrations.includes("0051_trip_reconciliation_concurrency_guard.sql"));
  const guardIndex = manifest.ddlTopology.find((object) => object.type === "index" && object.name === "trip_financial_attributions_active_reconciled_pending_uidx");
  assert.ok(guardIndex, "the reconciliation-concurrency-guard index must be captured in the baseline");
  assert.match(guardIndex.sql, /UNIQUE/i);
  assert.match(guardIndex.sql, /removed_at.*IS NULL/is);
});

test("baseline picks up the schema-adding 0052 interaction write-proof-token migration", () => {
  // 0052_interaction_write_proof_token.sql adds one new nullable column
  // to the EXISTING interactions table -- write_token. Never previously
  // covered by its own test here: this manifest was stuck at migration
  // 0051 (never regenerated) from before this migration was added until
  // this round's own regeneration (see docs/AI-HANDOFF.md's Multi-Region
  // Prospect Selection + Manually Added Prospects entry) picked it up
  // for the first time, alongside 0053 and this round's own 0054.
  assert.ok(manifest.sourceMigrations.includes("0052_interaction_write_proof_token.sql"));
  const interactionsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "interactions");
  assert.ok(interactionsTable, "interactions must still be a real table in the baseline topology");
  assert.match(interactionsTable.sql, /write_token/);
});

test("baseline picks up the schema-adding 0053 meeting-note save-identity migration", () => {
  // 0053_meeting_note_save_identity.sql adds one new table --
  // meeting_note_save_identities, a save-idempotency ledger referencing
  // interactions.id. Same "never previously covered" note as 0052's own
  // test above.
  assert.ok(manifest.sourceMigrations.includes("0053_meeting_note_save_identity.sql"));
  const saveIdentitiesTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "meeting_note_save_identities");
  assert.ok(saveIdentitiesTable, "meeting_note_save_identities must be a real table in the baseline topology");
  assert.match(saveIdentitiesTable.sql, /interaction_id/);
});

test("baseline picks up the schema-adding 0054 trip manual prospects migration", () => {
  // 0054_trip_manual_prospects.sql (Multi-Region Prospect Selection +
  // Manually Added Prospects, 2026-10-25, see docs/AI-HANDOFF.md)
  // rebuilds trip_prospects with donor_id now nullable plus six new
  // manual_* columns, and adds one new table, trip_prospect_commitments
  // -- the current LATEST migration as of this round, so the schema
  // hash must change again.
  //
  // STAGING ONLY as of this round -- NOT applied to Production (same
  // carve-out as 0046/0047/0050/0051).
  assert.deepEqual(manifest.sourceMigrations.at(-1), "0054_trip_manual_prospects.sql");
  assert.equal(PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length, 54, "exactly 54 real, applied-order migrations -- the 0049 draft in drizzle/pending-review/ is never counted");
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
  const tripProspectsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_prospects");
  assert.ok(tripProspectsTable, "trip_prospects must still be a real table in the baseline topology");
  assert.doesNotMatch(tripProspectsTable.sql, /`donor_id` text NOT NULL/, "donor_id must now be nullable");
  for (const column of ["manual_name", "manual_city", "manual_region_id", "manual_phone", "manual_email", "manual_notes"]) {
    assert.match(tripProspectsTable.sql, new RegExp(column), `${column} must be captured in the baseline`);
  }
  const commitmentsTable = manifest.ddlTopology.find((object) => object.type === "table" && object.name === "trip_prospect_commitments");
  assert.ok(commitmentsTable, "trip_prospect_commitments must be a real table in the baseline topology");
  assert.match(commitmentsTable.sql, /committed_cents/);
});
