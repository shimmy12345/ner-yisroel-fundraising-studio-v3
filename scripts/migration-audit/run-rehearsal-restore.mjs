// Restores the per-table files built by build-rehearsal-restore-files.mjs
// into a rehearsal D1 database, in the manifest's own FK-safe order.
// STOPS on the first failure -- never retries, never skips silently.
// Prints only table names/row counts, never row content.
//
// Usage: node scripts/migration-audit/run-rehearsal-restore.mjs <database-name> <restoreDir>
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [db, restoreDir] = process.argv.slice(2);
if (!db || !restoreDir) throw new Error("Usage: node run-rehearsal-restore.mjs <database-name> <restoreDir>");
const repoRoot = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(restoreDir, "manifest.json"), "utf8"));

function wrangler(args) {
  return execSync(`npx --yes wrangler@4.92.0 ${args}`, { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

for (const entry of manifest.tables) {
  if (!entry.file) { console.log(`SKIP ${entry.table} (${entry.rows} rows) -- ${entry.skipped}`); continue; }
  const filePath = path.resolve(restoreDir, entry.file);
  console.log(`Restoring ${entry.table} (${entry.rows} rows, ${entry.bytes} bytes)...`);
  try {
    wrangler(`d1 execute ${db} --remote --file="${filePath}" --yes`);
  } catch (err) {
    console.error(`FAILED restoring ${entry.table}: STOPPING (no retry, no skip).`);
    console.error(err.stdout || err.message);
    console.error(err.stderr || "");
    process.exit(1);
  }
  console.log(`  OK: ${entry.table}`);
}
console.log("All data files applied.");
