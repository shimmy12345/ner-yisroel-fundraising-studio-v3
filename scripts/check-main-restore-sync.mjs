// Generic D1 restore/schema drift guard -- the preventative check for the
// failure class behind GitHub Actions run 36887668901 (D1 monthly restore
// verification, 2026-10-01): main's manually synced restore-order/
// baseline tracking fell one migration behind this branch's real schema
// (donor_source_attributions, migration 0036), and nothing caught it
// until the next scheduled monthly restore test. This compares THIS
// branch's current, freshly-generated schema/restore state (the
// authoritative source -- this branch owns fundraising-os-staging-db)
// against `origin/main`'s COMMITTED restore-order/baseline files, using
// the same generic, derived comparison
// (lib/operations/restore-drift-guard.ts) that tests/restore-drift-guard.
// test.mjs exercises with synthetic fixtures. Never hardcodes a table
// name; works for any future migration.
//
// Usage: node scripts/check-main-restore-sync.mjs
// Exits 1 (and prints a precise report) on any drift; exits 0 when main's
// restore/baseline tracking is current. Read-only: performs a `git fetch`
// of main's ref and reads its files via `git show`, never checks out or
// modifies the working tree, and never writes to D1 or any remote branch.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateBaseline } from "./generate-production-baseline.mjs";
import { compareCrossBranchRestoreState, formatDriftReport } from "../lib/operations/restore-drift-guard.ts";

const root = path.resolve(import.meta.dirname, "..");
const MAIN_REF = process.env.MAIN_REF || "origin/main";

// The exact relative-path shape main's own files import each other and
// the manifest with (see lib/operations/d1-restore-order.ts's `import {
// STAGING_RESET_TABLE_ORDER } from "./staging-reset.ts"` and
// lib/data-health/production-baseline.ts's `import manifest from
// "../../production-baseline/schema-manifest.json"`) -- mirrored here so
// the extracted copies resolve their own relative imports correctly
// without any rewriting.
const MAIN_FILES = [
  "lib/operations/staging-reset.ts",
  "lib/operations/d1-restore-order.ts",
  "lib/data-health/production-baseline.ts",
  "production-baseline/schema-manifest.json",
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function ensureMainRefAvailable() {
  try {
    git(["rev-parse", "--verify", MAIN_REF]);
  } catch {
    git(["fetch", "origin", "main"]);
  }
}

function extractMainFiles(destinationRoot) {
  for (const relativePath of MAIN_FILES) {
    const content = git(["show", `${MAIN_REF}:${relativePath}`]);
    const destination = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

async function loadMainState(destinationRoot) {
  const d1RestoreOrderModule = await import(pathToFileURL(path.join(destinationRoot, "lib/operations/d1-restore-order.ts")).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(destinationRoot, "production-baseline/schema-manifest.json"), "utf8"));
  return {
    ddlTopology: manifest.ddlTopology,
    sourceMigrations: manifest.sourceMigrations,
    restoreOrder: d1RestoreOrderModule.D1_RESTORE_DATA_ORDER,
    skipDataTables: d1RestoreOrderModule.D1_RESTORE_SKIP_DATA_TABLES,
  };
}

function loadFeatureState() {
  const { manifest } = generateBaseline();
  // This branch's own current D1_RESTORE_DATA_ORDER/D1_RESTORE_SKIP_DATA_TABLES
  // -- imported fresh, never assumed, so this script stays correct even
  // if this branch's own restore order changes shape.
  return import(pathToFileURL(path.join(root, "lib/operations/d1-restore-order.ts")).href).then((restoreOrderModule) => ({
    ddlTopology: manifest.ddlTopology,
    sourceMigrations: manifest.sourceMigrations,
    restoreOrder: restoreOrderModule.D1_RESTORE_DATA_ORDER,
    skipDataTables: restoreOrderModule.D1_RESTORE_SKIP_DATA_TABLES,
  }));
}

async function main() {
  ensureMainRefAvailable();
  const mainResolvedSha = git(["rev-parse", MAIN_REF]).trim();

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "d1-restore-sync-check-"));
  try {
    extractMainFiles(tempDirectory);
    const [featureState, mainState] = await Promise.all([loadFeatureState(), loadMainState(tempDirectory)]);
    const report = compareCrossBranchRestoreState(featureState, mainState);

    console.log(`Comparing this branch's current schema/restore state against ${MAIN_REF} (${mainResolvedSha.slice(0, 12)})...\n`);
    console.log(formatDriftReport(report));

    if (!report.inSync) {
      console.log(`\nSync main's lib/operations/staging-reset.ts, lib/operations/d1-restore-order.ts, lib/data-health/production-baseline.ts, and production-baseline/schema-manifest.json with this branch's current state, then re-run this check.`);
      process.exitCode = 1;
      return;
    }
    console.log("\nmain's restore/baseline tracking is current. No sync needed.");
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

await main();
