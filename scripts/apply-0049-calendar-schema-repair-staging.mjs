// ============================================================================
// DRAFT -- PREPARED, NOT RUN. PENDING SEPARATE, EXPLICIT OWNER AUTHORIZATION.
// ============================================================================
// This script applies drizzle/pending-review/0049_fix_calendar_schema_text_
// staging_repair.sql to the Staging D1 database (fundraising-os-staging-db)
// ONLY. It has never been executed. Nothing in this repository calls it
// automatically -- it is not wired into package.json, CI, or any other
// script. Running it is a deliberate, separate decision the owner (or an
// agent with the owner's explicit go-ahead for THIS specific action) makes
// after reviewing docs/AI-HANDOFF.md's own "Staging-only application plan"
// entry, which this file implements verbatim.
//
// It NEVER touches wrangler.production.jsonc / the production database --
// the Staging config path is hardcoded below and asserted before anything
// else runs. It is not safe to adapt this script for Production without a
// separate, fully independent review: Production's own backup/restore and
// change-control requirements (operations/production-backup/OWNER-RECOVERY.md)
// are stricter than anything this script does.
//
// What it does, in order, aborting immediately (and leaving Staging
// untouched beyond that point) on any check failing:
//   1. Preflight: confirms the config is Staging, confirms the repair
//      migration file exists and hashes to what this round's rehearsal
//      (tests/calendar-schema-repair-rehearsal.test.mjs, CI run documented
//      in docs/AI-HANDOFF.md) actually proved, confirms CLOUDFLARE_API_TOKEN/
//      CLOUDFLARE_ACCOUNT_ID are set.
//   2. Takes a full, timestamped `wrangler d1 export --remote` backup of
//      Staging BEFORE touching anything, and prints the exact command to
//      restore it if anything goes wrong.
//   3. Captures a full snapshot of calendar_event_links and
//      calendar_event_link_history (every row, every column) via
//      `wrangler d1 execute --remote --command` (read-only).
//   4. Applies the repair via a SINGLE `db.batch()` call over the real
//      remote Staging D1 binding (`getPlatformProxy({remoteBindings:
//      true})`) -- the only confirmed-atomic multi-statement D1 primitive
//      (see the migration file's own header for why this must never be
//      `wrangler d1 execute --file`, whose cross-statement atomicity for a
//      whole file is not reliably documented).
//   5. Re-captures the same snapshot and asserts it is byte-for-byte
//      identical to step 3's.
//   6. Runs `PRAGMA foreign_key_check` and `PRAGMA integrity_check` against
//      Staging directly via `wrangler d1 execute --remote --command` (the
//      CLI/HTTP management path -- confirmed, via this round's own
//      rehearsal, to allow both; the in-Worker D1Database binding
//      `db.prepare()`/`db.batch()` rejects `PRAGMA integrity_check` outright
//      with `SQLITE_AUTH`, which is why this step shells out to wrangler
//      instead of using the same binding step 4 used).
//   7. Validates Staging's live schema against the packaged production
//      baseline manifest (the same comparison production-backup-
//      readiness.test.mjs and scripts/verify-remote-restore.mjs already
//      use) -- must now report a clean match for calendar_event_links and
//      calendar_event_link_history, where it previously did not.
//   8. Takes a SECOND full `wrangler d1 export --remote` backup (now that
//      the schema text is fixed) and feeds it through
//      scripts/verify-remote-restore.mjs -- the SAME proven remote-restore
//      verification this repo already runs for Production's own monthly
//      backups -- to prove the fixed schema actually restores cleanly on
//      Cloudflare's real D1 service, not merely that it looks right.
//
// Usage (after separate authorization):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/apply-0049-calendar-schema-repair-staging.mjs
// ============================================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { splitSqlStatements } from "../lib/calendar/testing/local-d1.ts";
import { compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";

const root = path.resolve(import.meta.dirname, "..");
const STAGING_CONFIG_PATH = path.join(root, "wrangler.staging.jsonc");
const STAGING_DATABASE_NAME = "fundraising-os-staging-db";
const REPAIR_MIGRATION_PATH = path.join(root, "drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql");

// Updated each time the migration file is corrected and re-rehearsed (see
// docs/AI-HANDOFF.md) -- this script refuses to run against a migration
// file whose content does not match what was actually proven against real
// D1, so a future, unreviewed edit to the .sql file can never silently
// skip rehearsal.
// Matches drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql
// as of commit d029060 (feature/independent-cloudflare-sandbox) -- the
// exact content proven by tests/calendar-schema-repair-rehearsal.test.mjs
// on Linux CI (see docs/AI-HANDOFF.md). Recompute and update this if the
// migration file is ever edited after a future review round.
const EXPECTED_REPAIR_SHA256 = "b107b1e573be87a0593aa529f2a6da3eb240fdd9589929c943aa8f7dc54d06ae";

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

function wranglerJson(args) {
  const result = wrangler([...args, "--json"]);
  const lines = result.stdout.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate); } catch { /* keep scanning */ }
  }
  throw new Error(`Could not find JSON in wrangler output for: ${args.join(" ")}\n${result.stdout}`);
}

function snapshotCalendarTables() {
  const links = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--command", "SELECT * FROM calendar_event_links ORDER BY id;"])?.[0]?.results ?? [];
  const history = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--command", "SELECT * FROM calendar_event_link_history ORDER BY id;"])?.[0]?.results ?? [];
  return { links, history };
}

async function main() {
  // --- 1. Preflight ---------------------------------------------------
  const config = fs.readFileSync(STAGING_CONFIG_PATH, "utf8");
  assert.match(config, /fundraising-os-staging-db/, "STAGING_CONFIG_PATH must point at the Staging D1 database -- refusing to proceed otherwise.");
  assert.doesNotMatch(config, /fundraising-os-production-db/, "Staging config must never also reference the production database name.");

  const repairSql = fs.readFileSync(REPAIR_MIGRATION_PATH, "utf8");
  const actualHash = createHash("sha256").update(repairSql).digest("hex");
  assert.equal(
    actualHash,
    EXPECTED_REPAIR_SHA256,
    `The repair migration's content does not match what was rehearsed and recorded in docs/AI-HANDOFF.md (expected sha256 ${EXPECTED_REPAIR_SHA256}, got ${actualHash}). Re-rehearse (tests/calendar-schema-repair-rehearsal.test.mjs on Linux CI) before updating this constant and re-running.`,
  );
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN must be set.");
  assert.ok(process.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID must be set.");
  console.log(`Preflight OK. Repair migration sha256=${actualHash}.`);

  // --- 2. Full recoverable backup, BEFORE anything changes ------------
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupBeforePath = path.join(root, `staging-backup-before-0049-${timestamp}.sql`);
  console.log(`Exporting full Staging backup to ${backupBeforePath}...`);
  wrangler(["d1", "export", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--output", backupBeforePath]);
  assert.ok(fs.existsSync(backupBeforePath) && fs.statSync(backupBeforePath).size > 0, "Pre-repair backup export is missing or empty -- aborting before any write.");
  console.log(`Backup complete. If anything below fails, restore with:\n  npx wrangler@4.92.0 d1 execute ${STAGING_DATABASE_NAME} --remote --config ${STAGING_CONFIG_PATH} --file ${backupBeforePath} --yes`);

  // --- 3. Before snapshot ----------------------------------------------
  console.log("Capturing calendar_event_links/calendar_event_link_history before the repair...");
  const before = snapshotCalendarTables();
  console.log(`Before: ${before.links.length} link row(s), ${before.history.length} history row(s).`);

  // --- 4. Apply the repair via a single db.batch() ---------------------
  console.log("Applying the repair via a single db.batch() against the REAL remote Staging D1 binding...");
  const proxy = await getPlatformProxy({ configPath: STAGING_CONFIG_PATH, remoteBindings: true });
  try {
    const db = proxy.env.DB;
    const statements = splitSqlStatements(repairSql);
    assert.ok(statements.length >= 14, "Parsed an unexpectedly small number of statements out of the repair migration -- aborting rather than applying a truncated batch.");
    await db.batch(statements.map((statement) => db.prepare(statement)));
    console.log(`Applied ${statements.length} statements in one batch.`);
  } finally {
    await proxy.dispose();
  }

  // --- 5. After snapshot, must be byte-for-byte identical --------------
  console.log("Re-capturing calendar_event_links/calendar_event_link_history after the repair...");
  const after = snapshotCalendarTables();
  assert.deepEqual(after.links, before.links, "Row/column mismatch in calendar_event_links after the repair -- STOP. Restore the pre-repair backup immediately (command printed above) and do not proceed further.");
  assert.deepEqual(after.history, before.history, "Row/column mismatch in calendar_event_link_history after the repair -- STOP. Restore the pre-repair backup immediately (command printed above) and do not proceed further.");
  console.log("Row/column preservation confirmed: every row in both tables is unchanged.");

  // --- 6. foreign_key_check / integrity_check via the CLI/HTTP path -----
  // (the in-Worker D1Database binding used in step 4 rejects
  // PRAGMA integrity_check with SQLITE_AUTH -- confirmed this round; the
  // wrangler CLI's --remote --command path does not have that restriction,
  // the same path scripts/verify-remote-restore.mjs already relies on.)
  console.log("Running PRAGMA foreign_key_check against Staging...");
  const fkViolations = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--command", "PRAGMA foreign_key_check;"])?.[0]?.results ?? [];
  assert.deepEqual(fkViolations, [], `PRAGMA foreign_key_check reported violations after the repair: ${JSON.stringify(fkViolations)}`);

  console.log("Running PRAGMA integrity_check against Staging...");
  const integrity = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--command", "PRAGMA integrity_check;"])?.[0]?.results?.[0]?.integrity_check;
  assert.equal(integrity, "ok", `PRAGMA integrity_check did not return "ok": ${integrity}`);
  console.log("foreign_key_check clean, integrity_check ok.");

  // --- 7. Schema-health check against the packaged baseline ------------
  console.log("Validating Staging's live schema against the packaged production baseline manifest...");
  const schemaRows = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--command", "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name;"])?.[0]?.results ?? [];
  const comparison = compareSchemaObjects(stagingSchemaObjects(schemaRows));
  assert.equal(comparison.matches, true, `Staging's schema still does not match the baseline after the repair: ${comparison.differences.join(" ")}`);
  console.log("Schema-health check: Staging now matches the packaged baseline exactly.");

  // --- 8. Second backup + the real remote-restore verification ---------
  const backupAfterPath = path.join(root, `staging-backup-after-0049-${timestamp}.sql`);
  console.log(`Exporting post-repair Staging backup to ${backupAfterPath}...`);
  wrangler(["d1", "export", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_CONFIG_PATH, "--output", backupAfterPath]);
  console.log("Running the proven remote-restore verification (scripts/verify-remote-restore.mjs) against the post-repair backup...");
  const restoreVerify = spawnSync(process.execPath, ["scripts/verify-remote-restore.mjs", "--", backupAfterPath], { cwd: root, encoding: "utf8", env: process.env, stdio: "inherit" });
  assert.equal(restoreVerify.status, 0, "Post-repair backup failed real remote-restore verification -- investigate before considering this repair complete.");

  console.log("\nDone. Staging's calendar_event_links/calendar_event_link_history schema text is repaired, every row survived unchanged, and the fix restores cleanly on a real scratch D1 database.");
  console.log(`Pre-repair backup kept at: ${backupBeforePath}`);
  console.log(`Post-repair backup kept at: ${backupAfterPath}`);
}

main().catch((error) => {
  console.error("\nABORTED:", error.message);
  console.error("Staging's calendar tables may be in the pre-repair OR post-repair state depending on which step failed above -- check the last successful step's log line, and if in doubt, restore the pre-repair backup (command printed earlier in this run's output) before investigating further.");
  process.exitCode = 1;
});
