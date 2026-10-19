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
// wrangler.staging-repair.jsonc (a DEDICATED, minimal config -- see that
// file's own header for why it exists separately from
// wrangler.staging.jsonc) is hardcoded below, and every step independently
// re-validates it is talking to Staging's own known database id before
// doing anything (see step 1). It is not safe to adapt this script for
// Production without a separate, fully independent review: Production's
// own backup/restore and change-control requirements (operations/
// production-backup/OWNER-RECOVERY.md) are stricter than anything here.
//
// What it does, in order, aborting immediately on any check failing:
//   1. Preflight: confirms the repair migration file hashes to what this
//      round's rehearsal (tests/calendar-schema-repair-rehearsal.test.mjs,
//      CI run documented in docs/AI-HANDOFF.md) actually proved, confirms
//      CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID are set, then connects
//      to the real remote Staging D1 through TWO independent paths (the
//      D1 binding and the wrangler CLI) and refuses to proceed unless
//      both agree on the same, known database identity (see
//      scripts/lib/staging-repair-connect.mjs).
//   2. Takes a full, timestamped `wrangler d1 export --remote` backup of
//      Staging BEFORE touching anything.
//   3. Restores that SAME backup into an ISOLATED LOCAL database
//      (node:sqlite, no remote access, no scratch database of any kind)
//      and compares its calendar_event_links/calendar_event_link_history
//      data against a fresh read of Staging -- proving the backup is
//      actually recoverable, not merely non-empty. This specifically
//      does NOT exercise the normalized schema-backup path's own known
//      defect (lib/operations/schema-backup.ts's buildSchemaOnlyBackup)
//      -- a raw `wrangler d1 export` dump keeps real newlines, so an
//      embedded `--` comment terminates normally either way; that is a
//      SEPARATE question from "is this specific export file itself
//      recoverable," which is what this step actually proves.
//   4. Captures a full snapshot of calendar_event_links and
//      calendar_event_link_history (every row, every column) via the
//      now-validated D1 binding (read-only).
//   5. Encrypts and uploads the pre-repair backup to the existing R2
//      backup bucket, and independently verifies the uploaded object
//      (byte-size read-back, never merely "the upload command exited
//      zero") -- all via retainBackupSecurely()/applyRepairBatchGuardedByRetention()
//      (lib/operations/calendar-schema-repair-apply.ts). THE REPAIR
//      BATCH IS STRUCTURALLY UNREACHABLE UNLESS THIS SUCCEEDS: see that
//      function's own header for why (a prior version of this retention
//      step, written as a separate CI shell step with `set -uo
//      pipefail` -- missing `-e` -- could report success and shred the
//      only local copy even when compression/encryption/upload had
//      actually failed; fixed by moving this into the application
//      script itself as a hard, structural gate, with offline regression
//      tests in tests/calendar-schema-repair-apply.test.mjs proving the
//      repair is never invoked when this fails).
//   6. Applies the repair via a SINGLE `db.batch()` call over the SAME
//      validated binding -- the only confirmed-atomic multi-statement D1
//      primitive (see the migration file's own header for why this must
//      never be `wrangler d1 execute --file`, whose cross-statement
//      atomicity for a whole file is not reliably documented).
//   7. Re-captures the same snapshot and asserts it is byte-for-byte
//      identical to step 4's.
//   8. Runs `PRAGMA foreign_key_check` and `PRAGMA integrity_check`
//      against Staging via `wrangler d1 execute --remote --command` (the
//      in-Worker D1Database binding rejects `PRAGMA integrity_check`
//      outright with `SQLITE_AUTH` -- confirmed this round).
//   9. Validates Staging's live schema against the packaged production
//      baseline manifest -- must now report a clean match for both
//      calendar tables, where it previously did not.
//  10. Takes a SECOND full backup (now that the schema text is fixed)
//      and feeds it through scripts/verify-remote-restore.mjs -- the
//      SAME proven remote-restore verification this repo already runs
//      for Production's own monthly backups -- to prove the fixed
//      schema actually restores cleanly on Cloudflare's real D1 service.
//  11. Encrypts, uploads, and independently verifies the POST-repair
//      backup the SAME way step 5 did. A failure here FAILS THE JOB --
//      it never reports success -- but, unlike step 5, does not and
//      cannot undo the repair (already independently verified via rows/
//      FK/schema by this point): it means this specific backup needs a
//      human to re-attempt its retention or secure it another way.
//
// HONEST LIMITATION: this runs on an ephemeral GitHub Actions runner.
// "The only recoverable copy is never silently discarded" (step 5/11's
// own guarantee) means the local plaintext/ciphertext is preserved for
// the REMAINDER of this job's own run whenever retention fails -- it
// does NOT mean the backup survives indefinitely if upload keeps
// failing, since the runner's entire workspace is destroyed when the
// job ends regardless of outcome. What IS guaranteed: retention failure
// is never silently reported as success, and a pre-repair retention
// failure always prevents the mutation from ever being attempted.
//
// FAILURE HANDLING (lib/operations/calendar-schema-repair-apply.ts's own
// describeFailure(), unit-tested offline in
// tests/calendar-schema-repair-apply.test.mjs) -- genuinely different
// situations, each reported with its own specific guidance, never a
// single blanket "restore the backup" message:
//   - A failure in steps 1-5 (before the repair batch is even
//     attempted, including a pre-repair retention failure): nothing has
//     been touched. Fix the cause and re-run; no recovery action of any
//     kind is needed.
//   - The repair batch itself (step 6) throwing a SPECIFIC, recognized
//     rejection (a named constraint/SQL error -- never a bare, generic
//     `D1_ERROR` wrapper on its own, which proves nothing about whether
//     a write landed): D1's own batch atomicity means Staging was never
//     partially modified. No recovery action is needed.
//   - Step 7 (the very next check after the batch call itself returned
//     successfully) failing to CONFIRM row preservation: this means
//     preservation is UNVERIFIED or MISMATCHED, not "already confirmed"
//     -- read-only inspection first, never assume either outcome.
//   - A failure in steps 8-11 (AFTER step 7 already confirmed every row
//     survived, INCLUDING a post-repair retention failure): Do NOT
//     restore the pre-repair backup on this basis alone -- that would
//     UNDO a successful, already-verified repair over a LATER, separate
//     check's own failure.
//   - An UNCERTAIN outcome (the batch call failed with something that
//     does NOT look like a specific, recognized rejection -- a network/
//     timeout error, or any other unrecognized D1 error): never guess.
//     Run the read-only diagnostic queries describeFailure() prints
//     against Staging to determine its actual current state before
//     deciding whether to retry, recover, or leave it alone. If, and
//     only if, that shows a genuinely ambiguous state, use
//     scripts/recover-0049-calendar-schema-repair-staging.mjs against
//     the pre-repair backup from step 2 -- never a raw
//     `wrangler d1 execute --file` replay, which fails outright against
//     tables that already exist (see that script's own header).
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
import { DatabaseSync } from "node:sqlite";
import { splitSqlStatements } from "../lib/calendar/testing/local-d1.ts";
import { compareSchemaObjects, stagingSchemaObjects } from "../lib/data-health/production-baseline.ts";
import { STAGING_REPAIR_CONFIG_PATH, STAGING_DATABASE_NAME, wrangler, wranglerJson, connectAndValidateStagingTarget } from "./lib/staging-repair-connect.mjs";
import { buildRealRetentionDeps } from "./lib/backup-retention.mjs";
import { PhaseError, snapshotCalendarTablesViaBinding, verifyBackupRestoresAndMatches, retainBackupSecurely, applyRepairBatchGuardedByRetention, describeFailure } from "../lib/operations/calendar-schema-repair-apply.ts";

const root = path.resolve(import.meta.dirname, "..");
const REPAIR_MIGRATION_PATH = path.join(root, "drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql");

// Updated each time the migration file is corrected and re-rehearsed (see
// docs/AI-HANDOFF.md) -- this script refuses to run against a migration
// file whose content does not match what was actually proven against real
// D1, so a future, unreviewed edit to the .sql file can never silently
// skip rehearsal. Matches
// drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql
// as of commit d029060 (feature/independent-cloudflare-sandbox) -- the
// exact content proven by tests/calendar-schema-repair-rehearsal.test.mjs
// on Linux CI (see docs/AI-HANDOFF.md).
const EXPECTED_REPAIR_SHA256 = "b107b1e573be87a0593aa529f2a6da3eb240fdd9589929c943aa8f7dc54d06ae";
const R2_BACKUP_KEY_PREFIX = "repair-0049";

function reportFailure(error) {
  console.error(`\n${describeFailure(error)}`);
}

async function main() {
  // --- 1. Preflight + target validation --------------------------------
  const repairSql = fs.readFileSync(REPAIR_MIGRATION_PATH, "utf8");
  const actualHash = createHash("sha256").update(repairSql).digest("hex");
  if (actualHash !== EXPECTED_REPAIR_SHA256) {
    throw new PhaseError(
      "preflight",
      `The repair migration's content does not match what was rehearsed and recorded in docs/AI-HANDOFF.md (expected sha256 ${EXPECTED_REPAIR_SHA256}, got ${actualHash}). Re-rehearse (tests/calendar-schema-repair-rehearsal.test.mjs on Linux CI) before updating this constant and re-running.`,
    );
  }
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN must be set.");
  assert.ok(process.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID must be set.");
  assert.ok(process.env.BACKUP_ENCRYPTION_PASSPHRASE, "BACKUP_ENCRYPTION_PASSPHRASE must be set -- both backups must be retained encrypted, never in plaintext.");
  assert.ok(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY, "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (the R2 backup-write credential) must be set.");
  assert.ok(process.env.R2_BACKUP_BUCKET, "R2_BACKUP_BUCKET must be set.");
  console.log(`Preflight OK. Repair migration sha256=${actualHash}.`);

  const retentionDeps = buildRealRetentionDeps({
    bucket: process.env.R2_BACKUP_BUCKET,
    endpointUrl: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    passphrase: process.env.BACKUP_ENCRYPTION_PASSPHRASE,
  });

  let dispose = async () => {};
  try {
    const target = await connectAndValidateStagingTarget().catch((error) => { throw new PhaseError("target-validation", error.message, { cause: error }); });
    const db = target.db;
    dispose = target.dispose;

    // --- 2. Full recoverable backup, BEFORE anything changes -----------
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupBeforePath = path.join(root, `staging-backup-before-0049-${timestamp}.sql`);
    console.log(`Exporting full Staging backup to ${backupBeforePath}...`);
    try {
      wrangler(["d1", "export", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--output", backupBeforePath]);
      assert.ok(fs.existsSync(backupBeforePath) && fs.statSync(backupBeforePath).size > 0, "Pre-repair backup export is missing or empty.");
    } catch (error) {
      throw new PhaseError("pre-repair-backup", `Could not take the pre-repair backup: ${error.message}`, { cause: error });
    }
    console.log(`Backup complete: ${backupBeforePath} (kept; never deleted by this script).`);

    // --- 3. Verify the backup is actually recoverable, in isolation ----
    console.log("Restoring the pre-repair backup into an isolated LOCAL database (no remote access) and comparing against a fresh read of Staging...");
    try {
      const backupSqlText = fs.readFileSync(backupBeforePath, "utf8");
      const liveNow = await snapshotCalendarTablesViaBinding(db);
      const verification = verifyBackupRestoresAndMatches(backupSqlText, liveNow, () => new DatabaseSync(":memory:"));
      assert.ok(verification.matches, `The restored backup's rows do not match a fresh read of Staging (${verification.mismatchReason}) -- the backup may not be trustworthy.`);
      console.log(`Backup verified recoverable: ${verification.restored.links.length} link row(s) and ${verification.restored.history.length} history row(s) restored and matched exactly.`);
    } catch (error) {
      throw new PhaseError("pre-repair-restore-check", `The pre-repair backup did not restore and verify cleanly: ${error.message}`, { cause: error });
    }

    // --- 4. Before snapshot ---------------------------------------------
    console.log("Capturing calendar_event_links/calendar_event_link_history before the repair (via the validated binding)...");
    let before;
    try {
      before = await snapshotCalendarTablesViaBinding(db);
    } catch (error) {
      throw new PhaseError("before-snapshot", error.message, { cause: error });
    }
    console.log(`Before: ${before.links.length} link row(s), ${before.history.length} history row(s).`);

    // --- 5. Retain the pre-repair backup encrypted in R2, THEN apply the
    //        repair via a single db.batch() -- structurally gated: see
    //        applyRepairBatchGuardedByRetention()'s own header for why
    //        db.batch() is unreachable unless retention reports success.
    console.log("Encrypting and uploading the pre-repair backup to R2, and independently verifying the uploaded object, before any mutation is attempted...");
    const statements = splitSqlStatements(repairSql);
    assert.ok(statements.length >= 14, "Parsed an unexpectedly small number of statements out of the repair migration -- aborting rather than applying a truncated batch.");
    let preRepairRetention;
    try {
      preRepairRetention = await applyRepairBatchGuardedByRetention(db, statements, () => retainBackupSecurely(backupBeforePath, R2_BACKUP_KEY_PREFIX, retentionDeps));
    } catch (error) {
      if (error instanceof PhaseError) throw error;
      throw new PhaseError("repair-batch", `The repair batch failed: ${error.message}`, { cause: error });
    }
    console.log(`Pre-repair backup retained: ${preRepairRetention.remoteKey}`);
    console.log(`Applied ${statements.length} statements in one batch.`);

    // --- 6. After snapshot, must be byte-for-byte identical --------------
    console.log("Re-capturing calendar_event_links/calendar_event_link_history after the repair...");
    let after;
    try {
      after = await snapshotCalendarTablesViaBinding(db);
      assert.deepEqual(after.links, before.links, "Row/column mismatch in calendar_event_links after the repair.");
      assert.deepEqual(after.history, before.history, "Row/column mismatch in calendar_event_link_history after the repair.");
    } catch (error) {
      throw new PhaseError("post-batch-row-check", error.message, { cause: error });
    }
    console.log("Row/column preservation confirmed: every row in both tables is unchanged.");

    // --- 7. foreign_key_check / integrity_check via the CLI/HTTP path -----
    try {
      console.log("Running PRAGMA foreign_key_check against Staging...");
      const fkViolations = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--command", "PRAGMA foreign_key_check;"])?.[0]?.results ?? [];
      assert.deepEqual(fkViolations, [], `PRAGMA foreign_key_check reported violations after the repair: ${JSON.stringify(fkViolations)}`);

      console.log("Running PRAGMA integrity_check against Staging...");
      const integrity = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--command", "PRAGMA integrity_check;"])?.[0]?.results?.[0]?.integrity_check;
      assert.equal(integrity, "ok", `PRAGMA integrity_check did not return "ok": ${integrity}`);
      console.log("foreign_key_check clean, integrity_check ok.");
    } catch (error) {
      throw new PhaseError("fk-integrity-check", error.message, { cause: error });
    }

    // --- 8. Schema-health check against the packaged baseline ------------
    try {
      console.log("Validating Staging's live schema against the packaged production baseline manifest...");
      const schemaRows = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--command", "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name;"])?.[0]?.results ?? [];
      const comparison = compareSchemaObjects(stagingSchemaObjects(schemaRows));
      assert.equal(comparison.matches, true, `Staging's schema still does not match the baseline after the repair: ${comparison.differences.join(" ")}`);
      console.log("Schema-health check: Staging now matches the packaged baseline exactly.");
    } catch (error) {
      throw new PhaseError("schema-health-check", error.message, { cause: error });
    }

    // --- 10. Second backup + the real remote-restore verification --------
    const backupAfterPath = path.join(root, `staging-backup-after-0049-${timestamp}.sql`);
    try {
      console.log(`Exporting post-repair Staging backup to ${backupAfterPath}...`);
      wrangler(["d1", "export", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--output", backupAfterPath]);
      console.log("Running the proven remote-restore verification (scripts/verify-remote-restore.mjs) against the post-repair backup...");
      const restoreVerify = spawnSync(process.execPath, ["scripts/verify-remote-restore.mjs", "--", backupAfterPath], { cwd: root, encoding: "utf8", env: process.env, stdio: "inherit" });
      assert.equal(restoreVerify.status, 0, "Post-repair backup failed real remote-restore verification.");
    } catch (error) {
      throw new PhaseError("post-repair-restore-check", error.message, { cause: error });
    }

    // --- 11. Retain the post-repair backup encrypted in R2 -- a failure
    //         here FAILS THE JOB (never a silent success) but never
    //         implies the already-verified repair itself should be
    //         reverted; see this file's own header for why.
    console.log("Encrypting and uploading the post-repair backup to R2, and independently verifying the uploaded object...");
    const postRepairRetention = retainBackupSecurely(backupAfterPath, R2_BACKUP_KEY_PREFIX, retentionDeps);
    if (!postRepairRetention.ok) {
      throw new PhaseError("post-repair-retention", `The post-repair backup could not be retained securely: ${postRepairRetention.reason}`);
    }
    console.log(`Post-repair backup retained: ${postRepairRetention.remoteKey}`);

    console.log("\nDone. Staging's calendar_event_links/calendar_event_link_history schema text is repaired, every row survived unchanged, and the fix restores cleanly on a real scratch D1 database.");
    console.log(`Pre-repair backup retained at: ${preRepairRetention.remoteKey}`);
    console.log(`Post-repair backup retained at: ${postRepairRetention.remoteKey}`);
  } finally {
    await dispose();
  }
}

// A real dispatched run found that a failed getPlatformProxy() remote-
// session startup can leave an orphaned local process running even
// after main() itself has already caught the error and finished
// reporting it -- GitHub Actions had to cancel the job after its own
// 20-minute job-level timeout, ~21 minutes after the real error was
// already printed. Forcing process.exit() here, only once main() has
// FULLY settled (including its own `finally { await dispose() }`),
// terminates the job promptly regardless of what a third-party
// dependency's internals left dangling -- see
// lib/operations/calendar-schema-repair-apply.ts's withStartupTimeout()
// for the companion fix (a bounded timeout for the OTHER possible
// failure mode: the same call hanging instead of rejecting quickly).
main()
  .then(() => process.exit(0))
  .catch((error) => {
    reportFailure(error);
    process.exit(1);
  });
