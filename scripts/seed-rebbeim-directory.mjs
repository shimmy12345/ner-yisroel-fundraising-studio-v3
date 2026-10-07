// Idempotent seed for the canonical Rebbeim directory (Donor Rebbeim --
// see docs/AI-HANDOFF.md). The names below are the user's own explicitly
// approved master list, verbatim -- never "corrected" or expanded
// without separate approval. This script only ever INSERTs a name that
// does not already exist (matched by the same normalized-name comparison
// the app itself uses, lib/relationships/rebbeim.ts's normalizeRebbiName)
// -- it never deletes, renames, or recreates an existing row, so it is
// safe to re-run.
//
// 2026-10-07: expanded from 41 to 43. "Harav Sax" and "Harav Yosef Kalman
// Neuberger" were found to be legitimate Rebbeim while reviewing the
// completed donor/Rebbeim assignment workbook, approved by the user as
// intentional additions to the canonical directory (not a donor
// assignment import, which remains a separate, later, explicitly-
// reviewed step). Both normalize to values distinct from all 41 original
// entries, confirmed before adding -- "Harav Yosef Kalman Neuberger" in
// particular is NOT the same person as the already-seeded "Harav Yosef
// Neuberger": the middle name "Kalman" makes their normalized forms
// different, so this is a genuinely distinct 42nd Rebbi, not a duplicate.
//
// This does NOT assign any donor to any Rebbi -- see the separate
// donor-code/Rebbeim bulk-assignment import for that, a deliberately
// distinct, explicitly-reviewed step.
//
// Usage:
//   node scripts/seed-rebbeim-directory.mjs           (dry run)
//   node scripts/seed-rebbeim-directory.mjs --apply    (write)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRebbiName } from "../lib/relationships/rebbeim.ts";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG_PATH = path.join(root, "wrangler.staging.jsonc");
const EXPECTED_USER_ID = "user_sgoldstein@nirc.edu";

// --- The approved master list, verbatim. ---
const CANONICAL_REBBEIM = [
  "Harav Ruderman", "Harav Weinberg", "Harav Kulefsky", "Harav Kronglas",
  "Harav Naftali Neuberger", "Harav Sheftel Neuberger", "Harav Feldman",
  "Harav Beryl", "Harav Boruch Neuberger", "Harav Ezra Neuberger",
  "Harav Avraham Chaim", "Harav Frand", "Harav Moshe Mintz",
  "Harav Einstadter", "Harav Jurkowitz", "Harav Nusbaum", "Harav Steinhardt",
  "Harav Berkowitz", "Harav Shraga Neuberger", "Harav Gold", "Harav Kosman",
  "Harav Cook", "Harav Yosef Tendler", "Harav Ahron Tendler", "Harav Weinreb",
  "Harav Yosef Neuberger", "Harav Friedman", "Harav Tabrikian", "Harav Wenger",
  "Harav Zalman Mintz", "Harav Eisgrau", "Harav Melman", "Harav Adler",
  "Harav Shafran", "Harav Salb", "Harav Weiner", "Harav Rosenbaum",
  "Harav Moshe Hillel Glazer", "Harav Lansky", "Harav Hakkakian", "Harav Krakauer",
  // Added 2026-10-07 -- see the file header comment above.
  "Harav Sax", "Harav Yosef Kalman Neuberger",
];

const wranglerBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.CMD" : "wrangler");
const winQuote = (value) => (process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : value);

function wranglerJson(sql) {
  const flatSql = sql.replace(/\s+/g, " ").trim();
  const args = ["d1", "execute", DB_NAME, "--remote", "--config", CONFIG_PATH, "--command", flatSql, "--json"].map(winQuote);
  const result = spawnSync(wranglerBin, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error) throw new Error(`Failed to spawn wrangler: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed:\n${(result.stderr || result.stdout || "").trim()}`);
  const lines = result.stdout.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate); } catch { /* keep scanning */ }
  }
  throw new Error(`Could not find JSON in wrangler output for query:\n${sql}\n${result.stdout}`);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function fetchExistingRebbeim() {
  const rows = wranglerJson(`SELECT id, display_name, normalized_name FROM rebbeim WHERE user_id = ${sqlString(EXPECTED_USER_ID)}`)[0].results;
  return rows;
}

// Pure planning logic -- no I/O -- exercised directly by
// tests/rebbeim-directory.test.mjs to prove idempotency and canonical-list
// correctness without touching any real database. Given the full set of
// already-existing rebbeim rows (normalized_name + id), returns exactly
// which canonical names still need inserting, which already exist, and
// which existing rows aren't part of this script's own list at all
// (never touched/removed -- only reported).
export function planRebbeimSeed(existingRows) {
  const existingByNormalized = new Map(existingRows.map((row) => [row.normalized_name, row]));
  const toInsert = [];
  const alreadyPresent = [];
  for (const displayName of CANONICAL_REBBEIM) {
    const normalized = normalizeRebbiName(displayName);
    const match = existingByNormalized.get(normalized);
    if (match) alreadyPresent.push({ displayName, normalized, existing: match });
    else toInsert.push({ displayName, normalized });
  }
  const canonicalNormalized = new Set(CANONICAL_REBBEIM.map(normalizeRebbiName));
  const extra = existingRows.filter((row) => !canonicalNormalized.has(row.normalized_name));
  return { toInsert, alreadyPresent, extra };
}

function dryRun() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const existing = fetchExistingRebbeim();
  const plan = planRebbeimSeed(existing);
  for (const { displayName } of plan.alreadyPresent) console.log(`${displayName}: ALREADY EXISTS`);
  for (const { displayName } of plan.toInsert) console.log(`${displayName}: will be inserted`);
  if (plan.extra.length > 0) {
    console.log(`\nNote: ${plan.extra.length} existing rebbeim row(s) not in this script's list (never touched/removed by this script):`);
    for (const row of plan.extra) console.log(`  - ${row.display_name} (${row.id})`);
  }
  console.log(`\n${plan.alreadyPresent.length} already present, ${plan.toInsert.length} to insert, ${CANONICAL_REBBEIM.length} total in the canonical list.`);
  return { existing, toInsert: plan.toInsert.length };
}

function applySeed() {
  console.log(`Re-reading fresh state immediately before write...\n`);
  const existing = fetchExistingRebbeim();
  const plan = planRebbeimSeed(existing);
  let inserted = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const { displayName } of plan.alreadyPresent) console.log(`${displayName}: ALREADY_PRESENT`);
  for (const { displayName, normalized } of plan.toInsert) {
    const id = crypto.randomUUID();
    const insert = `INSERT INTO rebbeim (id, user_id, display_name, normalized_name, created_at, updated_at)
      SELECT ${sqlString(id)}, ${sqlString(EXPECTED_USER_ID)}, ${sqlString(displayName)}, ${sqlString(normalized)}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM rebbeim WHERE user_id = ${sqlString(EXPECTED_USER_ID)} AND normalized_name = ${sqlString(normalized)})`;
    const result = wranglerJson(insert);
    const changes = result?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) { console.log(`${displayName}: FAILED_CLOSED -- insert affected ${changes} rows, expected 1 (likely a concurrent insert).`); continue; }
    console.log(`${displayName}: INSERTED -- ${id}`);
    inserted++;
  }
  console.log(`\n${inserted} inserted, ${plan.alreadyPresent.length} already present, ${CANONICAL_REBBEIM.length} total.`);
  return { inserted, alreadyPresent: plan.alreadyPresent.length };
}

async function runCli() {
  const apply = process.argv.includes("--apply");
  if (!apply) { dryRun(); return; }
  applySeed();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

export { CANONICAL_REBBEIM, EXPECTED_USER_ID, dryRun, applySeed };
