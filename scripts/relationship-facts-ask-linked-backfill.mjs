// Relationship Snapshot Architecture -- Stage 1 (see docs/AI-HANDOFF.md's
// "Relationship Snapshot Architecture Decision -- Live/Derived vs.
// Cached (2026-08-28)" and the follow-up Stage 1 entry): a narrow,
// one-time migration for the exactly THREE evidenced legacy-solicitation
// cases where a donor's cached relationship_summary/institutional_memory
// text and a real `asks` row share the identical source interaction --
// Mayer Simcha Klein, Rabbi Michoel A. Rovinsky, Allen Pfeiffer. This is
// NOT the general Phase 1 legacy-corpus backfill
// (scripts/relationship-facts-backfill-preview.mjs) -- that script
// deliberately clamps the decay clock to "now" and sets
// source_interaction_id to NULL because it cannot prove a real source for
// most of its candidates. These three donors are different: their real
// `asks.source_interaction_id` already points at the exact real
// `interactions` row that produced their cached narrative text, so this
// migration can (and must, per the approved design) use the REAL
// historical `occurred_at` as the decay-clock start, not a clamp.
//
// Deliberately hardcoded to exactly these 3 donor ids -- this is a
// one-time, explicitly-approved migration for a named, evidenced set of
// cases, never a general mechanism. Do not add a donor to ALLOWLIST
// without a fresh, equally-evidenced investigation round; do not turn
// this into a broader classifier.
//
// PREVIEW MODE (default, `node scripts/relationship-facts-ask-linked-
// backfill.mjs`) is READ-ONLY. It re-derives everything from fresh D1
// state each time it runs -- the donor row, the donor's ask(s), the ask's
// source interaction, the note text, and the real, unmodified
// classifyRelationshipFact() -- and classifies each of the 3 donors into
// exactly one of three outcomes:
//   READY             -- every fail-closed check passed, no existing fact
//                        row for this donor -- safe to insert.
//   ALREADY_MIGRATED  -- exactly one existing fact row already matches
//                        this migration's own expected shape (fingerprint,
//                        category, source_interaction_id) -- a safe no-op,
//                        never a duplicate.
//   FAIL_CLOSED       -- some assumption this migration depends on does
//                        not hold against fresh data (wrong donor shape,
//                        ambiguous ask count, mismatched cached narrative,
//                        an existing-but-different-shaped fact row, etc).
//                        A single FAIL_CLOSED aborts the WHOLE migration,
//                        even if the other two donors are clean -- this
//                        script never broadens or partially proceeds past
//                        a violated assumption.
//
// APPLY MODE (`--apply`) re-runs the exact same fresh preview first. If
// any of the 3 is FAIL_CLOSED, it stops (exit code 1) without writing
// anything. Otherwise it inserts one donor_relationship_facts row + one
// donor_relationship_fact_changes 'created' audit row for every READY
// donor (ALREADY_MIGRATED donors are skipped, not re-inserted). Each
// INSERT is itself a conditional `... WHERE NOT EXISTS` statement whose
// affected-row count is checked (must be exactly 1) before the matching
// audit row is written -- the same fail-closed idempotency pattern
// scripts/relationship-facts-backfill-preview.mjs already uses. If any
// single donor's conditional INSERT does not return exactly 1 change,
// this script stops immediately (does not proceed to the next donor) --
// already-applied donors from earlier in the same run remain applied
// (their fingerprint makes a later re-run safely skip them), so a partial
// failure is always safely resumable, never silently inconsistent.
//
// This stage deliberately does NOT touch donors.relationship_summary or
// donors.institutional_memory -- see docs/AI-HANDOFF.md's Stage 1 entry
// for why leaving the cache byte-for-byte unchanged until Stage 3 is the
// safest choice (Stage 2/3 have not shipped; the recommendation engine
// and every display surface still read the cache today, so touching it
// now could change real, live application behavior in this "design/
// migration only" stage).
//
// Usage:
//   node scripts/relationship-facts-ask-linked-backfill.mjs            (preview)
//   node scripts/relationship-facts-ask-linked-backfill.mjs --apply    (apply)
//   node scripts/relationship-facts-ask-linked-backfill.mjs --verify   (read-only post-apply report: D1 state + real synthesis/relevance for each donor's fact, if any)
// Reads/writes fundraising-os-staging-db via `wrangler d1 execute --remote`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyRelationshipFact } from "../lib/relationships/fact-classification.ts";
import { computeRelationshipFactFingerprint } from "../lib/relationships/fact-fingerprint.ts";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG = path.join(root, "wrangler.staging.jsonc");

// The exactly-3, explicitly-evidenced, hand-verified legacy solicitation
// cases (docs/AI-HANDOFF.md's "Relationship-Intelligence / Ask-
// Supersession Investigation (2026-08-28)"). Never extend this list
// mechanically -- a new candidate requires its own fresh, equally
// evidenced investigation round first.
const ALLOWLIST = [
  { donorId: "b5e8cc18-49f5-42c9-8511-26371ca3cef6", expectedDisplayName: "Mr. & Mrs. Mayer Simcha Klein" },
  { donorId: "952a1cc7-c05a-42ed-a472-463fdb1d633b", expectedDisplayName: "Rabbi Michoel A. Rovinsky" },
  { donorId: "d1b9cf78-2cdb-4546-9527-6210b95d16d4", expectedDisplayName: "Mr. & Mrs. Allen Pfeiffer" },
];

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

// Hex-encodes UTF-8 bytes into a SQLite blob literal cast back to TEXT --
// same convention as scripts/relationship-facts-backfill-preview.mjs:
// real donor content can contain characters that break Windows
// shell-argument parsing in `--command` mode before D1 ever sees it.
function sqlLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

function firstLine(summary) {
  const idx = summary.indexOf("\n");
  return (idx === -1 ? summary : summary.slice(0, idx)).trim();
}

// Reproduces lib/capture/interaction.ts's extractInteraction() memory
// template EXACTLY (`${interactionKindLabel(type)} context: ${note.trim()}`,
// with type "note" -> label "Note") -- not a new format, the same one
// that actually produced these three donors' real cached institutional_
// memory value, per app/api/import/monday/commit/route.ts's confirm_
// contact path (INSERT ... type='note' ... then, on the Phase-2-wired
// path, noteText: text where text is exactly this function's `note`
// argument). Used here only to VERIFY the current cached value still
// matches what was reviewed -- never to write it.
function expectedLegacyMemoryText(noteText) {
  return `Note context: ${noteText}`;
}

// Builds one donor's full case from FRESH D1 reads and returns a
// structured verdict. No caching, no reuse across calls -- every
// invocation (preview, pre-apply re-check, --verify) re-derives
// everything from scratch, per the "re-run the preview against fresh D1
// immediately before applying" requirement.
function buildDonorCase({ donorId, expectedDisplayName }) {
  const fail = (reason, extra = {}) => ({ donorId, expectedDisplayName, status: "FAIL_CLOSED", reason, ...extra });

  const donorRows = wranglerJson(`SELECT id, owner_user_id, display_name, data_source, archived_at, relationship_summary, institutional_memory FROM donors WHERE id = ${sqlString(donorId)}`)[0].results;
  if (donorRows.length !== 1) return fail(`Expected exactly 1 donor row for id ${donorId}, found ${donorRows.length}.`);
  const donor = donorRows[0];
  if (donor.data_source !== "live") return fail(`Donor data_source is "${donor.data_source}", expected "live".`, { donor });
  if (donor.archived_at !== null) return fail(`Donor is archived (archived_at=${donor.archived_at}), expected not archived.`, { donor });
  if (donor.display_name !== expectedDisplayName) return fail(`Donor display_name is "${donor.display_name}", expected "${expectedDisplayName}" -- refusing to proceed on a name mismatch rather than assume the id still points at the reviewed donor.`, { donor });
  if (!donor.owner_user_id) return fail("Donor has no owner_user_id -- cannot scope the fact's required user_id.", { donor });

  const askRows = wranglerJson(`SELECT id, donor_id, amount_cents, purpose, status, asked_at, source_interaction_id FROM asks WHERE donor_id = ${sqlString(donorId)}`)[0].results;
  if (askRows.length !== 1) return fail(`Expected exactly 1 ask row for this donor, found ${askRows.length} -- ambiguous, refusing to guess which one is the reviewed case.`, { donor, askRows });
  const ask = askRows[0];
  if (ask.donor_id !== donor.id) return fail("Ask's donor_id does not match the donor id (should be impossible given the WHERE clause -- treated as a hard stop, not a coding assumption).", { donor, ask });
  if (!ask.source_interaction_id) return fail("Ask has no source_interaction_id -- no provable source interaction, this migration only covers donors with a shared source interaction.", { donor, ask });

  const interactionRows = wranglerJson(`SELECT id, donor_id, summary, source, occurred_at FROM interactions WHERE id = ${sqlString(ask.source_interaction_id)}`)[0].results;
  if (interactionRows.length !== 1) return fail(`Expected exactly 1 interaction row for source_interaction_id ${ask.source_interaction_id}, found ${interactionRows.length}.`, { donor, ask });
  const interaction = interactionRows[0];
  if (interaction.donor_id !== donor.id) return fail(`Source interaction's donor_id (${interaction.donor_id}) does not match this donor (${donor.id}) -- refusing to link across donors.`, { donor, ask, interaction });
  if (typeof interaction.occurred_at !== "number" || interaction.occurred_at <= 0) return fail(`Interaction occurred_at (${interaction.occurred_at}) is not a valid positive timestamp.`, { donor, ask, interaction });
  const now = Math.floor(Date.now() / 1000);
  if (interaction.occurred_at > now) return fail(`Interaction occurred_at (${interaction.occurred_at}) is in the future relative to now (${now}).`, { donor, ask, interaction });
  if (interaction.occurred_at !== ask.asked_at) return fail(`Interaction occurred_at (${interaction.occurred_at}) does not match the ask's own asked_at (${ask.asked_at}) -- refusing to proceed on a provenance mismatch.`, { donor, ask, interaction });

  const noteText = firstLine(interaction.summary);
  if (noteText.length === 0) return fail("Derived note text (interaction summary's first line) is empty after trim.", { donor, ask, interaction });

  const { category, lifecycle } = classifyRelationshipFact(noteText);
  if (category !== "solicitation") return fail(`classifyRelationshipFact() returned category "${category}" for the derived note text, expected "solicitation" -- this donor no longer matches the evidenced case shape.`, { donor, ask, interaction, noteText, category, lifecycle });

  const expectedMemory = expectedLegacyMemoryText(noteText);
  if (donor.relationship_summary !== null) return fail(`donor.relationship_summary is non-null ("${donor.relationship_summary}"), expected null for this evidenced case -- data has changed since the investigation, refusing to guess.`, { donor, ask, interaction, noteText });
  if (donor.institutional_memory !== expectedMemory) return fail(`donor.institutional_memory ("${donor.institutional_memory}") does not exactly match the expected reconstructed value ("${expectedMemory}") -- refusing to proceed on a text mismatch.`, { donor, ask, interaction, noteText });

  const fingerprint = computeRelationshipFactFingerprint({ donorId: donor.id, factText: noteText, sourceInteractionId: interaction.id });

  const existingFactRows = wranglerJson(`SELECT id, donor_id, category, lifecycle, status, fact_text, source_interaction_id, source_interaction_occurred_at, fingerprint FROM donor_relationship_facts WHERE donor_id = ${sqlString(donorId)}`)[0].results;
  let existingMatch = null;
  if (existingFactRows.length > 1) {
    return fail(`Donor already has ${existingFactRows.length} donor_relationship_facts rows -- ambiguous, refusing to broaden or guess which (if any) corresponds to this migration.`, { donor, ask, interaction, noteText, category, lifecycle, fingerprint, existingFactRows });
  }
  if (existingFactRows.length === 1) {
    const row = existingFactRows[0];
    const matches = row.fingerprint === fingerprint && row.category === "solicitation" && row.source_interaction_id === interaction.id && row.fact_text === noteText;
    if (!matches) {
      return fail("Donor already has exactly 1 donor_relationship_facts row, but it does not match this migration's own expected shape (fingerprint/category/source_interaction_id/fact_text) -- refusing to overwrite or assume it's the same fact.", { donor, ask, interaction, noteText, category, lifecycle, fingerprint, existingFactRows });
    }
    existingMatch = row;
  }

  const askIsPending = ask.status === "pending";
  const daysAgo = Math.max(0, (now - interaction.occurred_at) / 86400);

  const base = { donorId: donor.id, donorName: donor.display_name, donor, ask, interaction, noteText, category, lifecycle, fingerprint, expectedMemory, askIsPending, daysAgo, now };

  if (existingMatch) return { ...base, status: "ALREADY_MIGRATED", existingFact: existingMatch };
  return { ...base, status: "READY" };
}

function previewAll() {
  return ALLOWLIST.map(buildDonorCase);
}

function printCase(item) {
  console.log(`\n--- ${item.expectedDisplayName ?? item.donorName} (${item.donorId}) ---`);
  console.log(`Status: ${item.status}`);
  if (item.status === "FAIL_CLOSED") {
    console.log(`Reason: ${item.reason}`);
    return;
  }
  const { ask, interaction, noteText, category, lifecycle, fingerprint, askIsPending, daysAgo } = item;
  console.log(`Ask: id=${ask.id} status=${ask.status} amount_cents=${ask.amount_cents} purpose=${JSON.stringify(ask.purpose)} asked_at=${ask.asked_at} (${new Date(ask.asked_at * 1000).toISOString()})`);
  console.log(`Source interaction: id=${interaction.id} occurred_at=${interaction.occurred_at} (${new Date(interaction.occurred_at * 1000).toISOString()}) source=${interaction.source}`);
  console.log(`Current cached relationship_summary: ${JSON.stringify(item.donor.relationship_summary)}`);
  console.log(`Current cached institutional_memory : ${JSON.stringify(item.donor.institutional_memory)}`);
  console.log(`Current donor_relationship_facts row count for this donor: ${item.status === "ALREADY_MIGRATED" ? 1 : 0}`);
  console.log(`Proposed fact_text: ${JSON.stringify(noteText)}`);
  console.log(`Proposed category/lifecycle: ${category} / ${lifecycle}`);
  console.log(`source_interaction_id (real, not clamped): ${interaction.id}`);
  console.log(`source_interaction_occurred_at (real, not clamped): ${interaction.occurred_at}`);
  console.log(`Fingerprint: ${fingerprint}`);
  console.log(`Ask currently pending (would be pinned fresh)? ${askIsPending ? "YES" : "NO"} (status=${ask.status})`);
  if (lifecycle === "durable") {
    console.log(`Expected current relevance: durable -- fixed baseline score (does not decay).`);
  } else {
    console.log(`Expected current relevance: time_bound, ~${daysAgo.toFixed(1)} days since the source interaction, ${askIsPending ? "PINNED to full freshness while the ask remains pending" : "NOT pinned (ask already resolved) -- decays per the category's window via the real scoreFact()/synthesizeRelationshipSnapshot(), confirmed numerically in --verify output"}.`);
  }
  if (item.status === "ALREADY_MIGRATED") console.log(`(Already migrated in an earlier run -- this is a safe no-op, not a duplicate.)`);
}

function summarize(cases) {
  const failed = cases.filter((c) => c.status === "FAIL_CLOSED");
  const ready = cases.filter((c) => c.status === "READY");
  const already = cases.filter((c) => c.status === "ALREADY_MIGRATED");
  console.log(`\n=== SUMMARY: ${ready.length} READY, ${already.length} ALREADY_MIGRATED, ${failed.length} FAIL_CLOSED ===`);
  return { failed, ready, already, allClean: failed.length === 0 };
}

function preview() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...`);
  const cases = previewAll();
  for (const item of cases) printCase(item);
  const result = summarize(cases);
  if (!result.allClean) {
    console.log("\nSTOP: one or more donors is FAIL_CLOSED. Refusing to proceed to --apply until every assumption is re-verified against fresh staging data or the handoff doc is corrected. Not broadening the migration to compensate.");
  }
  return { cases, ...result };
}

// APPLY -- the only path in this file that writes to D1. Re-derives the
// preview fresh (never trusts an earlier in-memory result), aborts
// entirely if any donor is FAIL_CLOSED, otherwise inserts exactly one
// donor_relationship_facts row + one donor_relationship_fact_changes
// 'created' audit row per READY donor (in ALLOWLIST order), stopping
// immediately (not proceeding to the next donor) if any single insert
// does not affect exactly 1 row.
function apply() {
  console.log("Re-reading fresh D1 state immediately before applying...");
  const cases = previewAll();
  for (const item of cases) printCase(item);
  const { failed, ready, already, allClean } = summarize(cases);
  if (!allClean) {
    console.log("\nSTOP: refusing to apply -- one or more donors is FAIL_CLOSED against fresh data. No writes performed.");
    return { applied: [], failed, already, aborted: true };
  }
  if (ready.length === 0) {
    console.log("\nNothing to apply -- all 3 donors are already migrated (idempotent no-op).");
    return { applied: [], failed: [], already, aborted: false };
  }

  console.log(`\n--- Applying (${ready.length} donor(s)) ---`);
  const applied = [];
  for (const item of ready) {
    const factId = crypto.randomUUID();
    const changeId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    // created_at/updated_at are the row's own bookkeeping timestamps
    // (when this migration actually ran) -- deliberately NOT the same as
    // source_interaction_occurred_at (the fact's real historical truth
    // date, used for decay math). Conflating the two would misrepresent
    // when this row was actually created in the table.
    const insertSql = `INSERT INTO donor_relationship_facts (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, fingerprint, created_at, updated_at) SELECT ${sqlString(factId)}, ${sqlString(item.donorId)}, ${sqlString(item.donor.owner_user_id)}, ${sqlString(item.category)}, ${sqlString(item.lifecycle)}, ${sqlLiteral(item.noteText)}, ${sqlString(item.interaction.id)}, ${item.interaction.occurred_at}, 'current', ${sqlString(item.fingerprint)}, ${nowTs}, ${nowTs} WHERE NOT EXISTS (SELECT 1 FROM donor_relationship_facts f WHERE f.user_id = ${sqlString(item.donor.owner_user_id)} AND f.fingerprint = ${sqlString(item.fingerprint)})`;
    const insertResult = wranglerJson(insertSql);
    const changes = insertResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      console.log(`\nSTOP: ${item.donorName} -- conditional INSERT matched ${changes} row(s), expected exactly 1. No further donors will be applied this run. Already-applied donors above remain applied and are safely idempotent on re-run.`);
      applied.push({ donorId: item.donorId, donorName: item.donorName, status: "FAILED_CLOSED", reason: `INSERT affected ${changes} rows, expected 1.` });
      return { applied, failed, already, aborted: true };
    }
    const afterJson = JSON.stringify({ factText: item.noteText, category: item.category, lifecycle: item.lifecycle, sourceInteractionId: item.interaction.id, sourceInteractionOccurredAt: item.interaction.occurred_at, source: "stage1-ask-linked-backfill" });
    wranglerJson(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, after_json, created_at) VALUES (${sqlString(changeId)}, ${sqlString(factId)}, ${sqlString(item.donor.owner_user_id)}, ${sqlString(item.donorId)}, 'created', '[]', ${sqlLiteral(afterJson)}, ${nowTs})`);
    console.log(`${item.donorName}: APPLIED -- fact ${factId}`);
    applied.push({ donorId: item.donorId, donorName: item.donorName, status: "APPLIED", factId });
  }
  return { applied, failed: [], already, aborted: false };
}

// VERIFY -- read-only. Re-reads whatever donor_relationship_facts rows
// now exist for the 3 donors and runs the REAL, unmodified
// synthesizeRelationshipSnapshot() against each donor's real current
// facts (there should be exactly one each), reporting the synthesized
// text, whether the ask is pending (pinned fresh), and confirming the
// donor's cached relationship_summary/institutional_memory are BYTE-FOR-
// BYTE unchanged from their pre-migration values (this stage must not
// alter them). Does not claim anything about recommendation behavior --
// Stage 2 has not happened.
function verify() {
  console.log(`Verifying ${DB_NAME} (read-only)...`);
  const cases = previewAll();
  for (const item of cases) {
    console.log(`\n--- ${item.donorName ?? item.expectedDisplayName} (${item.donorId}) ---`);
    console.log(`Status: ${item.status}`);
    if (item.status === "FAIL_CLOSED") { console.log(`Reason: ${item.reason}`); continue; }
    const factRows = wranglerJson(`SELECT * FROM donor_relationship_facts WHERE donor_id = ${sqlString(item.donorId)} AND status='current'`)[0].results;
    const synthesisFacts = factRows.map((f) => ({ factText: f.fact_text, category: f.category, lifecycle: f.lifecycle, status: f.status, sourceInteractionId: f.source_interaction_id, sourceInteractionOccurredAt: f.source_interaction_occurred_at }));
    const pinnedFresh = item.askIsPending && item.ask.source_interaction_id ? new Set([item.ask.source_interaction_id]) : new Set();
    const nowTs = Math.floor(Date.now() / 1000);
    const synthesis = synthesizeRelationshipSnapshot(synthesisFacts, nowTs, pinnedFresh);
    console.log(`Current donor_relationship_facts rows (status=current): ${factRows.length}`);
    console.log(`Live synthesis over real current facts -- relationship_summary: ${JSON.stringify(synthesis.relationshipSummary)}`);
    console.log(`Live synthesis over real current facts -- institutional_memory : ${JSON.stringify(synthesis.institutionalMemory)}`);
    console.log(`Ask status: ${item.ask.status} (pending/pinned fresh: ${item.askIsPending ? "YES" : "NO"})`);
    console.log(`Cached donor.relationship_summary unchanged (still null as before this stage)? ${item.donor.relationship_summary === null ? "YES" : "NO -- " + JSON.stringify(item.donor.relationship_summary)}`);
    console.log(`Cached donor.institutional_memory unchanged (still the pre-migration legacy text)? ${item.donor.institutional_memory === item.expectedMemory ? "YES" : "NO -- " + JSON.stringify(item.donor.institutional_memory)}`);
    console.log(`NOTE: this is a read-only relevance report. Stage 2 (wiring this into recommendation decisions) has NOT happened -- the recommendation engine still reads the unchanged cached columns above, not this fact.`);
  }
}

async function runCli() {
  const applyFlag = process.argv.includes("--apply");
  const verifyFlag = process.argv.includes("--verify");
  if (verifyFlag) { verify(); return; }
  if (!applyFlag) { preview(); return; }
  const result = apply();
  if (result.aborted) { process.exitCode = 1; return; }
  console.log("\n--- Post-apply verification ---");
  verify();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

export { ALLOWLIST, buildDonorCase, previewAll, preview, apply, verify, firstLine, expectedLegacyMemoryText };
