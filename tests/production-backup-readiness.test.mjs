import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildSchemaOnlyBackup } from "../lib/operations/schema-backup.ts";
import { BUSINESS_DATA_COUNT_SQL, FUNDRAISING_DATA_TABLES, PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";
import { WORKSPACE_BACKUP_EXCLUDED_TABLES, WORKSPACE_BACKUP_TABLES, verifyWorkspaceBackupCoverage } from "../lib/operations/workspace-backup.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const baseline = read("production-baseline/drizzle/0000_production_baseline_0019.sql");

test("a live schema-only export restores without data or integrity loss", () => {
  const source = new DatabaseSync(":memory:");
  source.exec(baseline);
  const rows = source.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const marker = source.prepare("SELECT schema_hash,created_at FROM production_schema_baseline WHERE id='0019'").get();
  const backup = buildSchemaOnlyBackup(rows, marker);
  const restored = new DatabaseSync(":memory:");
  restored.exec(backup);
  assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(restored.prepare("SELECT schema_hash FROM production_schema_baseline WHERE id='0019'").get().schema_hash, PRODUCTION_BASELINE_HASH);
  assert.equal(restored.prepare(BUSINESS_DATA_COUNT_SQL).get().count, 0);
  assert.equal(compareSchemaObjects(stagingSchemaObjects(restored.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all())).matches, true);
});

test("schema backup fails closed on drift or a missing baseline marker", () => {
  const source = new DatabaseSync(":memory:");
  source.exec(baseline);
  const rows = source.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const marker = source.prepare("SELECT schema_hash,created_at FROM production_schema_baseline WHERE id='0019'").get();
  assert.throws(() => buildSchemaOnlyBackup(rows.filter((row) => row.name !== "donors"), marker), /differs from baseline/);
  assert.throws(() => buildSchemaOnlyBackup(rows, null), /baseline marker/);
});

test("backup, encryption, restore, and access operations remain explicit and fail closed", () => {
  const route = read("app/api/operations/schema-backup/route.ts");
  const health = read("app/health/page.tsx");
  const recovery = read("operations/production-backup/OWNER-RECOVERY.md");
  const protect = read("operations/production-backup/protect-backup.ps1");
  const restore = read("scripts/rehearse-production-restore.mjs");
  assert.match(route, /Authentication required/);
  assert.match(route, /__FUNDRAISING_OS_ENVIRONMENT__ !== "production"/);
  assert.match(route, /business data exists/);
  assert.doesNotMatch(route, /INSERT|UPDATE|DELETE/i);
  assert.match(health, /Download schema-only production backup/);
  assert.match(protect, /Protect-CmsMessage/);
  assert.match(restore, /--local/);
  for (const phrase of ["Stop writes", "Restore safely", "Verify integrity", "Reopen access", "Corrupt or incomplete backup", "Wrong environment", "Compromised owner account"]) assert.match(recovery, new RegExp(phrase, "i"));
});

// --- The app-level /api/import/backup export is explicitly partial, never
// a full database backup -- an audit proved it silently omitted ~20 real
// fundraising tables (yahrtzeits, important_dates, gift_acknowledgments,
// donor_historical_context among them). Every fundraising table must now
// be consciously classified as either included or deliberately excluded;
// this test fails the moment a new table is added to the schema without
// that classification, so the coverage claim can never silently drift out
// of sync again the way it already did once. ---
test("the workspace-backup route's table coverage stays synchronized with the authoritative fundraising-table list", () => {
  const coverage = verifyWorkspaceBackupCoverage();
  assert.deepEqual(coverage.unclassified, [], "every fundraising table must be listed in WORKSPACE_BACKUP_TABLES or WORKSPACE_BACKUP_EXCLUDED_TABLES");
  assert.deepEqual(coverage.stale, [], "WORKSPACE_BACKUP_TABLES/WORKSPACE_BACKUP_EXCLUDED_TABLES must not reference a table that no longer exists");
  assert.equal(coverage.inSync, true);
  // Real donor-facing data (not just audit trails) must be classified
  // somewhere -- proves the specific gap the audit found is now accounted
  // for, one way or the other, rather than merely "some list is complete".
  for (const table of ["yahrtzeits", "important_dates", "gift_acknowledgments", "donor_historical_context"]) {
    assert.ok(FUNDRAISING_DATA_TABLES.includes(table), `sanity check: "${table}" must actually be a real fundraising table for this test to mean anything`);
    assert.ok(WORKSPACE_BACKUP_TABLES.includes(table) || WORKSPACE_BACKUP_EXCLUDED_TABLES.includes(table), `"${table}" must be explicitly classified, not silently dropped`);
  }
});

test("the workspace-backup route honestly labels itself as a partial export, not a full backup", () => {
  const route = read("app/api/import/backup/route.ts");
  const settings = read("app/settings/page.tsx");
  assert.match(route, /coverage:\s*"partial"/);
  assert.match(route, /WORKSPACE_BACKUP_TABLES/);
  assert.match(route, /WORKSPACE_BACKUP_EXCLUDED_TABLES/);
  assert.doesNotMatch(route, /"fundraising-os-d1-backup-v1"/, "the old, unqualified 'D1 backup' format tag must not come back");
  assert.doesNotMatch(settings, />Download current D1 backup</, "Settings must not call this a full D1 backup");
  assert.match(settings, /partial workspace export/i);
});
