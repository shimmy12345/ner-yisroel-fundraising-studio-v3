// Cheap, secondary preflight for the monthly D1 restore-verification
// workflow -- the PRIMARY, early-detection guard is
// scripts/check-main-restore-sync.mjs on the canonical branch (see
// lib/operations/canonical-branch.ts), which runs on every schema-
// relevant push to that branch, not once a month. This script is the
// backstop: a last check, run on `main` itself immediately before
// downloading/decrypting a real backup, that this repository's own
// committed migration count/list has not silently fallen behind the
// canonical branch's real drizzle/*.sql directory. It catches exactly the
// proximate cause of GitHub Actions run 36887668901 (a new migration
// landed on the canonical branch without main being synced) cheaply --
// one `git ls-tree` of the remote branch's `drizzle/` directory plus a
// JSON read, no schema replay, no node:sqlite, no D1 access.
//
// Usage: node scripts/check-migration-sync.mjs
// Exits 1 with a precise message if the canonical branch has a migration
// main's manifest does not yet know about. Exits 0 otherwise. Never
// checks out, modifies, or pushes anything; only reads a remote ref's
// tree listing and this repository's own already-committed manifest.
//
// The canonical branch name itself is never hardcoded here -- see
// lib/operations/canonical-branch.ts, this repository's single source of
// truth for which branch currently owns the real schema (2026-11-02, see
// docs/AI-HANDOFF.md's "Fix Stale Branch References and Verify Restore
// Safeguards" entry: this script's own previous hardcoded default had
// fallen behind the real canonical branch for over a month without
// anyone noticing, since it happened to still pass -- not because
// nothing had changed, but because the stale reference it compared
// against was itself missing the same newer migrations main was).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CANONICAL_BRANCH } from "../lib/operations/canonical-branch.ts";
import { diffMigrationLists } from "../lib/operations/restore-drift-guard.ts";

const root = path.resolve(import.meta.dirname, "..");
const CANONICAL_REMOTE_REF = `refs/remotes/origin/${CANONICAL_BRANCH}`;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

// Pure, dependency-free filter from a raw `git ls-tree` listing to the
// sorted list of real migration FILENAMES -- never checks out or reads
// file contents, just names. drizzle/pending-review/ holds gated,
// not-yet-promoted repair migrations (e.g. 0049_fix_calendar_schema_
// text_staging_repair.sql -- applied to Staging only via an explicit,
// separately-confirmed workflow_dispatch input, never part of the normal
// migration sequence) -- excluded here by directory component, not just
// basename shape, so this cheap preflight matches
// scripts/check-main-restore-sync.mjs's own generateBaseline(), which
// also never includes a pending-review migration in sourceMigrations.
// Real GitHub Actions run 41322245940 (2026-11-01) wrongly flagged 0049
// as "missing from main" because this filter previously matched on
// basename alone, which matches a pending-review file's name too.
export function filterRealMigrationFiles(treeListing) {
  return treeListing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.split("/").includes("pending-review"))
    .map((line) => path.basename(line))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function canonicalMigrationFiles() {
  try {
    git(["rev-parse", "--verify", CANONICAL_REMOTE_REF]);
  } catch {
    git(["fetch", "--depth", "1", "origin", CANONICAL_BRANCH]);
  }
  const ref = (() => {
    try {
      git(["rev-parse", "--verify", CANONICAL_REMOTE_REF]);
      return CANONICAL_REMOTE_REF;
    } catch {
      return "FETCH_HEAD";
    }
  })();
  return filterRealMigrationFiles(git(["ls-tree", "-r", "--name-only", ref, "--", "drizzle/"]));
}

function mainMigrationFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "production-baseline/schema-manifest.json"), "utf8"));
  return [...manifest.sourceMigrations].sort();
}

// Guarded behind an entry-point check (the same pattern already used by
// scripts/ask-historical-backfill.mjs and others in this repository) so
// this file can also be imported for its exported, pure
// filterRealMigrationFiles() -- e.g. by tests/check-migration-sync.test.mjs
// -- without triggering a real git/filesystem check as a side effect of
// that import.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const canonical = canonicalMigrationFiles();
  const current = mainMigrationFiles();
  const { onlyOnFeature: missingFromMain } = diffMigrationLists(canonical, current);

  if (missingFromMain.length > 0) {
    console.error(`D1 restore metadata on main is out of sync with the canonical schema. Sync main before relying on monthly restore verification.\n`);
    console.error(`Migrations present on ${CANONICAL_BRANCH} but missing from this branch's production-baseline/schema-manifest.json:`);
    for (const migration of missingFromMain) console.error(`  - ${migration}`);
    console.error(`\nRun the full guard (scripts/check-main-restore-sync.mjs, on ${CANONICAL_BRANCH}) for a complete drift report, then sync and land the narrow restore/baseline update on main.`);
    process.exitCode = 1;
  } else {
    console.log(`main's migration count/list (${current.length}) is current with ${CANONICAL_BRANCH}'s drizzle/ directory (${canonical.length}). Proceeding.`);
  }
}
