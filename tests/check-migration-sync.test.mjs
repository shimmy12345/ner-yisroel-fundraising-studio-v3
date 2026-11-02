import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CANONICAL_BRANCH } from "../lib/operations/canonical-branch.ts";
import { diffMigrationLists } from "../lib/operations/restore-drift-guard.ts";
import { filterRealMigrationFiles } from "../scripts/check-migration-sync.mjs";

// Fix Stale Branch References and Verify Restore Safeguards (2026-11-02,
// see docs/AI-HANDOFF.md). Covers the explicit verification checklist for
// scripts/check-migration-sync.mjs: it evaluates the correct (current,
// non-stale) branch; it detects the genuine migration 0056 discrepancy
// between main and the working branch; it does not report success when
// genuine drift exists; it passes for equivalent migration histories;
// and it still ignores intentionally unapplied drizzle/pending-review/
// migrations.

const root = path.resolve(import.meta.dirname, "..");
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

// ---- 1. filterRealMigrationFiles: pure, offline, synthetic cases ----

{
  const listing = [
    "drizzle/0001_a.sql",
    "drizzle/0002_b.sql",
    "drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql",
    "drizzle/_journal.json",
    "drizzle/meta/_journal.json",
  ].join("\n");
  const result = filterRealMigrationFiles(listing);
  assert.deepEqual(result, ["0001_a.sql", "0002_b.sql"], "must exclude drizzle/pending-review/ migrations and non-migration files (_journal.json), by directory component -- not merely by basename shape");
}
{
  // Sorted output, regardless of input order.
  const listing = ["drizzle/0003_c.sql", "drizzle/0001_a.sql", "drizzle/0002_b.sql"].join("\n");
  assert.deepEqual(filterRealMigrationFiles(listing), ["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
}
{
  // Blank lines and whitespace must never produce a phantom entry.
  assert.deepEqual(filterRealMigrationFiles("\n  \ndrizzle/0001_a.sql\n\n"), ["0001_a.sql"]);
}

// ---- 2. "evaluates the correct branch": CANONICAL_BRANCH must be the real, current, active branch ----

{
  const currentBranch = git(["branch", "--show-current"]).trim();
  assert.equal(CANONICAL_BRANCH, currentBranch, `CANONICAL_BRANCH (${CANONICAL_BRANCH}) must match this session's own real, current working branch (${currentBranch}) -- confirmed this round to be the branch main's manifest already reflects and every recent Production deployment was cut from.`);
}

// ---- 3-5. Real-world drift detection, using REAL, read-only git data (no checkout, no write) ----

function realCanonicalMigrationFiles() {
  const ref = `refs/remotes/origin/${CANONICAL_BRANCH}`;
  try {
    git(["rev-parse", "--verify", ref]);
  } catch {
    git(["fetch", "--depth", "1", "origin", CANONICAL_BRANCH]);
  }
  return filterRealMigrationFiles(git(["ls-tree", "-r", "--name-only", ref, "--", "drizzle/"]));
}

function realMainMigrationFiles() {
  try {
    git(["rev-parse", "--verify", "refs/remotes/origin/main"]);
  } catch {
    git(["fetch", "--depth", "1", "origin", "main"]);
  }
  const manifestText = git(["show", "refs/remotes/origin/main:production-baseline/schema-manifest.json"]);
  return [...JSON.parse(manifestText).sourceMigrations].sort();
}

const realCanonical = realCanonicalMigrationFiles();
const realMain = realMainMigrationFiles();

// 3. Detects the genuine migration 0056 discrepancy.
{
  const { onlyOnFeature: missingFromMain } = diffMigrationLists(realCanonical, realMain);
  assert.ok(missingFromMain.includes("0056_trip_archive_delete.sql"), `Expected 0056_trip_archive_delete.sql to be reported missing from main's real committed manifest; got: ${JSON.stringify(missingFromMain)}. If this now passes, main has been synced -- update this test's expectation deliberately, never loosen the comparison to make it pass.`);
}

// 4. Does not report success (an empty missing list) when this genuine drift exists.
{
  const { onlyOnFeature: missingFromMain } = diffMigrationLists(realCanonical, realMain);
  assert.ok(missingFromMain.length > 0, "Real drift exists (migration 0056) -- the comparison must not report zero missing migrations.");
}

// 5. Ignores intentionally unapplied migrations in drizzle/pending-review/:
// 0049 must never appear on either side of the real comparison above (it
// is excluded from realCanonical by filterRealMigrationFiles, and was
// never a real migration main could be "missing" in the first place).
{
  assert.ok(!realCanonical.includes("0049_fix_calendar_schema_text_staging_repair.sql"), "0049 (a drizzle/pending-review/ draft) must never be treated as a real canonical migration.");
  const { onlyOnFeature: missingFromMain } = diffMigrationLists(realCanonical, realMain);
  assert.ok(!missingFromMain.includes("0049_fix_calendar_schema_text_staging_repair.sql"), "0049 must never be reported as 'missing from main' -- this is the exact real-world false positive (GitHub Actions run 41322245940, 2026-11-01) this filter exists to prevent.");
}

// ---- 6. Passes when comparing equivalent migration histories ----
{
  // A synthetic main manifest that already has every migration the real
  // canonical branch has (plus one of its own, order-irrelevant) -- must
  // report zero missing, proving the comparison is not merely always-fail.
  const equivalentMain = [...realCanonical, "9999_unrelated_main_only_migration.sql"];
  const { onlyOnFeature: missingFromMain } = diffMigrationLists(realCanonical, equivalentMain);
  assert.deepEqual(missingFromMain, [], "When main's manifest already has every migration the canonical branch has, nothing should be reported missing.");
}

process.stdout.write("check-migration-sync.test.mjs: all assertions passed\n");
