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
  assert.deepEqual(ACCOUNT_CONFIGURATION_TABLES, ["users", "onboarding_preferences"]);
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("users"), "users must never count toward fundraising data");
  assert.ok(!FUNDRAISING_DATA_TABLES.includes("onboarding_preferences"), "onboarding_preferences must never count toward fundraising data");
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
  assert.deepEqual(manifest.sourceMigrations.at(-1), "0033_pledge_payment_plans.sql");
  assert.equal(PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length, 34);
  assert.equal(PRODUCTION_BASELINE_HASH, manifest.schemaHash);
  assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
});
