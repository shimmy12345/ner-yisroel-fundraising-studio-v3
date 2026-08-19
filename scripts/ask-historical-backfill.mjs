// Narrow, deterministic, one-off backfill of exactly 3 already-reviewed
// historical solicitation cases (Klein/Pfeiffer/Rovinsky) into real `asks`
// rows, closing the loop left open by docs/ASK-SOLICITATION-DESIGN.md
// section 20/21 and docs/AI-HANDOFF.md's "Next Approval Required" list.
//
// This is NOT a generic solicitation-note importer. The allowlist below is
// the only input this script will ever act on -- exactly 3 explicit
// {donorId, sourceInteractionId} pairs, hardcoded. No note-text scanning,
// no Monday-classification lookup, no "find more cases like this" logic
// exists anywhere in this file, intentionally.
//
// Two independent, separately-gated phases, mirroring
// scripts/relationship-summary-cleanup-preview.mjs's dry-run/apply split:
//   1. `--apply-asks`            -- create the 3 `asks` (+ `ask_changes`) rows.
//   2. `--cleanup-summaries`     -- clear the 3 donors' broken
//                                   relationship_summary, ONLY once each
//                                   donor's Ask is freshly re-verified to
//                                   exist with the expected fields.
// With no flag: dry-run only (read-only), prints the preview report.
//
// Idempotency: the schema has no UNIQUE constraint on
// `asks.source_interaction_id` (a pre-existing schema limitation, not
// something this script's 3-record backfill justifies a migration for --
// see docs/AI-HANDOFF.md for that noted as a future consideration only).
// This script enforces uniqueness itself, at write time, using
// `INSERT ... SELECT ... WHERE NOT EXISTS (...)` guards keyed on
// `source_interaction_id` (for the ask) and `ask_id` (for its audit row)
// -- a single atomic SQLite statement per guard, safe even if the script
// is re-run or two runs race, and safe even without a real cross-
// statement transaction (`wrangler d1 execute --remote` does not support
// explicit BEGIN/COMMIT -- confirmed live: D1 rejects it with code 7500,
// directing callers to Durable Object transaction APIs instead, which
// this CLI-only script has no access to).
//
// Usage:
//   node scripts/ask-historical-backfill.mjs                    (dry run)
//   node scripts/ask-historical-backfill.mjs --apply-asks        (phase 1)
//   node scripts/ask-historical-backfill.mjs --cleanup-summaries (phase 2)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG = path.join(root, "wrangler.staging.jsonc");
const EXPECTED_USER_ID = "user_sgoldstein@nirc.edu";

// The old, provably-pre-fix machine-generated relationship_summary format
// (see scripts/relationship-summary-cleanup-preview.mjs's OLD_FORMAT_PREFIX
// for the general signature). This script additionally requires the
// specific "People mentioned: Solicited." line the task describes, so
// cleanup only ever touches the exact reviewed pattern -- not just any
// old-format value.
const OLD_FORMAT_PREFIX = "Latest discussion topics: ";
const OLD_SOLICITED_MARKER = "People mentioned: Solicited.";

// --- The explicit, hardcoded allowlist. Exactly these 3 entries, ever. ---
// `expectedNoteFirstLine` is the exact first line of the stored
// interaction's `summary` column (everything before the
// "\nImported from Monday.com..." provenance line) -- used as a hard
// equality check against fresh D1 state before any write, per the task's
// explicit "do not trust the abbreviated IDs/expected values blindly"
// instruction. If the live note does not match this exactly, the entry is
// INELIGIBLE and the script reports why rather than guessing.
const ALLOWLIST = [
  {
    donorId: "b5e8cc18-49f5-42c9-8511-26371ca3cef6",
    donorName: "Mr. & Mrs. Mayer Simcha Klein",
    sourceInteractionId: "monday-interaction-5a79919d",
    expectedNoteFirstLine: "Solicited for a plaque ($5k)",
    amountCents: 500000,
    purpose: "Plaque",
    note: null,
  },
  {
    donorId: "d1b9cf78-2cdb-4546-9527-6210b95d16d4",
    donorName: "Mr. & Mrs. Allen Pfeiffer",
    sourceInteractionId: "monday-interaction-7161c502",
    expectedNoteFirstLine: "Solicited for $10k",
    amountCents: 1000000,
    purpose: null,
    note: null,
  },
  {
    donorId: "952a1cc7-c05a-42ed-a472-463fdb1d633b",
    donorName: "Rabbi Michoel A. Rovinsky",
    sourceInteractionId: "monday-interaction-6d655cb9",
    expectedNoteFirstLine: "Solicited for a plaque in memory of his wife ($5k)",
    amountCents: 500000,
    purpose: "Plaque in memory of his wife",
    note: null,
  },
];

const wranglerBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.CMD" : "wrangler");
const winQuote = (value) => (process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : value);

function wranglerJson(sql) {
  // Collapse embedded newlines/repeated whitespace from the (readable,
  // multi-line-in-source) generated SQL into single spaces -- SQLite is
  // whitespace-insensitive, but a literal newline inside a single
  // --command shell argument breaks Windows cmd.exe's argument parsing
  // (confirmed live: "incomplete input: SQLITE_ERROR"), the same class of
  // bug documented in scripts/relationship-summary-cleanup-preview.mjs.
  const flatSql = sql.replace(/\s+/g, " ").trim();
  const args = ["d1", "execute", DB_NAME, "--remote", "--config", CONFIG, "--command", flatSql, "--json"].map(winQuote);
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
// Hex-blob encoding for values that may contain embedded newlines/quotes
// (the old relationship_summary format is multi-line) -- avoids Windows
// shell-argument-parsing breakage, same technique as
// scripts/relationship-summary-cleanup-preview.mjs's sqlLiteral().
function sqlLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

// --- Fresh-read helpers (no caching, always live D1) ---

function fetchDonor(donorId) {
  const rows = wranglerJson(
    `SELECT id, display_name, owner_user_id, data_source, relationship_summary, institutional_memory FROM donors WHERE id = ${sqlString(donorId)}`,
  )[0].results;
  return rows[0] ?? null;
}

function fetchInteraction(interactionId) {
  const rows = wranglerJson(
    `SELECT id, donor_id, user_id, type, occurred_at, summary, source FROM interactions WHERE id = ${sqlString(interactionId)}`,
  )[0].results;
  return rows[0] ?? null;
}

function fetchExistingAskForInteraction(interactionId) {
  const rows = wranglerJson(
    `SELECT id, donor_id, status, amount_cents, purpose, asked_at FROM asks WHERE source_interaction_id = ${sqlString(interactionId)}`,
  )[0].results;
  return rows[0] ?? null;
}

function fetchAskChangesCreatedCount(askId) {
  const rows = wranglerJson(
    `SELECT COUNT(*) AS c FROM ask_changes WHERE ask_id = ${sqlString(askId)} AND action = 'created'`,
  )[0].results;
  return rows[0].c;
}

// --- Pure validation (no D1 access) ---

// Checks one allowlist entry against freshly-fetched state. Never trusts
// the allowlist's own donorName/amount/purpose without cross-checking the
// live note text first.
function validateEntry(entry, { donor, interaction, existingAsk }) {
  if (!donor) return { eligible: false, reason: `Donor ${entry.donorId} not found in D1.` };
  if (donor.data_source !== "live") return { eligible: false, reason: `Donor ${entry.donorId} is not data_source='live' (found '${donor.data_source}').` };
  if (donor.owner_user_id !== EXPECTED_USER_ID) return { eligible: false, reason: `Donor ${entry.donorId} owner_user_id is '${donor.owner_user_id}', expected '${EXPECTED_USER_ID}'.` };
  if (donor.display_name !== entry.donorName) return { eligible: false, reason: `Donor ${entry.donorId} display_name is '${donor.display_name}', expected '${entry.donorName}' -- refusing to guess.` };

  if (!interaction) return { eligible: false, reason: `Source interaction ${entry.sourceInteractionId} not found in D1.` };
  if (interaction.donor_id !== entry.donorId) return { eligible: false, reason: `Interaction ${entry.sourceInteractionId} belongs to donor ${interaction.donor_id}, not ${entry.donorId}.` };
  if (interaction.user_id !== EXPECTED_USER_ID) return { eligible: false, reason: `Interaction ${entry.sourceInteractionId} user_id is '${interaction.user_id}', expected '${EXPECTED_USER_ID}'.` };

  const actualFirstLine = (interaction.summary ?? "").split("\n")[0];
  if (actualFirstLine !== entry.expectedNoteFirstLine) {
    return { eligible: false, reason: `Interaction ${entry.sourceInteractionId} note first line is ${JSON.stringify(actualFirstLine)}, expected ${JSON.stringify(entry.expectedNoteFirstLine)} -- does not match the reviewed case.` };
  }

  if (existingAsk) {
    return { eligible: false, alreadyBackfilled: true, existingAsk, reason: `An ask (${existingAsk.id}, status=${existingAsk.status}) already references source_interaction_id ${entry.sourceInteractionId} -- already backfilled, no-op.` };
  }

  return {
    eligible: true,
    reason: "Note text matches the reviewed case exactly; donor/interaction ownership confirmed; no existing ask for this interaction.",
    proposedAsk: {
      amountCents: entry.amountCents,
      purpose: entry.purpose,
      status: "pending",
      askedAt: interaction.occurred_at,
      note: entry.note,
      sourceInteractionId: entry.sourceInteractionId,
    },
  };
}

function fetchState(entry) {
  const donor = fetchDonor(entry.donorId);
  const interaction = fetchInteraction(entry.sourceInteractionId);
  const existingAsk = fetchExistingAskForInteraction(entry.sourceInteractionId);
  return { donor, interaction, existingAsk };
}

function money(cents) {
  if (cents === null || cents === undefined) return "(none)";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function isOldSolicitedFormat(value) {
  return typeof value === "string" && value.startsWith(OLD_FORMAT_PREFIX) && value.includes(OLD_SOLICITED_MARKER);
}

// --- Dry run ---

function dryRun() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);
  const rows = [];
  let eligibleCount = 0;

  for (const entry of ALLOWLIST) {
    const state = fetchState(entry);
    const result = validateEntry(entry, state);
    if (result.eligible) eligibleCount++;

    const cleanupEligible = state.donor ? isOldSolicitedFormat(state.donor.relationship_summary) : false;

    console.log(`Donor: ${entry.donorName} (${entry.donorId})`);
    console.log(`  Source interaction: ${entry.sourceInteractionId}${state.interaction ? ` (${new Date(state.interaction.occurred_at * 1000).toISOString().slice(0, 10)})` : " -- NOT FOUND"}`);
    console.log(`  Source note: ${state.interaction ? JSON.stringify((state.interaction.summary ?? "").split("\n")[0]) : "(n/a)"}`);
    console.log(`  Proposed amount: ${money(entry.amountCents)}`);
    console.log(`  Proposed purpose: ${entry.purpose ?? "(none)"}`);
    console.log(`  Proposed status: pending`);
    console.log(`  Existing matching Ask? ${state.existingAsk ? `yes (${state.existingAsk.id}, status=${state.existingAsk.status})` : "no"}`);
    console.log(`  Proposed relationship_summary cleanup: ${cleanupEligible ? "NULL (currently old broken 'People mentioned: Solicited.' format)" : "none (current value does not match the reviewed broken format)"}`);
    console.log(`  Eligible for Ask backfill: ${result.eligible ? "YES" : `NO -- ${result.reason}`}`);
    console.log("");

    rows.push({ entry, state, result, cleanupEligible });
  }

  console.log(`Expected count: 3 eligible`);
  console.log(`Actual eligible: ${eligibleCount}`);
  if (eligibleCount !== 3) {
    console.log("\nSTOP: eligible count is not exactly 3. Do not proceed to --apply-asks until this is understood and resolved.");
    process.exitCode = 1;
  } else {
    console.log("\nAll 3 entries eligible. Safe to proceed to --apply-asks.");
  }
  return rows;
}

// --- Phase 1: create asks ---

// Pure: builds the guarded INSERT pair for one entry. Never called unless
// validateEntry() already returned eligible:true against a FRESH read.
function planAskCreate(entry, interaction) {
  const askId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const askedAt = interaction.occurred_at;
  const afterJson = JSON.stringify({
    amountCents: entry.amountCents,
    purpose: entry.purpose,
    status: "pending",
    askedAt,
    note: entry.note,
    sourceInteractionId: entry.sourceInteractionId,
  });
  const changedFields = JSON.stringify(["amountCents", "purpose", "status", "askedAt", "note", "sourceInteractionId"]);

  const insertAsk = `INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, note, source_interaction_id, created_at, updated_at)
    SELECT ${sqlString(askId)}, ${sqlString(EXPECTED_USER_ID)}, ${sqlString(entry.donorId)}, ${entry.amountCents}, ${sqlNullableString(entry.purpose)}, 'pending', ${askedAt}, ${sqlNullableString(entry.note)}, ${sqlString(entry.sourceInteractionId)}, ${now}, ${now}
    WHERE NOT EXISTS (SELECT 1 FROM asks WHERE source_interaction_id = ${sqlString(entry.sourceInteractionId)})`;

  const insertAuditRow = `INSERT INTO ask_changes (id, ask_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
    SELECT ${sqlString(auditId)}, a.id, ${sqlString(EXPECTED_USER_ID)}, ${sqlString(entry.donorId)}, 'created', ${sqlLiteral(changedFields)}, NULL, ${sqlLiteral(afterJson)}, ${now}
    FROM asks a WHERE a.source_interaction_id = ${sqlString(entry.sourceInteractionId)}
    AND NOT EXISTS (SELECT 1 FROM ask_changes ac WHERE ac.ask_id = a.id AND ac.action = 'created')`;

  return { askId, insertAsk, insertAuditRow };
}

// `fetchStateFn`/`writeFn`/`fetchAuditCountFn` are injectable so tests can
// simulate D1 responses (already-existing ask, a guard matching 0 rows, a
// partial-write recovery) without ever touching live data. Defaults are the
// real live-D1 functions above.
function applyAsks(entries = ALLOWLIST, { fetchStateFn = fetchState, writeFn = wranglerJson, fetchAuditCountFn = fetchAskChangesCreatedCount, log = console.log } = {}) {
  log(`Re-validating fresh state for ${entries.length} allowlisted entries immediately before write...\n`);
  const results = [];

  for (const entry of entries) {
    const state = fetchStateFn(entry);
    const result = validateEntry(entry, state);

    if (!result.eligible) {
      if (result.alreadyBackfilled) {
        // Idempotent no-op: an ask for this source_interaction_id already
        // exists. Verify (and if missing, complete) its 'created' audit
        // row, but never touch the ask row itself.
        const createdCount = fetchAuditCountFn(result.existingAsk.id);
        results.push({ entry, status: "ALREADY_APPLIED", askId: result.existingAsk.id, auditRowPresent: createdCount >= 1, reason: result.reason });
        log(`${entry.donorName}: ALREADY_APPLIED (ask ${result.existingAsk.id}, audit row ${createdCount >= 1 ? "present" : "MISSING"})`);
        continue;
      }
      results.push({ entry, status: "FAILED_CLOSED", reason: result.reason });
      log(`${entry.donorName}: FAILED_CLOSED -- ${result.reason}`);
      continue;
    }

    const plan = planAskCreate(entry, state.interaction);
    const askInsertResult = writeFn(plan.insertAsk);
    const askChanges = askInsertResult?.[0]?.meta?.changes ?? 0;
    if (askChanges !== 1) {
      results.push({ entry, status: "FAILED_CLOSED", reason: `INSERT INTO asks guarded by WHERE NOT EXISTS matched 0 rows to insert (changes=${askChanges}) -- a concurrent writer likely created this ask first between validation and write. Not treated as an error; re-run to confirm.` });
      log(`${entry.donorName}: FAILED_CLOSED -- asks insert affected ${askChanges} rows, expected 1.`);
      continue;
    }

    const auditInsertResult = writeFn(plan.insertAuditRow);
    const auditChanges = auditInsertResult?.[0]?.meta?.changes ?? 0;
    if (auditChanges !== 1) {
      results.push({ entry, status: "PARTIAL", askId: plan.askId, reason: `Ask row created (${plan.askId}) but its 'created' ask_changes audit row insert affected ${auditChanges} rows, expected 1. Re-run this script to complete the audit row -- it is safely idempotent.` });
      log(`${entry.donorName}: PARTIAL -- ask created (${plan.askId}), audit row insert affected ${auditChanges} rows. Re-run to complete.`);
      continue;
    }

    results.push({ entry, status: "APPLIED", askId: plan.askId });
    log(`${entry.donorName}: APPLIED -- ask ${plan.askId} created, audit row written.`);
  }

  return results;
}

// --- Phase 2: relationship_summary cleanup ---

// Pure: decides CLEAR vs SKIP for one donor given a fresh relationship_summary
// read and independently-confirmed Ask verification (never assumed here --
// the caller must have already re-confirmed the Ask exists with the right
// fields immediately before calling this).
function planSummaryCleanup(donorId, freshValue, askVerified) {
  if (!askVerified) {
    return { action: "SKIP", reason: "Ask record not freshly verified for this donor -- refusing to clear relationship_summary before its replacement fact is confirmed to exist." };
  }
  if (!isOldSolicitedFormat(freshValue)) {
    return { action: "SKIP", reason: `Current relationship_summary does not match the reviewed old broken format (starts with ${OLD_FORMAT_PREFIX ? "the old prefix" : "?"} and contains "${OLD_SOLICITED_MARKER}") -- value may have already been changed by something else. Left untouched: ${JSON.stringify(freshValue)}` };
  }
  return {
    action: "CLEAR",
    reason: "Ask verified present; current relationship_summary still matches the exact reviewed broken 'People mentioned: Solicited.' format -- safe to null out (the fact now lives structurally in the Ask).",
    sql: `UPDATE donors SET relationship_summary = NULL WHERE id = ${sqlString(donorId)} AND relationship_summary = ${sqlLiteral(freshValue)}`,
  };
}

function verifyAskForCleanup(entry, { fetchAskFn = fetchExistingAskForInteraction, fetchAuditCountFn = fetchAskChangesCreatedCount } = {}) {
  const ask = fetchAskFn(entry.sourceInteractionId);
  if (!ask) return { verified: false, reason: "No ask found for this source interaction." };
  if (ask.donor_id !== entry.donorId) return { verified: false, reason: `Ask ${ask.id} belongs to donor ${ask.donor_id}, not ${entry.donorId}.` };
  if (ask.amount_cents !== entry.amountCents) return { verified: false, reason: `Ask ${ask.id} amount_cents is ${ask.amount_cents}, expected ${entry.amountCents}.` };
  if ((ask.purpose ?? null) !== (entry.purpose ?? null)) return { verified: false, reason: `Ask ${ask.id} purpose is ${JSON.stringify(ask.purpose)}, expected ${JSON.stringify(entry.purpose)}.` };
  const createdCount = fetchAuditCountFn(ask.id);
  if (createdCount < 1) return { verified: false, reason: `Ask ${ask.id} has no 'created' ask_changes audit row.` };
  return { verified: true, ask };
}

// Injectable fetch/write functions, same rationale as applyAsks() above.
function cleanupSummaries(entries = ALLOWLIST, { fetchAskFn = fetchExistingAskForInteraction, fetchAuditCountFn = fetchAskChangesCreatedCount, fetchDonorFn = fetchDonor, writeFn = wranglerJson, log = console.log } = {}) {
  log("Re-verifying each donor's Ask (fresh read) before any relationship_summary write...\n");
  const results = [];

  for (const entry of entries) {
    const verification = verifyAskForCleanup(entry, { fetchAskFn, fetchAuditCountFn });
    if (!verification.verified) {
      results.push({ entry, status: "SKIPPED", reason: `Ask not verified: ${verification.reason}` });
      log(`${entry.donorName}: SKIPPED -- Ask not verified: ${verification.reason}`);
      continue;
    }

    const donor = fetchDonorFn(entry.donorId);
    const plan = planSummaryCleanup(entry.donorId, donor.relationship_summary, true);
    if (plan.action === "SKIP") {
      results.push({ entry, status: "SKIPPED", reason: plan.reason });
      log(`${entry.donorName}: SKIPPED -- ${plan.reason}`);
      continue;
    }

    const updateResult = writeFn(plan.sql);
    const changes = updateResult?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.push({ entry, status: "FAILED_CLOSED", reason: `Compare-and-swap UPDATE matched ${changes} rows, expected 1 -- relationship_summary changed since this run's read. No write applied.` });
      log(`${entry.donorName}: FAILED_CLOSED -- compare-and-swap matched ${changes} rows.`);
      continue;
    }

    results.push({ entry, status: "CLEARED", before: donor.relationship_summary });
    log(`${entry.donorName}: CLEARED -- relationship_summary set to NULL.`);
  }

  return results;
}

// --- CLI ---

async function runCli() {
  const applyAsksFlag = process.argv.includes("--apply-asks");
  const cleanupFlag = process.argv.includes("--cleanup-summaries");

  if (!applyAsksFlag && !cleanupFlag) {
    dryRun();
    return;
  }
  if (applyAsksFlag) {
    const dryRunRows = dryRun();
    const eligible = dryRunRows.filter((r) => r.result.eligible).length;
    if (eligible !== 3 && !dryRunRows.every((r) => r.result.eligible || r.result.alreadyBackfilled)) {
      console.log("\nSTOP: not all entries are eligible or already-applied. Refusing to apply.");
      process.exitCode = 1;
      return;
    }
    console.log("\n--- Applying (phase 1: create asks) ---\n");
    const results = applyAsks();
    const failed = results.filter((r) => r.status === "FAILED_CLOSED" || r.status === "PARTIAL").length;
    console.log(`\n${results.length - failed} ok, ${failed} failed/partial.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }
  if (cleanupFlag) {
    console.log("--- Applying (phase 2: relationship_summary cleanup) ---\n");
    const results = cleanupSummaries();
    const failed = results.filter((r) => r.status === "FAILED_CLOSED").length;
    console.log(`\n${results.filter((r) => r.status === "CLEARED").length} cleared, ${results.filter((r) => r.status === "SKIPPED").length} skipped, ${failed} failed closed.`);
    if (failed > 0) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

export {
  ALLOWLIST,
  EXPECTED_USER_ID,
  OLD_FORMAT_PREFIX,
  OLD_SOLICITED_MARKER,
  validateEntry,
  fetchState,
  dryRun,
  planAskCreate,
  applyAsks,
  isOldSolicitedFormat,
  planSummaryCleanup,
  verifyAskForCleanup,
  cleanupSummaries,
  money,
};
