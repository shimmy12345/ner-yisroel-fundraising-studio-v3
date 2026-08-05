import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildSchemaOnlyBackup } from "../lib/operations/schema-backup.ts";
import { BUSINESS_DATA_COUNT_SQL, PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";

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
