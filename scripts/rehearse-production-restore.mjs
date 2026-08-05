import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import manifest from "../production-baseline/schema-manifest.json" with { type: "json" };
import { BUSINESS_DATA_COUNT_SQL, PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";

const backupArgument = process.argv.slice(2).find((argument) => argument !== "--");
const backupPath = backupArgument ? path.resolve(backupArgument) : null;
if (!backupPath || !fs.existsSync(backupPath)) throw new Error("Usage: pnpm db:production:restore-rehearse -- <schema-backup.sql>");
const persistPath = fs.mkdtempSync(path.join(os.tmpdir(), "fundraising-os-d1-restore-"));
const root = path.resolve(import.meta.dirname, "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const config = path.join(root, "operations", "production-backup", "wrangler.restore.toml");

try {
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", persistPath, "--config", config, "--file", backupPath, "--yes"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_PATH: path.join(persistPath, "wrangler-logs") },
  });
  if (result.status !== 0) throw new Error(`Local D1 restore failed: ${(result.stderr || result.stdout).trim()}`);
  const sqliteFiles = fs.readdirSync(persistPath, { recursive: true }).filter((entry) => String(entry).endsWith(".sqlite"));
  const restoredDatabases = sqliteFiles.map((entry) => {
    const database = new DatabaseSync(path.join(persistPath, String(entry)));
    const hasMarker = Boolean(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='production_schema_baseline'").get());
    if (!hasMarker) database.close();
    return hasMarker ? database : null;
  }).filter(Boolean);
  assert.equal(restoredDatabases.length, 1, "the rehearsal must identify exactly one restored application D1 database");
  const database = restoredDatabases[0];
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("SELECT schema_hash FROM production_schema_baseline WHERE id='0019'").get().schema_hash, PRODUCTION_BASELINE_HASH);
  const schemaRows = database.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const comparison = compareSchemaObjects(stagingSchemaObjects(schemaRows));
  assert.equal(comparison.matches, true, comparison.differences.join(" "));
  assert.equal(database.prepare(BUSINESS_DATA_COUNT_SQL).get().count, 0);
  assert.equal(manifest.baselineLevel, "0019");
  database.close();
  console.log(`Restore rehearsal passed: temporary local D1 reached schema 0019, ${manifest.topology.tables.length} tables matched, integrity and foreign keys passed, and business rows remained zero.`);
} finally {
  try {
    fs.rmSync(persistPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    console.warn(`Temporary D1 is verified but still locked by Windows; remove it after this process exits: ${persistPath}`);
  }
}
