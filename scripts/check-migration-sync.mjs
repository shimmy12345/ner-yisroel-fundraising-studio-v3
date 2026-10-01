// Cheap, secondary preflight for the monthly D1 restore-verification
// workflow -- the PRIMARY, early-detection guard is
// scripts/check-main-restore-sync.mjs on feature/independent-cloudflare-
// sandbox (the branch that owns the real schema), which runs on every
// schema-relevant push to that branch, not once a month. This script is
// the backstop: a last check, run on `main` itself immediately before
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CANONICAL_BRANCH = process.env.CANONICAL_BRANCH || "feature/independent-cloudflare-sandbox";
const CANONICAL_REMOTE_REF = `refs/remotes/origin/${CANONICAL_BRANCH}`;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
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
  const listing = git(["ls-tree", "-r", "--name-only", ref, "--", "drizzle/"]);
  return listing.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => path.basename(line)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function mainMigrationFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "production-baseline/schema-manifest.json"), "utf8"));
  return [...manifest.sourceMigrations].sort();
}

const canonical = canonicalMigrationFiles();
const current = mainMigrationFiles();
const currentSet = new Set(current);
const missingFromMain = canonical.filter((migration) => !currentSet.has(migration));

if (missingFromMain.length > 0) {
  console.error(`D1 restore metadata on main is out of sync with the canonical schema. Sync main before relying on monthly restore verification.\n`);
  console.error(`Migrations present on ${CANONICAL_BRANCH} but missing from this branch's production-baseline/schema-manifest.json:`);
  for (const migration of missingFromMain) console.error(`  - ${migration}`);
  console.error(`\nRun the full guard (scripts/check-main-restore-sync.mjs, on ${CANONICAL_BRANCH}) for a complete drift report, then sync and land the narrow restore/baseline update on main.`);
  process.exitCode = 1;
} else {
  console.log(`main's migration count/list (${current.length}) is current with ${CANONICAL_BRANCH}'s drizzle/ directory (${canonical.length}). Proceeding.`);
}
