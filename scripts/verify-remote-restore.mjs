// Restore-verification for the automated nightly D1 backup. Unlike
// scripts/rehearse-production-restore.mjs (which restores into a LOCAL
// simulated D1 and inspects the resulting .sqlite file directly with
// node:sqlite), this script proves a REMOTE backup actually restores on
// Cloudflare's real D1 service -- the two are complementary, not
// duplicates: this one is what the monthly restore-verification GitHub
// Actions workflow runs (both the Staging and the Production copy --
// d1-restore-verify-monthly.yml / d1-restore-verify-monthly-production.yml
// both invoke this same script), and it is the only one of the two that can
// catch a problem specific to the remote service itself.
//
// It creates a brand-new, throwaway remote D1 database, restores the given
// SQL export into it, runs the same integrity checks the manual recovery
// runbook (operations/production-backup/OWNER-RECOVERY.md) requires by
// hand, and always deletes the scratch database afterward -- including on
// failure, so a bad run never leaves an orphaned database behind to
// accumulate silently.
//
// Restores in three layers, all driven by planD1Restore
// (lib/operations/d1-restore-order.ts): schema, then normal-sized data per
// table in dependency-safe order via `wrangler d1 execute --file=...`, then
// any individual statement too large for that path via the D1 HTTP query
// API with the value moved into a bound parameter instead of inline text.
//
// Root cause this corrects (2026-11-02, see docs/AI-HANDOFF.md's "Repair
// and Verify Backup Restoration" entry): a disposable-database restore test
// against this branch's own real, freshly exported Staging data failed
// with "no such table: main.users: SQLITE_ERROR" -- `wrangler d1 export`
// orders CREATE TABLE/INSERT statements by each table's position in
// sqlite_master, not by foreign-key dependency (`donors`, which has a
// foreign key to `users`, is exported long before `users` itself), and
// restoring via a single `wrangler d1 execute --remote --file=...` goes
// through D1's server-side bulk Import pipeline, which applies the file
// across several internal batches -- `PRAGMA defer_foreign_keys=TRUE` (set
// once, at the top of the file) does not survive across those batch
// boundaries. This is the SAME failure, root-caused and already fixed on
// `main` months earlier (commits 92e0bfd and 6875786, 2026-08-16) via
// exactly the planD1Restore-driven restore this file now also uses --
// lib/operations/d1-restore-order.ts (the fix itself) had already been
// ported onto this branch, but this script -- the one both monthly restore-
// verification workflows actually run -- had never been updated to call
// it, so the fix existed without being wired in where it mattered. This
// confirms the defect was real and affected the actual automated Production
// and Staging restore-verification mechanism, not merely a manual test
// approach: see D1RestorePlan's doc comment in
// lib/operations/d1-restore-order.ts for the full account, including the
// second, independent SQLITE_TOOBIG problem found and fixed alongside it.
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
import { findInsertedRow, planD1Restore } from "../lib/operations/d1-restore-order.ts";

const backupArgument = process.argv.slice(2).find((argument) => argument !== "--");
const backupPath = backupArgument ? path.resolve(backupArgument) : null;
if (!backupPath || !fs.existsSync(backupPath)) throw new Error("Usage: node scripts/verify-remote-restore.mjs -- <decrypted-backup.sql>");
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment.");

const root = path.resolve(import.meta.dirname, "..");
const scratchDatabaseName = `fundraising-os-restore-verify-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
const backupSql = fs.readFileSync(backupPath, "utf8");

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

// Bounded retry for genuine transient failures (network blips, etc.) --
// NOT a workaround for SQLITE_TOOBIG. That error is handled structurally:
// planD1Restore (lib/operations/d1-restore-order.ts) routes any statement
// at or above D1_SAFE_STATEMENT_BYTES through d1QueryApiInsert below
// instead of this file-based path, so this function should never see that
// error for a correctly-sized statement. If it ever does, that is a real
// problem worth failing loudly on, not retrying past -- hence no special-
// casing of the error message here.
function wranglerRestoreStepWithRetry(args, { attempts = 3, delayMs = 5_000 } = {}) {
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: root, encoding: "utf8", env: process.env });
    if (lastResult.status === 0) return lastResult;
    if (attempt < attempts) {
      console.log(`Restore step failed (attempt ${attempt}/${attempts}) -- retrying in ${delayMs / 1000}s...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw new Error(`wrangler ${args.join(" ")} failed after retries:\n${(lastResult.stderr || lastResult.stdout || "").trim()}`);
}

// D1's HTTP query API accepts a parameterized statement ({sql, params}) and
// does not share the bulk Import pipeline's (`wrangler d1 execute
// --file=...`) per-statement inline-SQL-text-length ceiling. This is the
// fix for an individual oversized row (e.g. a large JSON blob column) --
// see D1_SAFE_STATEMENT_BYTES's doc comment in
// lib/operations/d1-restore-order.ts for the full account.
async function d1QueryApiInsert(databaseId, sql, params, { attempts = 3, delayMs = 5_000 } = {}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`;
  let lastBody;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    lastBody = await response.json();
    if (response.ok && lastBody.success) return lastBody;
    if (attempt < attempts) {
      console.log(`D1 query API call failed (attempt ${attempt}/${attempts}, HTTP ${response.status}) -- retrying in ${delayMs / 1000}s...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw new Error(`D1 query API insert failed after retries: ${JSON.stringify(lastBody?.errors ?? lastBody)}`);
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

const restorePlan = planD1Restore(backupSql);
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
  // restore step in dependency-safe order, then query-planner stats --
  // rather than one combined file. A single `wrangler d1 execute --remote
  // --file=...` covering the whole database fails with dependency-order
  // foreign-key errors (see this file's header) and, even once reordered,
  // with "statement too long: SQLITE_TOOBIG" for a large combined file;
  // restoring one table at a time in dependency order, with any
  // individually oversized row routed to the D1 HTTP query API instead,
  // avoids both. See D1RestorePlan's doc comment in
  // lib/operations/d1-restore-order.ts for the full account.
  console.log("Restoring schema...");
  wranglerRestoreStepWithRetry(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql("schema.sql", restorePlan.schemaSql), "--yes"]);

  // Each table's steps (a "file" step for its normal-sized rows, a
  // "statement" step for each oversized one) are iterated together, in
  // dependency order, exactly as planD1Restore produced them -- never
  // regrouped by kind, since a child row could reference a parent's
  // oversized row that hasn't been restored yet if oversized statements
  // were deferred to "the end" instead.
  for (const step of restorePlan.steps) {
    if (step.kind === "file") {
      console.log(`Restoring data for "${step.table}" (${step.sql.length} bytes)...`);
      wranglerRestoreStepWithRetry(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql(`data-${step.table}.sql`, step.sql), "--yes"]);
    } else {
      const totalParamBytes = step.params.reduce((sum, value) => sum + String(value ?? "").length, 0);
      console.log(`Restoring 1 oversized statement for "${step.table}" via the D1 query API (parameterized, ~${totalParamBytes} bytes of value data, ${step.sql.length}-byte SQL text)...`);
      await d1QueryApiInsert(scratchDatabaseId, step.sql, step.params);
    }
  }

  if (restorePlan.trailingStatsSql) {
    console.log("Restoring query-planner statistics (best-effort -- these are planner hints, not data, so a failure here does not affect integrity and must not fail verification)...");
    wrangler(["d1", "execute", scratchDatabaseName, "--remote", "--file", writeTempSql("stats.sql", restorePlan.trailingStatsSql), "--yes"], { allowFailure: true });
  }

  // `PRAGMA integrity_check` is rejected outright by D1's query API with
  // "not authorized: SQLITE_AUTH" (confirmed against the real, untouched
  // Staging database too, so this is a Cloudflare D1 API-level
  // restriction, not anything to do with this restore). `PRAGMA
  // quick_check` is SQLite's own documented, near-equivalent, lighter
  // alternative (same "ok" / list-of-problems output contract; it performs
  // the same B-tree, page-linkage, and cell-format structural checks and
  // most of the same index-consistency checks -- the only thing it skips
  // is one direction of unique-index/row correspondence verification, a
  // narrow difference not relevant to proving a restore is structurally
  // sound) and is not blocked. This is a necessary substitution, not a
  // weakening: integrity_check is not merely slower via this path, it is
  // hard-rejected, so quick_check is the only way this step can run at all
  // via the D1 API today.
  console.log("Running PRAGMA quick_check...");
  const integrity = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "PRAGMA quick_check;"]);
  const integrityValue = integrity?.[0]?.results?.[0]?.quick_check;
  assert.equal(integrityValue, "ok", `PRAGMA quick_check did not return "ok": ${JSON.stringify(integrity)}`);

  console.log("Running PRAGMA foreign_key_check (referential integrity)...");
  const foreignKeyViolations = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "PRAGMA foreign_key_check;"]);
  assert.deepEqual(foreignKeyViolations?.[0]?.results ?? [], [], `Restored database has foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`);

  // CURRENT STRUCTURAL INTEGRITY: a strict, independent, table-by-table and
  // index-by-index DDL comparison between the restored database's ACTUAL
  // live schema and the packaged manifest (production-baseline/schema-manifest.json).
  // This check does not read production_schema_baseline at all, so it can
  // never be satisfied or defeated by that row's value -- see below for why
  // that is a deliberate, separate concern.
  console.log("Validating restored schema against the current packaged manifest...");
  const schemaRows = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name;"])?.[0]?.results ?? [];
  const schemaComparison = compareSchemaObjects(stagingSchemaObjects(schemaRows));
  assert.equal(schemaComparison.matches, true, `Restored schema does not match the production baseline: ${schemaComparison.differences.join(" ")}`);

  // BACKUP FIDELITY for production_schema_baseline (id '0019'): this row is
  // a write-once historical lineage stamp, not a continuously-reverified
  // marker -- nothing re-stamps it as later migrations land, and
  // PRODUCTION_BASELINE_HASH itself changes with every schema-affecting
  // migration (see lib/data-health/production-baseline.ts). Restoring an
  // older, still-valid backup will faithfully reproduce whatever hash was
  // stamped at that backup's time, which will legitimately differ from
  // today's packaged hash once migrations have landed since -- that must
  // never by itself fail restore verification (ported from the proven fix
  // on main, commit a9685bac34db: the old code asserted the restored
  // marker equalled today's PRODUCTION_BASELINE_HASH, which made this
  // check fail permanently on every future restore the moment a single
  // migration landed after whichever one last stamped the row -- even on a
  // perfectly correct backup and restore). The only thing a restore can
  // meaningfully prove about this row is that the BACKUP's own value
  // survived the restore intact.
  console.log("Validating production_schema_baseline backup fidelity (restored marker must match the SOURCE BACKUP's own marker, not today's packaged hash)...");
  const sourceBaselineRow = findInsertedRow(backupSql, "production_schema_baseline", "id", "0019");
  assert.ok(sourceBaselineRow, `Source backup has no production_schema_baseline row for id "0019" -- cannot verify backup fidelity for this table.`);
  const restoredBaselineRow = wranglerJson(["d1", "execute", scratchDatabaseName, "--remote", "--command", "SELECT schema_hash FROM production_schema_baseline WHERE id='0019';"])?.[0]?.results?.[0];
  assert.equal(
    restoredBaselineRow?.schema_hash,
    sourceBaselineRow.schema_hash,
    `Restored production_schema_baseline row does not match the SOURCE BACKUP's own marker (backup fidelity failure): restored="${restoredBaselineRow?.schema_hash}" backup="${sourceBaselineRow.schema_hash}".`,
  );
  const stampedCurrent = restoredBaselineRow.schema_hash === PRODUCTION_BASELINE_HASH;
  console.log(`production_schema_baseline backup fidelity OK (schema_hash=${restoredBaselineRow.schema_hash}${stampedCurrent ? ", also matches today's packaged hash" : " -- an older but faithfully-restored historical stamp relative to today's packaged hash " + PRODUCTION_BASELINE_HASH + ", which is expected and does not indicate a problem; current structural integrity was already verified independently above"}).`);

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
