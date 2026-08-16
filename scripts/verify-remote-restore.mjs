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
import os from "node:os";
import path from "node:path";
import { FUNDRAISING_DATA_TABLES, PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";
import { planD1Restore } from "../lib/operations/d1-restore-order.ts";

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

// D1's remote bulk Import pipeline (what `wrangler d1 execute --remote
// --file=...` uses for anything beyond a trivial size) has an observed,
// undocumented failure mode: "statement too long: SQLITE_TOOBIG" on a
// restore step whose content is nowhere near any actual size limit
// (confirmed empirically 2026-08-16 -- a 162KB statement restores fine
// early in a sequence but fails identically, byte-for-byte, when it is
// not among the first few Import calls against a fresh scratch database;
// per-statement size, total file size, total database size, and pacing
// with up to 90s delays between calls were all ruled out as the cause).
// This is a genuine, reported-but-unresolved Cloudflare platform
// limitation, not something this script's ordering/scoping logic can fix
// -- retrying (ideally against a fresh scratch database, i.e. re-running
// this whole script, but at minimum retrying the individual failing step)
// is the only mitigation found to date. This wrapper retries ONLY this
// specific error signature, a bounded number of times, and still throws
// (failing the workflow loudly, per its whole purpose) if every attempt
// fails -- it must never be widened to swallow other errors.
function wranglerRestoreStepWithRetry(args, { attempts = 3, delayMs = 10_000 } = {}) {
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: root, encoding: "utf8", env: process.env });
    if (lastResult.status === 0) return lastResult;
    const message = (lastResult.stderr || lastResult.stdout || "");
    if (!/SQLITE_TOOBIG|statement too long/i.test(message)) break;
    if (attempt < attempts) {
      console.log(`Restore step hit the known SQLITE_TOOBIG platform quirk (attempt ${attempt}/${attempts}) -- retrying in ${delayMs / 1000}s...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw new Error(`wrangler ${args.join(" ")} failed after retries:\n${(lastResult.stderr || lastResult.stdout || "").trim()}`);
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

const restorePlan = planD1Restore(fs.readFileSync(backupPath, "utf8"));
if (restorePlan.skippedTables.length > 0) {
  console.log(`Note: skipping DATA restore for ${restorePlan.skippedTables.join(", ")} (see D1_RESTORE_SKIP_DATA_TABLES in lib/operations/d1-restore-order.ts -- schema for these tables is still restored and verified).`);
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fundraising-os-restore-verify-"));
function writeTempSql(name, sql) {
  const tempPath = path.join(tempDirectory, name);
  fs.writeFileSync(tempPath, sql);
  return tempPath;
}

let scratchDatabaseId = null;
try {
  console.log(`Creating scratch database ${scratchDatabaseName}...`);
  const createResult = wrangler(["d1", "create", scratchDatabaseName]);
  const idMatch = createResult.stdout.match(/"database_id":\s*"([0-9a-f-]+)"/);
  assert.ok(idMatch, `Could not parse database_id from wrangler d1 create output:\n${createResult.stdout}`);
  scratchDatabaseId = idMatch[1];
  console.log(`Created ${scratchDatabaseName} (${scratchDatabaseId}).`);

  // Restored as separate requests -- schema first, then one request per
  // table in dependency order, then query-planner stats -- rather than one
  // combined file. Confirmed empirically against a real export: a single
  // `wrangler d1 execute --remote --file=...` covering the whole database
  // failed with "statement too long: SQLITE_TOOBIG" even with no
  // individual statement over 162KB, while every individual table
  // (including the largest, a 4.36MB/5171-row table) restored cleanly on
  // its own. See D1RestorePlan's doc comment in
  // lib/operations/d1-restore-order.ts for the full account.
  console.log("Restoring schema...");
  wranglerRestoreStepWithRetry(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql("schema.sql", restorePlan.schemaSql), "--yes"]);

  for (const { table, sql } of restorePlan.dataSteps) {
    console.log(`Restoring data for "${table}" (${sql.length} bytes)...`);
    wranglerRestoreStepWithRetry(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql(`data-${table}.sql`, sql), "--yes"]);
  }

  if (restorePlan.trailingStatsSql) {
    console.log("Restoring query-planner statistics (best-effort -- these are planner hints, not data, so a failure here does not affect integrity and must not fail verification)...");
    wrangler(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql("stats.sql", restorePlan.trailingStatsSql), "--yes"], { allowFailure: true });
  }

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
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
