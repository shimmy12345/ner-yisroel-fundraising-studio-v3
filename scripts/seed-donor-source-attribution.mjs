// Generic, reusable seeding tool for `donor_source_attributions` -- the
// "known third-party source" mapping used by the JL donation importer
// (lib/import/donor-source-attribution.ts) to SUGGEST an FOS donor when a
// gift is recorded in JL under a third party's own household code (e.g. an
// employer or donor-advised-fund account), never to auto-attribute one.
//
// This script is intentionally NOT specific to any one relationship -- the
// CONFIG list below is the only place a specific mapping (like Price
// Waterhouse Foundation -> Eitan Pfeiffer) is named, and it is data, not
// code. Nothing in lib/import or app/api/import ever hardcodes a source
// code or donor id; every future third-party source gets a new CONFIG
// entry here, never a new `if` branch in the importer.
//
// Same dry-run/--apply split and fresh-read-immediately-before-write
// pattern as scripts/ask-historical-backfill.mjs. Idempotent: the unique
// index on (user_id, external_source, source_external_id) means a guarded
// `INSERT ... WHERE NOT EXISTS` is safe to re-run.
//
// Usage:
//   node scripts/seed-donor-source-attribution.mjs           (dry run)
//   node scripts/seed-donor-source-attribution.mjs --apply    (write)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG_PATH = path.join(root, "wrangler.staging.jsonc");
const EXPECTED_USER_ID = "user_sgoldstein@nirc.edu";
const EXTERNAL_SOURCE = "JL Solutions";

// --- The explicit mapping config. Add future third-party sources here. ---
const CONFIG = [
  {
    sourceExternalId: "22297",
    sourceName: "Price Waterhouse Foundation",
    suggestedDonorCode: "48637",
    expectedDonorName: "Mr. & Mrs. Eitan Pfeiffer",
    note: "Employer/funding-source account that Eitan Pfeiffer's gifts are commonly recorded under in JL. Not every 22297 transaction belongs to him -- this is only the suggested attribution offered during import; each transaction still requires an explicit decision.",
  },
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
function sqlNullableString(value) {
  return value === null || value === undefined ? "NULL" : sqlString(value);
}

function fetchDonorByCode(donorCode) {
  const rows = wranglerJson(
    `SELECT id, display_name, donor_code, owner_user_id, data_source, archived_at FROM donors WHERE donor_code = ${sqlString(donorCode)}`,
  )[0].results;
  return rows[0] ?? null;
}

function fetchExistingAttribution(sourceExternalId) {
  const rows = wranglerJson(
    `SELECT id, source_name, suggested_donor_id, note FROM donor_source_attributions WHERE user_id = ${sqlString(EXPECTED_USER_ID)} AND external_source = ${sqlString(EXTERNAL_SOURCE)} AND source_external_id = ${sqlString(sourceExternalId)}`,
  )[0].results;
  return rows[0] ?? null;
}

// Never trusts CONFIG's expectedDonorName without cross-checking the live
// donor row first -- same "fresh read, hard equality, refuse to guess"
// contract as scripts/ask-historical-backfill.mjs's validateEntry().
function validateEntry(entry, { donor, existing }) {
  if (!donor) return { eligible: false, reason: `No donor found with donor_code '${entry.suggestedDonorCode}'.` };
  if (donor.data_source !== "live") return { eligible: false, reason: `Donor ${donor.id} is not data_source='live' (found '${donor.data_source}').` };
  if (donor.archived_at) return { eligible: false, reason: `Donor ${donor.id} is archived.` };
  if (donor.owner_user_id !== EXPECTED_USER_ID) return { eligible: false, reason: `Donor ${donor.id} owner_user_id is '${donor.owner_user_id}', expected '${EXPECTED_USER_ID}'.` };
  if (donor.display_name !== entry.expectedDonorName) {
    return { eligible: false, reason: `Donor ${donor.id} display_name is '${donor.display_name}', expected '${entry.expectedDonorName}' -- refusing to guess.` };
  }
  if (existing) {
    return { eligible: false, alreadyApplied: true, existing, reason: `A donor_source_attributions row (${existing.id}) already maps ${EXTERNAL_SOURCE}/${entry.sourceExternalId} -> suggested_donor_id ${existing.suggested_donor_id} -- already seeded, no-op.` };
  }
  return { eligible: true, reason: "Suggested donor found, live, unarchived, correctly owned, and name matches exactly; no existing mapping for this source.", donor };
}

function fetchState(entry) {
  const donor = fetchDonorByCode(entry.suggestedDonorCode);
  const existing = fetchExistingAttribution(entry.sourceExternalId);
  return { donor, existing };
}

function dryRun() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const rows = [];
  for (const entry of CONFIG) {
    const state = fetchState(entry);
    const result = validateEntry(entry, state);
    console.log(`Source: ${entry.sourceName} (${EXTERNAL_SOURCE} ${entry.sourceExternalId})`);
    console.log(`  Suggested donor: ${entry.expectedDonorName} (code ${entry.suggestedDonorCode})${state.donor ? ` -> ${state.donor.id}` : " -- NOT FOUND"}`);
    console.log(`  Existing mapping? ${state.existing ? `yes (${state.existing.id})` : "no"}`);
    console.log(`  Eligible to seed: ${result.eligible ? "YES" : `NO -- ${result.reason}`}`);
    console.log("");
    rows.push({ entry, state, result });
  }
  return rows;
}

function applySeed(entries = CONFIG, { fetchStateFn = fetchState, writeFn = wranglerJson, log = console.log } = {}) {
  log(`Re-validating fresh state for ${entries.length} mapping(s) immediately before write...\n`);
  const results = [];
  for (const entry of entries) {
    const state = fetchStateFn(entry);
    const result = validateEntry(entry, state);

    if (!result.eligible) {
      if (result.alreadyApplied) {
        results.push({ entry, status: "ALREADY_APPLIED", id: result.existing.id, reason: result.reason });
        log(`${entry.sourceName}: ALREADY_APPLIED (${result.existing.id})`);
        continue;
      }
      results.push({ entry, status: "FAILED_CLOSED", reason: result.reason });
      log(`${entry.sourceName}: FAILED_CLOSED -- ${result.reason}`);
      continue;
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const insert = `INSERT INTO donor_source_attributions (id, user_id, external_source, source_external_id, source_name, suggested_donor_id, note, created_at, updated_at)
      SELECT ${sqlString(id)}, ${sqlString(EXPECTED_USER_ID)}, ${sqlString(EXTERNAL_SOURCE)}, ${sqlString(entry.sourceExternalId)}, ${sqlString(entry.sourceName)}, ${sqlString(result.donor.id)}, ${sqlNullableString(entry.note)}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM donor_source_attributions WHERE user_id = ${sqlString(EXPECTED_USER_ID)} AND external_source = ${sqlString(EXTERNAL_SOURCE)} AND source_external_id = ${sqlString(entry.sourceExternalId)})`;

    const writeResult = writeFn(insert);
    const changes = writeResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.push({ entry, status: "FAILED_CLOSED", reason: `INSERT guarded by WHERE NOT EXISTS matched ${changes} rows to insert, expected 1 -- a concurrent writer likely created this mapping first between validation and write. Not treated as an error; re-run to confirm.` });
      log(`${entry.sourceName}: FAILED_CLOSED -- insert affected ${changes} rows.`);
      continue;
    }

    results.push({ entry, status: "APPLIED", id });
    log(`${entry.sourceName}: APPLIED -- ${id} -> suggested donor ${result.donor.id} (${result.donor.display_name}).`);
  }
  return results;
}

async function runCli() {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    dryRun();
    return;
  }
  const preRows = dryRun();
  if (!preRows.every((r) => r.result.eligible || r.result.alreadyApplied)) {
    console.log("STOP: not every mapping is eligible or already-applied. Refusing to apply.");
    process.exitCode = 1;
    return;
  }
  console.log("--- Applying ---\n");
  const results = applySeed();
  const failed = results.filter((r) => r.status === "FAILED_CLOSED").length;
  console.log(`\n${results.length - failed} ok, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

export { CONFIG, EXPECTED_USER_ID, EXTERNAL_SOURCE, validateEntry, fetchState, dryRun, applySeed };
