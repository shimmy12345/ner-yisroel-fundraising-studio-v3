// Relationship Intelligence Phase 1 -- backfill for donor_relationship_
// facts (see docs/AI-HANDOFF.md's "Relationship Snapshot Synthesis
// Design" sections and the Phase 1 implementation entry). For every live
// donor whose CURRENT donors.relationship_summary (falling back to
// institutional_memory only when relationship_summary is null, mirroring
// the existing narrative fallback in lib/relationships/recommendation-
// candidates.ts) is non-null, this script proposes exactly ONE durable
// fact row preserving that text verbatim -- byte-for-byte, no
// regeneration, no cleanup -- classified via the real, imported
// classifyRelationshipFact() (never a reimplementation).
//
// PREVIEW MODE (default, `node scripts/relationship-facts-backfill-
// preview.mjs`) is READ-ONLY: it queries donors via `wrangler d1 execute
// --remote --json` (the same pattern scripts/relationship-summary-
// cleanup-preview.mjs and scripts/verify-remote-restore.mjs already use)
// and prints the proposed plan. It NEVER writes to D1.
//
// APPLY MODE (applyBackfill(), exposed for a FUTURE, separate, explicitly
// approved run -- never invoked by this script's own CLI entry point
// today) re-fetches fresh, re-plans, and inserts only rows whose
// fingerprint does not already exist for that user (the real idempotency
// backstop, doubled by donor_relationship_facts' own (user_id,
// fingerprint) unique index at the database level -- see migration
// 0034 and tests/relationship-facts-schema.test.mjs). Every backfilled
// row gets source_interaction_id = NULL (no single real interaction can
// be proven as the source for pre-existing text) and source_interaction_
// occurred_at CLAMPED to the backfill's own run time -- never the
// donor's true historical date -- so a backfilled time_bound fact gets
// the same full decay grace period a brand-new fact would, instead of
// potentially being born already past its own window.
//
// SAFETY: any donor whose current value matches the PROVEN pre-fix
// "Latest discussion topics: ..." field-label-dump signature (OLD_
// FORMAT_PREFIX, imported from the sibling cleanup script -- a
// structural fact checked against real git history, not a guess) is
// flagged NEEDS_REVIEW rather than silently ingested as permanent,
// durable relationship intelligence -- ingesting known machine-generated
// junk as "durable" would preserve it forever. Any value that is empty
// after trim, or implausibly long, is also flagged rather than guessed
// at. A value that classifies `follow_up` AND also matches a real
// substantive category signal (lib/relationships/fact-classification.ts's
// hasSubstantiveContentBesidesCommitment()) is ALSO flagged rather than
// silently backfilled -- found and fixed via a real staging donor
// (Weinschneider: "Discussed Kollel donation and said to follow up after
// succos.") whose whole sentence would otherwise become a pure follow_up
// fact, permanently excluded from Snapshot synthesis, silently dropping
// the genuine "discussing a Kollel donation" fact it also contains. See
// docs/AI-HANDOFF.md for the full investigation.
//
// Usage: node scripts/relationship-facts-backfill-preview.mjs
// Reads fundraising-os-staging-db via `wrangler d1 execute --remote`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyRelationshipFact, hasSubstantiveContentBesidesCommitment } from "../lib/relationships/fact-classification.ts";
import { computeRelationshipFactFingerprint } from "../lib/relationships/fact-fingerprint.ts";
import { OLD_FORMAT_PREFIX } from "./relationship-summary-cleanup-preview.mjs";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG = path.join(root, "wrangler.staging.jsonc");
const MAX_SANE_LENGTH = 3000;

const wranglerBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.CMD" : "wrangler");
// Same Windows shell-quoting handling as scripts/relationship-summary-
// cleanup-preview.mjs (see that file's own comment for why this is
// necessary, not optional).
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

// Hex-encodes a value's UTF-8 bytes into a SQLite blob literal cast back
// to TEXT -- same convention and same reason as scripts/relationship-
// summary-cleanup-preview.mjs's sqlLiteral(): real donor content can
// contain embedded newlines, which break Windows shell-argument parsing
// in `--command` mode before the query ever reaches D1.
function sqlLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

// Pure classification core -- takes already-fetched donor rows and the
// set of fingerprints already present in donor_relationship_facts for
// this run's users (empty on a first run; populated on a safe re-run),
// plus the backfill's own run timestamp (the decay-clock clamp value for
// any time_bound-classified row). No D1 access here, so this is directly
// unit-testable against synthetic fixtures.
function planBackfill(donors, existingFingerprints, backfillRunEpochSeconds) {
  const plan = [];
  const skipped = [];

  for (const donor of donors) {
    const sourceField = donor.relationship_summary !== null ? "relationship_summary" : donor.institutional_memory !== null ? "institutional_memory" : null;
    if (sourceField === null) continue; // nothing to backfill -- not a candidate, not a skip

    const rawValue = sourceField === "relationship_summary" ? donor.relationship_summary : donor.institutional_memory;
    const value = rawValue.trim();

    if (value.length === 0) {
      skipped.push({ donor, sourceField, value: rawValue, reason: "Value is empty after trim -- nothing to preserve, but also not safely nullable here without a human decision (a non-null empty-after-trim value is itself unexpected)." });
      continue;
    }
    if (value.length > MAX_SANE_LENGTH) {
      skipped.push({ donor, sourceField, value: rawValue, reason: `Value is ${value.length} characters, exceeding the ${MAX_SANE_LENGTH}-character sanity bound -- flagged for human review rather than silently ingested as a single durable fact.` });
      continue;
    }
    if (value.startsWith(OLD_FORMAT_PREFIX)) {
      skipped.push({ donor, sourceField, value: rawValue, reason: "Matches the PROVEN pre-fix \"Latest discussion topics: ...\" field-label-dump signature (see scripts/relationship-summary-cleanup-preview.mjs) -- known machine-generated junk, not real relationship intelligence; ingesting it as a permanent durable fact would preserve it forever. Run the cleanup script first, or route to manual review." });
      continue;
    }

    const { category, lifecycle } = classifyRelationshipFact(value);

    if (lifecycle === "follow_up" && hasSubstantiveContentBesidesCommitment(value)) {
      skipped.push({ donor, sourceField, value: rawValue, reason: `This text classifies as follow_up (an action-oriented commitment, per COMMITMENT_PATTERN) but ALSO matches a real substantive fact-category signal -- treating the whole sentence as follow_up would permanently exclude that other fact from Snapshot synthesis (follow_up facts never enter relationship_summary/institutional_memory at all). Needs a human decision (e.g. splitting into two separate accepted facts) rather than a one-size-fits-all automatic choice.` });
      continue;
    }

    const fingerprint = computeRelationshipFactFingerprint({ donorId: donor.id, factText: value, sourceInteractionId: null });
    const alreadyExists = existingFingerprints.has(`${donor.owner_user_id ?? donor.user_id ?? ""}:${fingerprint}`);

    if (alreadyExists) {
      skipped.push({ donor, sourceField, value: rawValue, reason: "A fact with this exact fingerprint already exists for this user (already backfilled in an earlier run) -- skipped, not duplicated. This is the idempotency safeguard: a re-run of this script is always safe." });
      continue;
    }

    plan.push({
      donorId: donor.id,
      donorName: donor.display_name,
      sourceField,
      factText: value,
      category,
      lifecycle,
      // Always null for a backfilled fact -- no single real interaction
      // can be proven as the source of today's pre-existing text.
      sourceInteractionId: null,
      // The decay-clock clamp: a backfilled time_bound fact starts its
      // decay window from the backfill's own run time, never any real
      // historical date. Durable facts don't consult this for decay at
      // all, but it is still recorded for every row (a NOT NULL column).
      sourceInteractionOccurredAt: backfillRunEpochSeconds,
      fingerprint,
    });
  }

  return { plan, skipped };
}

// Fetches a fresh live snapshot from D1: candidate donors (live, non-
// archived, with a non-null relationship_summary or institutional_memory)
// and their owner_user_id (needed to scope the fingerprint-existence
// check per user, matching the (user_id, fingerprint) unique index).
// Also fetches every existing donor_relationship_facts fingerprint for
// those same users, so a re-run is always idempotent even before the
// first apply ever happens (this query simply returns 0 rows until
// Phase 1's apply step is separately approved and run).
function fetchLivePlan() {
  const donorRows = wranglerJson(
    "SELECT id, owner_user_id, display_name, relationship_summary, institutional_memory FROM donors WHERE data_source='live' AND archived_at IS NULL",
  )[0].results;
  const totalDonors = donorRows.length;
  const candidates = donorRows.filter((d) => d.relationship_summary !== null || d.institutional_memory !== null);

  let existingFingerprints = new Set();
  const userIds = [...new Set(candidates.map((d) => d.owner_user_id).filter(Boolean))];
  if (userIds.length > 0) {
    const idList = userIds.map((id) => sqlString(id)).join(",");
    let existingRows = [];
    try {
      existingRows = wranglerJson(`SELECT user_id, fingerprint FROM donor_relationship_facts WHERE user_id IN (${idList})`)[0].results;
    } catch (error) {
      // The table may not exist yet on a workspace where migration 0034
      // has not been applied -- treat as "no existing facts" rather than
      // crashing the preview. Applying the migration is a prerequisite
      // for apply mode, but preview/classification must still work
      // without it (it never depends on the new tables existing).
      if (!/no such table/i.test(String(error.message))) throw error;
    }
    existingFingerprints = new Set(existingRows.map((row) => `${row.user_id}:${row.fingerprint}`));
  }

  const backfillRunEpochSeconds = Math.floor(Date.now() / 1000);
  const { plan, skipped } = planBackfill(candidates, existingFingerprints, backfillRunEpochSeconds);
  return { totalDonors, candidateCount: candidates.length, plan, skipped, backfillRunEpochSeconds };
}

async function run() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const { totalDonors, candidateCount, plan, skipped, backfillRunEpochSeconds } = fetchLivePlan();

  console.log(`Total live donors scanned: ${totalDonors}`);
  console.log(`Candidates (non-null relationship_summary or institutional_memory): ${candidateCount}`);
  console.log(`Backfill run timestamp (decay-clock clamp for any time_bound row): ${backfillRunEpochSeconds} (${new Date(backfillRunEpochSeconds * 1000).toISOString()})`);
  console.log(`SAFE TO BACKFILL: ${plan.length}`);
  console.log(`NEEDS REVIEW / SKIPPED: ${skipped.length}`);
  console.log("");

  if (plan.length > 0) {
    console.log(`=== SAFE TO BACKFILL (${plan.length}) ===`);
    for (const item of plan) {
      console.log(`\nDonor: ${item.donorName} (${item.donorId})`);
      console.log(`  Source field: donors.${item.sourceField}`);
      console.log(`  Fact text: ${JSON.stringify(item.factText)}`);
      console.log(`  Proposed category: ${item.category}`);
      console.log(`  Proposed lifecycle: ${item.lifecycle}`);
      console.log(`  source_interaction_id: null (backfilled -- no provable source interaction)`);
      console.log(`  Fingerprint: ${item.fingerprint}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`\n=== NEEDS REVIEW / SKIPPED (${skipped.length}) ===`);
    for (const item of skipped) {
      console.log(`\nDonor: ${item.donor.display_name} (${item.donor.id})`);
      console.log(`  Source field: donors.${item.sourceField}`);
      console.log(`  Value: ${JSON.stringify(item.value)}`);
      console.log(`  Reason: ${item.reason}`);
    }
  }

  console.log("\nNo D1 writes were performed. This is a preview only.");
  return { plan, skipped };
}

// APPLY MODE -- the only path in this file that writes to D1. NOT invoked
// by this file's own CLI entry point below; exposed for a future,
// separate, explicitly-approved run once the preview above has been
// reviewed. Re-fetches and re-plans fresh (never trusts an earlier
// in-memory plan), inserts one donor_relationship_facts row per plan
// item, and writes a matching donor_relationship_fact_changes 'created'
// audit row in the same batch-equivalent sequence. Fails closed per row:
// if a row's fingerprint has been claimed by a concurrent writer since
// this function's own fresh read (the database-level unique index
// rejects the INSERT), that row is reported FAILED_CLOSED, never retried
// as an overwrite.
async function applyBackfill() {
  const { plan } = fetchLivePlan();
  const results = [];
  for (const item of plan) {
    const factId = crypto.randomUUID();
    const changeId = crypto.randomUUID();
    const insertSql = `INSERT INTO donor_relationship_facts
      (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, fingerprint, created_at, updated_at)
      SELECT ${sqlString(factId)}, ${sqlString(item.donorId)}, d.owner_user_id, ${sqlString(item.category)}, ${sqlString(item.lifecycle)}, ${sqlLiteral(item.factText)}, NULL, ${item.sourceInteractionOccurredAt}, 'current', ${sqlString(item.fingerprint)}, ${item.sourceInteractionOccurredAt}, ${item.sourceInteractionOccurredAt}
      FROM donors d WHERE d.id = ${sqlString(item.donorId)}
      AND NOT EXISTS (SELECT 1 FROM donor_relationship_facts f WHERE f.user_id = d.owner_user_id AND f.fingerprint = ${sqlString(item.fingerprint)})`;
    const insertResult = wranglerJson(insertSql);
    const changes = insertResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.push({ donorId: item.donorId, status: "FAILED_CLOSED", reason: `Conditional INSERT matched ${changes} row(s), expected exactly 1 -- either the donor no longer exists/qualifies, or a fact with this fingerprint was created by a concurrent writer since this run's own fresh read. No write applied.` });
      continue;
    }
    wranglerJson(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, after_json, created_at)
      SELECT ${sqlString(changeId)}, ${sqlString(factId)}, d.owner_user_id, ${sqlString(item.donorId)}, 'created', '[]', ${sqlLiteral(JSON.stringify({ factText: item.factText, category: item.category, lifecycle: item.lifecycle, source: "phase1-backfill" }))}, ${item.sourceInteractionOccurredAt}
      FROM donors d WHERE d.id = ${sqlString(item.donorId)}`);
    results.push({ donorId: item.donorId, status: "APPLIED", factId });
  }
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await run();

export { run, planBackfill, fetchLivePlan, applyBackfill, MAX_SANE_LENGTH };
