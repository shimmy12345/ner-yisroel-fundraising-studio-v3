import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { authorizeStagingReset, buildStagingResetStatements, STAGING_RESET_ONBOARDING_TABLE, STAGING_RESET_TABLE_ORDER } from "../lib/operations/staging-reset.ts";
import { FUNDRAISING_DATA_TABLES } from "../lib/data-health/production-baseline.ts";

const root = path.resolve(import.meta.dirname, "..");
const baseline = fs.readFileSync(path.join(root, "production-baseline/drizzle/0000_production_baseline_0019.sql"), "utf8");

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(baseline);
  return database;
}

test("production cannot invoke the reset, regardless of identity", () => {
  const result = authorizeStagingReset("production", "sgoldstein@nirc.edu", "sgoldstein@nirc.edu");
  assert.equal(result.allowed, false);
  assert.equal(result.status, 404, "production must not even reveal this endpoint exists");
});

test("legacy ChatGPT Sites staging cannot invoke the reset", () => {
  const result = authorizeStagingReset("staging", "sgoldstein@nirc.edu", "sgoldstein@nirc.edu");
  assert.equal(result.allowed, false);
  assert.equal(result.status, 404);
});

test("staging-independent can invoke the reset when the identity matches the owner", () => {
  const result = authorizeStagingReset("staging-independent", "sgoldstein@nirc.edu", "SGoldstein@Nirc.edu");
  assert.deepEqual(result, { allowed: true });
});

test("staging-independent rejects an unauthenticated request", () => {
  const result = authorizeStagingReset("staging-independent", null, "sgoldstein@nirc.edu");
  assert.equal(result.allowed, false);
  assert.equal(result.status, 401);
});

test("staging-independent rejects an identity that does not match STAGING_OWNER_EMAIL", () => {
  const result = authorizeStagingReset("staging-independent", "someone-else@example.com", "sgoldstein@nirc.edu");
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
});

test("staging-independent rejects when STAGING_OWNER_EMAIL is not configured", () => {
  const result = authorizeStagingReset("staging-independent", "sgoldstein@nirc.edu", undefined);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
});

test("the reset table order covers every fundraising-data table and nothing else", () => {
  assert.deepEqual([...STAGING_RESET_TABLE_ORDER].sort(), [...FUNDRAISING_DATA_TABLES].sort());
});

test("reset preserves the baseline and the account, and removes all fundraising data", () => {
  const database = freshDatabase();
  const now = Math.floor(Date.now() / 1000);

  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('owner-1', 'sgoldstein@nirc.edu', ${now}, ${now})`);
  database.exec(`INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, updated_at, data_mode) VALUES ('owner-1', 1, ${now}, 'demo')`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('donor-1', 'Fictional Donor', ${now}, ${now})`);
  database.exec(`INSERT INTO gifts (id, donor_id, amount_cents, fund, received_at, created_at, updated_at) VALUES ('gift-1', 'donor-1', 1000, 'General', ${now}, ${now}, ${now})`);
  database.exec(`INSERT INTO giving_activities (id, donor_id, external_source, external_household_id, source_fingerprint, category, source_snapshot, created_at, updated_at) VALUES ('activity-1', 'donor-1', 'jl', 'hh-1', 'fp-1', 'gift', '{}', ${now}, ${now})`);
  database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES ('interaction-1', 'donor-1', 'owner-1', 'note', ${now}, 'Fictional interaction', ${now}, ${now})`);
  database.exec(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, created_at, updated_at) VALUES ('rec-1', 'donor-1', 'owner-1', 'Follow up', 'Test reason', 1, ${now}, ${now})`);
  database.exec(`INSERT INTO data_imports (id, user_id, file_name, file_hash, status, report_json, created_at) VALUES ('import-1', 'owner-1', 'test.csv', 'hash-1', 'complete', '{}', ${now})`);
  database.exec(`INSERT INTO jl_refresh_state (user_id, updated_at) VALUES ('owner-1', ${now})`);

  const count = (table) => database.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  assert.equal(count("donors"), 1, "sanity check: fixture data was inserted");

  const baselineBefore = database.prepare("SELECT id, schema_hash FROM production_schema_baseline").get();

  for (const statement of buildStagingResetStatements()) database.exec(statement);

  const baselineAfter = database.prepare("SELECT id, schema_hash FROM production_schema_baseline").get();
  assert.deepEqual(baselineAfter, baselineBefore, "the baseline marker must be untouched");

  assert.equal(count("users"), 1, "the owner account must survive the reset");
  const owner = database.prepare("SELECT id, email FROM users").get();
  assert.equal(owner.id, "owner-1");
  assert.equal(owner.email, "sgoldstein@nirc.edu");

  for (const table of FUNDRAISING_DATA_TABLES) assert.equal(count(table), 0, `${table} must be empty after reset`);
  assert.equal(count(STAGING_RESET_ONBOARDING_TABLE), 0, "onboarding/demo state must be reset");

  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], "reset must not leave orphaned foreign keys");
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

  database.close();
});
