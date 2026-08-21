// READ-ONLY, comprehensive audit of donors.relationship_summary and
// donors.institutional_memory across every live donor on Independent
// Staging. This is a SEPARATE script from scripts/relationship-summary-
// cleanup-preview.mjs -- that tool's candidate set is `relationship_summary
// IS NOT NULL` and its classification buckets (SAFE_TO_CLEAR/SAFE_TO_
// REGENERATE/NEEDS_REVIEW/...) are apply-oriented for one field. This
// script instead answers a broader question for BOTH fields
// independently, across every donor with either non-null: does the
// STORED TEXT itself look like legacy extractor scaffolding, regardless
// of whether it can be traced back to a source interaction? It reuses
// this file's own pure helpers (candidateTexts, oldActionableRelationship
// Snapshot, normalizeKind, OLD_FORMAT_PREFIX) for source-tracing, rather
// than reimplementing them, but adds NO write path of its own and does
// not modify that file.
//
// THIS SCRIPT NEVER WRITES TO D1. It only reads via `wrangler d1 execute
// --remote --json` and prints a report. There is no --apply flag and no
// UPDATE/INSERT/DELETE statement anywhere in this file.
//
// Usage: node scripts/relationship-context-audit.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  candidateTexts,
  normalizeKind,
  oldActionableRelationshipSnapshot,
  OLD_FORMAT_PREFIX,
} from "./relationship-summary-cleanup-preview.mjs";
import { interactionKindLabel } from "../lib/capture/interaction.ts";

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

// Broader than OLD_FORMAT_PREFIX alone -- every distinct field-label /
// scaffolding phrase the pre-fix generator (and no other known writer)
// ever emitted, checked independently so a value can be flagged even if
// it doesn't start with the exact "Latest discussion topics: " prefix
// (e.g. if it were ever truncated, concatenated, or partially edited).
const MALFORMED_SIGNALS = [
  /Latest discussion topics:/i,
  /People mentioned:/i,
  /Organizations mentioned:/i,
  /Recommended next action:/i,
  /Review this note before the next interaction/i,
  /^Commitments:/im,
  /^Open follow-ups:/im,
  /^Relationship changes:/im,
];

export function classifyFieldText(value) {
  if (value === null || value === undefined) return "NULL";
  const hit = MALFORMED_SIGNALS.some((pattern) => pattern.test(value));
  return hit ? "MALFORMED" : "GOOD";
}

// Traces a MALFORMED relationship_summary value back to the interaction
// whose note reproduces it exactly under the OLD (pre-1487a8b) generator
// -- proof of provenance, not a guess. Returns null if no interaction on
// file reproduces it (provenance unproven).
export function traceSource(value, interactions) {
  for (const interaction of interactions) {
    for (const { text, kind } of candidateTexts(interaction)) {
      if (oldActionableRelationshipSnapshot(text, normalizeKind(kind)) === value) {
        return { interaction, note: text, kind };
      }
    }
  }
  return null;
}

// Pure classification core (no D1 access) so it's directly unit-testable.
// Returns one row per donor whose relationship_summary OR
// institutional_memory is non-null, with per-field classification, an
// overall donor-level bucket (A/B/C/D per the requested audit taxonomy),
// source trace (only attempted for MALFORMED relationship_summary, since
// that is the field the pre-fix generator ever wrote in this broken
// format -- institutional_memory's template has been byte-identical
// before and after 1487a8b, see the cleanup-preview script's header
// comment), and whether the donor's *effective* Suggested-Action
// narrative text (relationship_summary, falling back to
// institutional_memory -- matching lib/relationships/recommendation-
// candidates.ts's relationshipOpportunityCandidate/solicitCandidate
// exactly) is currently malformed.
export function auditDonors(donors, interactionsByDonor) {
  return donors.map((donor) => {
    const rsClass = classifyFieldText(donor.relationship_summary);
    const imClass = classifyFieldText(donor.institutional_memory);
    const interactions = interactionsByDonor.get(donor.id) ?? [];

    const rsSource = rsClass === "MALFORMED" ? traceSource(donor.relationship_summary, interactions) : null;
    const imSource = imClass === "MALFORMED" ? traceSource(donor.institutional_memory, interactions) : null;

    let overall;
    if (rsClass !== "MALFORMED" && imClass !== "MALFORMED") overall = "A_CLEARLY_GOOD";
    else if ((rsClass === "GOOD" && imClass === "MALFORMED") || (rsClass === "MALFORMED" && imClass === "GOOD")) overall = "C_MIXED";
    else if (rsClass === "MALFORMED" && (imClass === "MALFORMED" || imClass === "NULL")) overall = "B_CLEARLY_MALFORMED";
    else overall = "D_UNCERTAIN";

    // Matches relationshipOpportunityCandidate/solicitCandidate's exact
    // fallback chain: relationship_summary wins if non-null, regardless
    // of its own quality; institutional_memory is only ever consulted
    // when relationship_summary is null.
    const effectiveText = donor.relationship_summary ?? donor.institutional_memory;
    const effectiveClass = classifyFieldText(effectiveText);
    const suggestedActionAffected = effectiveClass === "MALFORMED";

    return {
      donor, rsClass, imClass, overall, rsSource, imSource, suggestedActionAffected,
    };
  });
}

function fetchAll() {
  const donors = wranglerJson(
    "SELECT id, donor_code, display_name, relationship_summary, institutional_memory FROM donors WHERE data_source='live' AND archived_at IS NULL AND (relationship_summary IS NOT NULL OR institutional_memory IS NOT NULL) ORDER BY donor_code",
  )[0].results;
  const totalLive = wranglerJson("SELECT COUNT(*) AS c FROM donors WHERE data_source='live' AND archived_at IS NULL")[0].results[0].c;
  const rsNonNull = wranglerJson("SELECT COUNT(*) AS c FROM donors WHERE data_source='live' AND archived_at IS NULL AND relationship_summary IS NOT NULL")[0].results[0].c;
  const imNonNull = wranglerJson("SELECT COUNT(*) AS c FROM donors WHERE data_source='live' AND archived_at IS NULL AND institutional_memory IS NOT NULL")[0].results[0].c;

  const interactionsByDonor = new Map();
  if (donors.length > 0) {
    const idList = donors.map((d) => `'${d.id.replace(/'/g, "''")}'`).join(",");
    const rows = wranglerJson(
      `SELECT donor_id, id, type, source, occurred_at, shared_activity_id, role, created_at, updated_at, summary FROM interactions WHERE donor_id IN (${idList}) ORDER BY donor_id, occurred_at DESC`,
    )[0].results;
    for (const row of rows) {
      if (!interactionsByDonor.has(row.donor_id)) interactionsByDonor.set(row.donor_id, []);
      interactionsByDonor.get(row.donor_id).push(row);
    }
  }
  return { totalLive, rsNonNull, imNonNull, donors, interactionsByDonor };
}

async function run() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const { totalLive, rsNonNull, imNonNull, donors, interactionsByDonor } = fetchAll();
  const results = auditDonors(donors, interactionsByDonor);

  const counts = { A_CLEARLY_GOOD: 0, B_CLEARLY_MALFORMED: 0, C_MIXED: 0, D_UNCERTAIN: 0 };
  for (const r of results) counts[r.overall]++;

  console.log(`Total live donors: ${totalLive}`);
  console.log(`relationship_summary non-null: ${rsNonNull}`);
  console.log(`institutional_memory non-null: ${imNonNull}`);
  console.log(`Donors with either non-null (audited): ${donors.length}`);
  console.log("");
  console.log(`A. CLEARLY GOOD: ${counts.A_CLEARLY_GOOD}`);
  console.log(`B. CLEARLY MALFORMED: ${counts.B_CLEARLY_MALFORMED}`);
  console.log(`C. MIXED: ${counts.C_MIXED}`);
  console.log(`D. UNCERTAIN: ${counts.D_UNCERTAIN}`);
  console.log("");

  for (const r of results) {
    if (r.overall === "A_CLEARLY_GOOD") continue;
    console.log(`\n=== ${r.donor.donor_code} -- ${r.donor.display_name} (${r.donor.id}) -- ${r.overall} ===`);
    console.log(`  relationship_summary [${r.rsClass}]: ${JSON.stringify(r.donor.relationship_summary)}`);
    if (r.rsSource) console.log(`    source: ${r.rsSource.interaction.id} (${interactionKindLabel(r.rsSource.kind)}, ${new Date(r.rsSource.interaction.occurred_at * 1000).toISOString().slice(0, 10)})`);
    console.log(`  institutional_memory [${r.imClass}]: ${JSON.stringify(r.donor.institutional_memory)}`);
    if (r.imSource) console.log(`    source: ${r.imSource.interaction.id} (${interactionKindLabel(r.imSource.kind)}, ${new Date(r.imSource.interaction.occurred_at * 1000).toISOString().slice(0, 10)})`);
    console.log(`  Suggested Action currently affected: ${r.suggestedActionAffected ? "YES" : "no"}`);
  }

  console.log("\nNo D1 writes were performed. This is a read-only audit.");
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await run();

export { run, fetchAll };
