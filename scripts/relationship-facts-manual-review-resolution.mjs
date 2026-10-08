// Relationship Intelligence Phase 1 -- resolves 8 of the 12 donors from
// the 2026-08-21 historical-corpus review (scripts/relationship-facts-
// historical-corpus-review.mjs) that the backfill preview script
// deliberately left untouched (see that file's own header comment: this
// migration never auto-resolves NEEDS_REVIEW/INTERACTION_HISTORY_ONLY/
// STRUCTURED_DATA_ALREADY_COVERS_IT dispositions). Two distinct, user-
// approved (2026-10-08) actions, each scoped to its own disposition:
//
// CLEAR (INTERACTION_HISTORY_ONLY / STRUCTURED_DATA_ALREADY_COVERS_IT --
// Abdelhak, Horn, Shlionsky, Semmelman): the review already concluded
// these donors' relationship_summary/institutional_memory carries no
// durable, donor-specific value (pure action description, or already
// duplicated by a real structured asks/yahrtzeits row) -- the ONLY
// reason their legacy "Reach out and reference" suggestion never decays
// (see lib/relationships/recommendation-candidates.ts's legacy fallback
// path, which has no relevance/decay check at all). Nulls both fields;
// creates no replacement fact, per the review's own conclusion that none
// is warranted.
//
// RESOLVE (NEEDS_REVIEW -- Joel Danziger, Mark Danziger, Sonnenblick,
// Weinschneider): the review found a real donor fact embedded in
// fundraiser-action wording and explicitly declined to auto-paraphrase
// it (see that file's own header comment). The user approved specific,
// isolated fact text for each (2026-10-08) -- this inserts exactly that
// text as a new donor_relationship_facts row, via the real, imported
// classifyRelationshipFact() for category/lifecycle (never hand-picked),
// matching the exact INSERT shape and safety conventions (fingerprint-
// based idempotency, source_interaction_id null, source_interaction_
// occurred_at clamped to this run's own timestamp) already established
// by scripts/relationship-facts-backfill-preview.mjs's applyBackfill().
// Legacy relationship_summary/institutional_memory is left untouched for
// these 4 -- harmless once a real fact exists (hasStructuredFacts then
// permanently governs recommendation-candidate generation for that
// donor; see lib/relationships/recommendation-evidence.ts).
//
// PREVIEW MODE (default) is READ-ONLY. APPLY MODE (apply(), not invoked
// by this file's own CLI entry point) performs both sets of writes,
// re-fetching fresh immediately before each write.
//
// Usage: node scripts/relationship-facts-manual-review-resolution.mjs
// Reads/writes fundraising-os-staging-db via `wrangler d1 execute --remote`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyRelationshipFact } from "../lib/relationships/fact-classification.ts";
import { computeRelationshipFactFingerprint } from "../lib/relationships/fact-fingerprint.ts";

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
function sqlLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

const CLEAR_DONOR_IDS = [
  { id: "e4626eea-56ce-4005-96db-eeafbfde6628", name: "Dr. & Mrs. Yaakov Abdelhak" },
  { id: "cd4fbfd1-a461-4954-b580-64d3585f9cb9", name: "Dr. & Mrs. Gavin Horn" },
  { id: "2a1735d2-c3a6-4707-beb9-9ac7a0ab4e34", name: "Mr. & Mrs. Tzvi Shlionsky" },
  { id: "5c35437c-4b08-4c05-8c65-bb3eb95e06aa", name: "Dr. Jacques Semmelman" },
];

const RESOLVE_DONOR_FACTS = [
  { donorId: "e34dc801-ab11-468e-b1bf-b6af52653262", name: "Dr. & Mrs. Joel Danziger", factText: "Son had a bar mitzvah." },
  { donorId: "bb929584-0ba8-4741-84b6-746427724bc4", name: "Dr. & Mrs. Mark Danziger", factText: "Grandson had a bar mitzvah." },
  { donorId: "072ec28e-e73e-4981-a91d-5157aedad72d", name: "Mr. & Mrs. Yaakov Sonnenblick", factText: "Son had a bar mitzvah." },
  { donorId: "9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e", name: "Mr. & Mrs. Dovie Weinschneider", factText: "Interested in a Kollel donation." },
];

async function run() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);

  console.log(`=== CLEAR (null relationship_summary + institutional_memory) -- ${CLEAR_DONOR_IDS.length} donors ===`);
  const idList = CLEAR_DONOR_IDS.map((d) => sqlString(d.id)).join(",");
  const currentClear = wranglerJson(`SELECT id, display_name, relationship_summary, institutional_memory FROM donors WHERE id IN (${idList})`)[0].results;
  for (const row of currentClear) {
    console.log(`${row.display_name} (${row.id})`);
    console.log(`  relationship_summary: ${JSON.stringify(row.relationship_summary)} -> null`);
    console.log(`  institutional_memory: ${JSON.stringify(row.institutional_memory)} -> null`);
  }

  console.log(`\n=== RESOLVE (insert new donor_relationship_facts row) -- ${RESOLVE_DONOR_FACTS.length} donors ===`);
  const resolvePlan = RESOLVE_DONOR_FACTS.map((item) => {
    const { category, lifecycle } = classifyRelationshipFact(item.factText);
    const fingerprint = computeRelationshipFactFingerprint({ donorId: item.donorId, factText: item.factText, sourceInteractionId: null });
    return { ...item, category, lifecycle, fingerprint };
  });
  for (const item of resolvePlan) {
    console.log(`${item.name} (${item.donorId})`);
    console.log(`  New fact: ${JSON.stringify(item.factText)} -- category=${item.category}, lifecycle=${item.lifecycle}`);
  }

  console.log("\nNo D1 writes were performed. This is a preview only.");
  return { currentClear, resolvePlan };
}

// APPLY MODE -- the only path in this file that writes to D1.
async function apply() {
  const results = { cleared: [], resolved: [] };

  for (const donor of CLEAR_DONOR_IDS) {
    const sql = `UPDATE donors SET relationship_summary = NULL, institutional_memory = NULL WHERE id = ${sqlString(donor.id)} AND (relationship_summary IS NOT NULL OR institutional_memory IS NOT NULL)`;
    const result = wranglerJson(sql);
    const changes = result?.[0]?.meta?.changes ?? 0;
    results.cleared.push({ donorId: donor.id, name: donor.name, status: changes === 1 ? "APPLIED" : "NO_CHANGE_OR_ALREADY_NULL", changes });
  }

  const now = Math.floor(Date.now() / 1000);
  for (const item of RESOLVE_DONOR_FACTS) {
    const { category, lifecycle } = classifyRelationshipFact(item.factText);
    const fingerprint = computeRelationshipFactFingerprint({ donorId: item.donorId, factText: item.factText, sourceInteractionId: null });
    const factId = crypto.randomUUID();
    const changeId = crypto.randomUUID();
    const insertSql = `INSERT INTO donor_relationship_facts (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, fingerprint, created_at, updated_at) SELECT ${sqlString(factId)}, ${sqlString(item.donorId)}, d.owner_user_id, ${sqlString(category)}, ${sqlString(lifecycle)}, ${sqlLiteral(item.factText)}, NULL, ${now}, 'current', ${sqlString(fingerprint)}, ${now}, ${now} FROM donors d WHERE d.id = ${sqlString(item.donorId)} AND NOT EXISTS (SELECT 1 FROM donor_relationship_facts f WHERE f.user_id = d.owner_user_id AND f.fingerprint = ${sqlString(fingerprint)})`;
    const insertResult = wranglerJson(insertSql);
    const changes = insertResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.resolved.push({ donorId: item.donorId, name: item.name, status: "FAILED_CLOSED", reason: `Conditional INSERT matched ${changes} row(s), expected exactly 1.` });
      continue;
    }
    wranglerJson(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, after_json, created_at) SELECT ${sqlString(changeId)}, ${sqlString(factId)}, d.owner_user_id, ${sqlString(item.donorId)}, 'created', '[]', ${sqlLiteral(JSON.stringify({ factText: item.factText, category, lifecycle, source: "manual-review-resolution-2026-10-08" }))}, ${now} FROM donors d WHERE d.id = ${sqlString(item.donorId)}`);
    results.resolved.push({ donorId: item.donorId, name: item.name, status: "APPLIED", factId });
  }

  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await run();

export { run, apply };
