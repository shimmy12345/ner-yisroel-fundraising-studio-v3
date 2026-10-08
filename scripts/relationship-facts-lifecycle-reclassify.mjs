// Relationship Intelligence Phase 1 -- one-off maintenance pass for
// EXISTING `donor_relationship_facts` rows after a classifyFactLifecycle()
// fix (see lib/relationships/fact-classification.ts's COMPLETED_WELL_WISH_
// PATTERN, added 2026-10-08 after the Daily Fundraising Agenda surfaced
// stale "Reach out and reference" suggestions for completed well-wish
// touches that had been misclassified `durable`). A code-level classifier
// fix only changes what happens for FUTURE accepted facts -- it does
// nothing for rows already written with the old, wrong lifecycle value.
// This script finds every `status='current'` row whose stored lifecycle
// disagrees with what the CURRENT (fixed) classifyFactLifecycle() would
// produce for its own fact_text/category, and updates only `lifecycle` +
// `updated_at` -- never fact_text, category, status, source_interaction_
// id/occurred_at, or fingerprint (those are untouched facts about what
// was accepted and when, not about the lifecycle bug this script fixes).
//
// PREVIEW MODE (default, `node scripts/relationship-facts-lifecycle-
// reclassify.mjs`) is READ-ONLY: queries via `wrangler d1 execute --remote
// --json` (same pattern as scripts/relationship-facts-backfill-
// preview.mjs) and prints the exact plan. Never writes to D1.
//
// APPLY MODE (applyReclassification(), exposed for a separate, explicitly
// approved run -- never invoked by this file's own CLI entry point)
// re-fetches fresh, re-plans, and updates only rows whose fresh re-check
// still disagrees (the idempotency backstop: a re-run after a partial
// apply, or after someone else's concurrent edit, only ever touches rows
// still actually wrong).
//
// Usage: node scripts/relationship-facts-lifecycle-reclassify.mjs
// Reads fundraising-os-staging-db via `wrangler d1 execute --remote`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyFactLifecycle } from "../lib/relationships/fact-classification.ts";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG = path.join(root, "wrangler.staging.jsonc");

const wranglerBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.CMD" : "wrangler");
const winQuote = (value) => (process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : value);

function wranglerJson(sql) {
  const args = ["d1", "execute", DB_NAME, "--remote", "--config", CONFIG, "--command", sql, "--json"].map(winQuote);
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

// Fresh re-plan: fetch every current fact row, recompute lifecycle with
// the real, imported classifyFactLifecycle() against its own stored
// fact_text/category, and diff against the stored value. No D1 access
// inside the planning logic itself (kept pure/testable); fetchPlan() below
// is the only place that touches D1.
function planReclassification(rows) {
  const plan = [];
  for (const row of rows) {
    const computed = classifyFactLifecycle(row.fact_text, row.category);
    if (computed !== row.lifecycle) {
      plan.push({ id: row.id, donorId: row.donor_id, factText: row.fact_text, category: row.category, from: row.lifecycle, to: computed });
    }
  }
  return plan;
}

function fetchPlan() {
  const rows = wranglerJson(
    "SELECT id, donor_id, category, lifecycle, fact_text FROM donor_relationship_facts WHERE status='current'",
  )[0].results;
  return { totalCurrentFacts: rows.length, plan: planReclassification(rows) };
}

async function run() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const { totalCurrentFacts, plan } = fetchPlan();

  console.log(`Total status='current' facts scanned: ${totalCurrentFacts}`);
  console.log(`Rows whose stored lifecycle disagrees with the current classifier: ${plan.length}`);
  console.log("");

  for (const item of plan) {
    console.log(`Fact ${item.id} (donor ${item.donorId})`);
    console.log(`  Text: ${JSON.stringify(item.factText)}`);
    console.log(`  Category: ${item.category}`);
    console.log(`  Lifecycle: ${item.from} -> ${item.to}`);
    console.log("");
  }

  console.log("No D1 writes were performed. This is a preview only.");
  return { plan };
}

// APPLY MODE -- the only path in this file that writes to D1. Re-fetches
// and re-plans fresh (never trusts an earlier in-memory plan). Updates
// exactly `lifecycle` + `updated_at`; the conditional WHERE re-checks
// lifecycle = old value so a row changed by a concurrent writer since
// this run's own fresh read is left alone (reported FAILED_CLOSED) rather
// than overwritten blind.
async function applyReclassification() {
  const { plan } = fetchPlan();
  const results = [];
  const now = Math.floor(Date.now() / 1000);
  for (const item of plan) {
    const updateSql = `UPDATE donor_relationship_facts SET lifecycle = ${sqlString(item.to)}, updated_at = ${now} WHERE id = ${sqlString(item.id)} AND lifecycle = ${sqlString(item.from)}`;
    const updateResult = wranglerJson(updateSql);
    const changes = updateResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.push({ id: item.id, status: "FAILED_CLOSED", reason: `Conditional UPDATE matched ${changes} row(s), expected exactly 1 -- lifecycle was changed by a concurrent writer since this run's own fresh read. No write applied.` });
      continue;
    }
    results.push({ id: item.id, status: "APPLIED", from: item.from, to: item.to });
  }
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await run();

export { run, planReclassification, fetchPlan, applyReclassification };
