// D1 Migration Sync Automation -- the generator's CLI wrapper (see
// docs/D1-MIGRATION-SYNC-PROCESS.md for the full design). Read-only
// against D1/main except for writing the generated patch files to a
// local output directory: performs a `git fetch`/`git show` of main's
// committed restore/baseline files (the exact same loading pattern
// scripts/check-main-restore-sync.mjs already uses -- intentionally
// duplicated here, in full, rather than importing from that script,
// because that script must stay completely unchanged, never refactored
// to export anything, per its own role as the unmodified, authoritative
// drift check), calls the pure lib/operations/restore-sync-generator.ts
// decision, and either writes a safe patch's file contents to
// --out-dir or reports why it refused. Never touches D1, never pushes,
// never opens a PR -- that is scripts/open-or-update-sync-pr.mjs's own,
// separate job, so this script stays independently useful for the
// documented manual preflight step (run it locally before pushing a
// migration to see exactly what would be generated, with zero side
// effects of any kind).
//
// Usage: node scripts/prepare-main-restore-sync-patch.mjs [--out-dir <dir>]
// Always prints one JSON object to stdout describing the outcome.
// Exits 0 whenever it runs to completion (including a refusal -- a
// refusal is an expected, valid outcome, not a tool failure); exits
// non-zero only on an actual unexpected error (a crash), so callers must
// read the JSON's own `safe`/`alreadySynced` fields, never rely on the
// exit code alone, to decide what happened.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateBaseline } from "./generate-production-baseline.mjs";
import { planRestoreSyncPatch, renderProductionBaselineTsPatch } from "../lib/operations/restore-sync-generator.ts";

const root = path.resolve(import.meta.dirname, "..");
const MAIN_REF = process.env.MAIN_REF || "origin/main";
const outDirArgIndex = process.argv.indexOf("--out-dir");
const OUT_DIR = outDirArgIndex !== -1 ? path.resolve(process.argv[outDirArgIndex + 1]) : null;

// Identical to scripts/check-main-restore-sync.mjs's own MAIN_FILES list
// -- deliberately duplicated, not imported, for the same "that script
// never changes" reason explained above.
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
  return import(pathToFileURL(path.join(root, "lib/operations/d1-restore-order.ts")).href).then((restoreOrderModule) => ({
    ddlTopology: manifest.ddlTopology,
    sourceMigrations: manifest.sourceMigrations,
    restoreOrder: restoreOrderModule.D1_RESTORE_DATA_ORDER,
    skipDataTables: restoreOrderModule.D1_RESTORE_SKIP_DATA_TABLES,
  }));
}

// Reads the RAW SQL text of every migration file present on this branch
// but not on main's manifest -- straight from this branch's own working
// tree (never via `git show`, since these files by definition don't
// exist on main), so the generator's destructive-keyword scan sees the
// actual migration content.
function loadOnlyOnFeatureMigrationSql(migrationNames) {
  const result = {};
  for (const name of migrationNames) {
    result[name] = fs.readFileSync(path.join(root, "drizzle", name), "utf8");
  }
  return result;
}

async function main() {
  ensureMainRefAvailable();
  const mainResolvedSha = git(["rev-parse", MAIN_REF]).trim();

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-main-restore-sync-"));
  try {
    extractMainFiles(tempDirectory);
    const [featureState, mainState] = await Promise.all([loadFeatureState(), loadMainState(tempDirectory)]);

    const onlyOnFeatureMigrations = featureState.sourceMigrations.filter((migration) => !mainState.sourceMigrations.includes(migration));
    const migrationSqlByFile = loadOnlyOnFeatureMigrationSql(onlyOnFeatureMigrations);

    const plan = planRestoreSyncPatch(featureState, mainState, migrationSqlByFile);

    if (plan.safe && plan.alreadySynced) {
      console.log(JSON.stringify({ mainRef: MAIN_REF, mainSha: mainResolvedSha, safe: true, alreadySynced: true }, null, 2));
      return;
    }

    if (!plan.safe) {
      console.log(JSON.stringify({ mainRef: MAIN_REF, mainSha: mainResolvedSha, safe: false, reason: plan.reason }, null, 2));
      return;
    }

    // Safe patch: render the one text-patched file and copy the manifest
    // verbatim. Only ever writes to --out-dir (a local, caller-chosen
    // directory) -- never to this repository's own working tree, and
    // never touches git at all beyond the read-only operations above.
    const oldProductionBaselineTs = fs.readFileSync(path.join(tempDirectory, "lib/data-health/production-baseline.ts"), "utf8");
    const rendered = renderProductionBaselineTsPatch(oldProductionBaselineTs, plan.newMigrationCount, plan.migrations, new Date().toISOString());
    if (!rendered.ok) {
      console.log(JSON.stringify({ mainRef: MAIN_REF, mainSha: mainResolvedSha, safe: false, reason: rendered.reason }, null, 2));
      return;
    }

    const manifestText = fs.readFileSync(path.join(root, "production-baseline/schema-manifest.json"), "utf8");

    if (OUT_DIR) {
      fs.mkdirSync(path.join(OUT_DIR, "lib/data-health"), { recursive: true });
      fs.mkdirSync(path.join(OUT_DIR, "production-baseline"), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "lib/data-health/production-baseline.ts"), rendered.newText);
      fs.writeFileSync(path.join(OUT_DIR, "production-baseline/schema-manifest.json"), manifestText);
    }

    console.log(JSON.stringify({
      mainRef: MAIN_REF,
      mainSha: mainResolvedSha,
      safe: true,
      alreadySynced: false,
      migrations: plan.migrations,
      newMigrationCount: plan.newMigrationCount,
      filesWritten: OUT_DIR ? ["lib/data-health/production-baseline.ts", "production-baseline/schema-manifest.json"] : [],
      outDir: OUT_DIR,
    }, null, 2));
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

await main();
