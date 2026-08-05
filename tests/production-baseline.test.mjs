import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { generateBaseline, schemaTopology } from "../scripts/generate-production-baseline.mjs";
import { compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";
import { ACTIVE_DONORS_SQL, DUPLICATE_GIVING_FINGERPRINTS_SQL, DUPLICATE_JL_CODES_SQL, GIVING_RECONCILIATION_SQL, ORPHANED_GIFTS_SQL, ORPHANED_INTERACTIONS_SQL, ORPHANED_PAYMENTS_SQL, ORPHANED_REMINDERS_SQL } from "../lib/data-health/queries.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const baseline = read("production-baseline/drizzle/0000_production_baseline_0019.sql");
const manifest = JSON.parse(read("production-baseline/schema-manifest.json"));

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(baseline);
  return database;
}

test("authoritative 0019 baseline is reproducible, empty, and replay-safe", () => {
  const generated = generateBaseline();
  assert.equal(baseline, generated.baseline);
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
