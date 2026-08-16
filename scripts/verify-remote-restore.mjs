// Restore-verification for the automated nightly D1 backup. Unlike
// scripts/rehearse-production-restore.mjs (which restores into a LOCAL
// simulated D1 and inspects the resulting .sqlite file directly with
// node:sqlite), this script proves a REMOTE backup actually restores on
// Cloudflare's real D1 service -- the two are complementary, not
// duplicates: this one is what the monthly restore-verification GitHub
// Actions workflow runs, and it is the only one of the two that can catch
// a problem specific to the remote service itself.
//
// It creates a brand-new, throwaway remote D1 database, restores the given
// SQL export into it, runs the same integrity checks the manual recovery
// runbook (operations/production-backup/OWNER-RECOVERY.md) requires by
// hand, and always deletes the scratch database afterward -- including on
// failure, so a bad run never leaves an orphaned database behind to
// accumulate silently.
//
// Usage: node scripts/verify-remote-restore.mjs -- <decrypted-backup.sql>
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the
// environment (the same variables `wrangler` itself reads for
// non-interactive auth). Every step below acts on Cloudflare's real API --
// never run this against credentials you are not comfortable creating and
// deleting a real (if empty and throwaway) D1 database with.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FUNDRAISING_DATA_TABLES, PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";

const backupArgument = process.argv.slice(2).find((argument) => argument !== "--");
const backupPath = backupArgument ? path.resolve(backupArgument) : null;
if (!backupPath || !fs.existsSync(backupPath)) throw new Error("Usage: node scripts/verify-remote-restore.mjs -- <decrypted-backup.sql>");
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment.");

const root = path.resolve(import.meta.dirname, "..");
const scratchDatabaseName = `fundraising-os-restore-verify-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

function wranglerJson(args) {
  const result = wrangler([...args, "--json"]);
  // wrangler's --json output is the JSON payload possibly preceded by
  // informational lines (e.g. "Resource location: remote") -- find the
  // first line that actually parses as JSON rather than assuming stdout
  // is pure JSON from the first byte.
  const lines = result.stdout.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate); } catch { /* keep scanning */ }
  }
  throw new Error(`Could not find JSON in wrangler output for: ${args.join(" ")}\n${result.stdout}`);
}

let scratchDatabaseId = null;
try {
  console.log(`Creating scratch database ${scratchDatabaseName}...`);
  const createResult = wrangler(["d1", "create", scratchDatabaseName]);
  const idMatch = createResult.stdout.match(/"database_id":\s*"([0-9a-f-]+)"/);
  assert.ok(idMatch, `Could not parse database_id from wrangler d1 create output:\n${createResult.stdout}`);
  scratchDatabaseId = idMatch[1];
  console.log(`Created ${scratchDatabaseName} (${scratchDatabaseId}).`);

  console.log("Restoring backup into scratch database...");
  wrangler(["d1", "execute", scratchDatabaseName, "--remote", "--file", backupPath, "--yes"]);

  console.log("Running PRAGMA integrity_check...");
  const integrity = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "PRAGMA integrity_check;"]);
  const integrityValue = integrity?.[0]?.results?.[0]?.integrity_check;
  assert.equal(integrityValue, "ok", `PRAGMA integrity_check did not return "ok": ${JSON.stringify(integrity)}`);

  console.log("Running PRAGMA foreign_key_check (referential integrity)...");
  const foreignKeyViolations = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "PRAGMA foreign_key_check;"]);
  assert.deepEqual(foreignKeyViolations?.[0]?.results ?? [], [], `Restored database has foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`);

  console.log("Validating schema against the verified production baseline...");
  const schemaRows = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name;"])?.[0]?.results ?? [];
  const schemaComparison = compareSchemaObjects(stagingSchemaObjects(schemaRows));
  assert.equal(schemaComparison.matches, true, `Restored schema does not match the production baseline: ${schemaComparison.differences.join(" ")}`);
  const baselineMarker = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "SELECT schema_hash FROM production_schema_baseline WHERE id='0019';"])?.[0]?.results?.[0];
  assert.equal(baselineMarker?.schema_hash, PRODUCTION_BASELINE_HASH, "Restored production_schema_baseline row does not match the current schema hash.");

  console.log("Validating every fundraising table is present and queryable (basic row integrity)...");
  const rowCounts = {};
  for (const table of FUNDRAISING_DATA_TABLES) {
    const countResult = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", `SELECT COUNT(*) AS count FROM "${table}";`])?.[0]?.results?.[0];
    assert.ok(countResult && Number.isInteger(countResult.count) && countResult.count >= 0, `Table "${table}" did not return a valid row count after restore: ${JSON.stringify(countResult)}`);
    rowCounts[table] = countResult.count;
  }

  console.log(`Restore verification passed. Row counts: ${JSON.stringify(rowCounts)}`);
} finally {
  if (scratchDatabaseId) {
    console.log(`Deleting scratch database ${scratchDatabaseName}...`);
    const deleteResult = wrangler(["d1", "delete", scratchDatabaseName, "-y"], { allowFailure: true });
    if (deleteResult.status !== 0) {
      // Do not let cleanup failure mask the real result, but never let a
      // scratch database go unmentioned in the logs either -- a human
      // needs to know to remove it by hand if this happens.
      console.error(`::warning::Could not delete scratch database ${scratchDatabaseName} (${scratchDatabaseId}) -- remove it manually: npx wrangler d1 delete ${scratchDatabaseName} -y`);
    } else {
      console.log("Scratch database deleted.");
    }
  }
}
