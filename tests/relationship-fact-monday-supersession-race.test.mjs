import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planFactAcceptanceStep } from "../lib/relationships/fact-accept-plan.ts";

// Relationship Intelligence Phase 2 -- regression test for a real
// correctness bug and its fix: two accepted confirm_contact decisions
// for the SAME donor within ONE Monday import commit request. Before
// the fix, app/api/import/monday/commit/route.ts called the single-shot
// planFactAcceptance() once per decision, each doing its own fresh D1
// read -- so the SECOND decision's read could not see the FIRST
// decision's not-yet-executed statements from the same batch, and a
// same-category/lifecycle supersession between them would be silently
// missed (both would insert as separate "current" facts instead of the
// second correctly superseding the first). The fix threads an in-memory
// FactAcceptanceWorkingState between decisions for the same donor (see
// lib/relationships/fact-accept-plan.ts's planFactAcceptanceStep() and
// the route's own factStateByDonor cache).
//
// This test proves, against a REAL SQLite database (matching this
// repo's own established convention for D1-shaped correctness questions
// -- see tests/relationship-facts-schema.test.mjs, tests/asks.test.mjs),
// that:
//   1. threading state produces the correct supersession (decision 2
//      supersedes decision 1's fact);
//   2. the batch-processed result is structurally IDENTICAL (same
//      current facts, same supersession chain, same synthesized
//      donors.relationship_summary/institutional_memory, same audit
//      trail shape) to running the two decisions as two genuinely
//      SEPARATE, sequential requests (each re-reading real D1 state
//      after the previous one committed);
//   3. the bug is real: re-planning decision 2 against the STALE
//      pre-batch state (what the old per-decision-fresh-read code
//      effectively did) produces a different, wrong result -- both
//      facts left "current", no supersession at all.
//
// The SQL below intentionally mirrors lib/relationships/fact-accept.ts's
// own materializeFactAcceptanceIntent() literally (that file cannot be
// imported directly in plain Node -- it imports "cloudflare:workers",
// which only resolves inside a Workers runtime; confirmed elsewhere in
// this test suite). Any drift between this mirror and the real
// materializer would be caught by tests/relationship-fact-accept-wiring.
// test.mjs's own structural assertions on fact-accept.ts's exact SQL
// text, since both are asserting the same literal statements.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW_BASE = Math.floor(Date.parse("2026-08-22T12:00:00Z") / 1000);

function seed(database) {
  database.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("u1", "owner@example.test", NOW_BASE, NOW_BASE);
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)").run("d1", "u1", "Donor One", NOW_BASE, NOW_BASE);
  // donor_relationship_facts.source_interaction_id is a real FK to
  // interactions(id) -- seed the two Monday-imported interaction rows
  // each decision's fact will be attributed to (mirroring what the real
  // Monday commit route itself inserts before ever reaching the fact
  // pipeline).
  for (const [id, occurredAt] of [["monday-int-1", NOW_BASE - 5 * 86400], ["monday-int-2", NOW_BASE - 1 * 86400]]) {
    database.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, 'd1', 'u1', 'note', ?, 'Imported from Monday.', 'import-monday:confirmed', ?, ?)")
      .run(id, occurredAt, NOW_BASE, NOW_BASE);
  }
}

// Mirrors lib/relationships/fact-accept.ts's materializeFactAcceptanceIntent()
// literally, executed against real SQLite instead of a live D1PreparedStatement.
function materializeAndExec(database, intent, donorId, userId, now) {
  if (!intent) return;
  const { newFact, supersedeFactId } = intent;

  database.prepare(`INSERT INTO donor_relationship_facts
      (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, supersedes_fact_id, fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?)`)
    .run(newFact.id, donorId, userId, newFact.category, newFact.lifecycle, newFact.factText, newFact.sourceInteractionId, newFact.sourceInteractionOccurredAt, supersedeFactId, newFact.fingerprint, now, now);
  database.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'created', '[]', NULL, ?, ?)`)
    .run(crypto.randomUUID(), newFact.id, userId, donorId, JSON.stringify({ factText: newFact.factText, category: newFact.category, lifecycle: newFact.lifecycle, sourceInteractionId: newFact.sourceInteractionId }), now);

  if (supersedeFactId) {
    database.prepare("UPDATE donor_relationship_facts SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'current'").run(now, supersedeFactId);
    database.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'superseded', ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), supersedeFactId, userId, donorId, JSON.stringify(["status"]), JSON.stringify({ status: "current" }), JSON.stringify({ status: "superseded", supersededByFactId: newFact.id }), now);
  }

  database.prepare(`UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = 86, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND relationship_summary IS ? AND institutional_memory IS ?`)
    .run(intent.relationshipSummary, intent.institutionalMemory, now, donorId, userId, intent.casRelationshipSummary, intent.casInstitutionalMemory);
}

// Mirrors lib/relationships/fact-accept.ts's loadFactAcceptanceDonorState()
// literally -- a genuine fresh read of real (post-commit) D1 state.
function loadDonorStateFromDb(database, donorId, userId) {
  const facts = database.prepare("SELECT id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, fingerprint FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND status = 'current'").all(donorId, userId);
  const donorRow = database.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").get(donorId, userId);
  return {
    workingState: {
      facts: facts.map((f) => ({ id: f.id, category: f.category, lifecycle: f.lifecycle, factText: f.fact_text, sourceInteractionId: f.source_interaction_id, sourceInteractionOccurredAt: f.source_interaction_occurred_at, fingerprint: f.fingerprint })),
      relationshipSummary: donorRow?.relationship_summary ?? null,
      institutionalMemory: donorRow?.institutional_memory ?? null,
    },
    pinnedFresh: new Set(),
  };
}

function currentFactRows(database) {
  return database.prepare("SELECT category, lifecycle, fact_text, status, supersedes_fact_id IS NOT NULL AS was_superseding FROM donor_relationship_facts ORDER BY created_at, fact_text").all();
}

function auditActionCounts(database) {
  const rows = database.prepare("SELECT action FROM donor_relationship_fact_changes ORDER BY created_at").all();
  return rows.map((r) => r.action);
}

function donorSnapshot(database) {
  return database.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = 'd1'").get();
}

// Two real texts, both proven (tests/relationship-fact-classification.
// test.mjs) to classify as category "solicitation", lifecycle
// "time_bound" -- the one pair of categories where "same category, same
// lifecycle" auto-supersedes (see fact-supersession.ts). Different
// sourceInteractionId per decision, matching two distinct Monday rows
// for the same donor (mondayInteractionId depends on subitemIndex/text,
// so two different decisions never share one).
const TEXT_1 = "Discussed a $10,000 pledge for the building fund; he wants to think it over.";
const TEXT_2 = "He confirmed the $10,000 building fund gift and asked for a plaque acknowledgment.";

function decisionInput(sourceInteractionId, sourceInteractionOccurredAt, noteText, pinnedFresh) {
  return { donorId: "d1", userId: "u1", sourceInteractionId, sourceInteractionOccurredAt, noteText, kind: "note", subject: "", now: NOW_BASE, pinnedFresh };
}

async function run() {
  const emptyState = { facts: [], relationshipSummary: null, institutionalMemory: null };
  const pinnedFresh = new Set();

  // ================================================================
  // Scenario A -- BATCH, WITH THE FIX: one request, two decisions,
  // state threaded between them (exactly what the route now does).
  // ================================================================
  const batchDb = freshDatabase();
  seed(batchDb);
  const step1 = planFactAcceptanceStep(emptyState, decisionInput("monday-int-1", NOW_BASE - 5 * 86400, TEXT_1, pinnedFresh));
  assert.ok(step1.intent, "decision 1 must produce a real intent -- both fixture texts extract non-null content");
  assert.equal(step1.intent.supersedeFactId, null, "decision 1, against an empty state, has nothing to supersede");
  materializeAndExec(batchDb, step1.intent, "d1", "u1", NOW_BASE);

  const step2 = planFactAcceptanceStep(step1.nextState, decisionInput("monday-int-2", NOW_BASE - 1 * 86400, TEXT_2, pinnedFresh));
  assert.ok(step2.intent, "decision 2 must produce a real intent");
  assert.equal(step2.intent.supersedeFactId, step1.intent.newFact.id, "THE FIX: decision 2, planned against decision 1's own nextState, must correctly auto-supersede decision 1's fact (same category+lifecycle, singular-state rule)");
  materializeAndExec(batchDb, step2.intent, "d1", "u1", NOW_BASE);

  const batchFacts = currentFactRows(batchDb);
  const batchAudits = auditActionCounts(batchDb);
  const batchSnapshot = donorSnapshot(batchDb);

  assert.equal(batchFacts.filter((f) => f.status === "current").length, 1, "exactly one fact must remain current after the batch -- decision 2's");
  assert.equal(batchFacts.find((f) => f.status === "current").fact_text, TEXT_2);
  assert.equal(batchFacts.find((f) => f.status === "superseded").fact_text, TEXT_1, "decision 1's fact must survive, non-deleted, with status superseded");
  assert.deepEqual(batchAudits.sort(), ["created", "created", "superseded"].sort(), "exactly 3 audit rows: both facts' own 'created' entries plus decision 1's 'superseded' transition");
  assert.equal(batchSnapshot.relationship_summary, TEXT_2, "the donors row must reflect ONLY the current fact after both decisions -- decision 2's synthesis, not decision 1's stale synthesis");

  // ================================================================
  // Scenario B -- TWO GENUINELY SEQUENTIAL REQUESTS: decision 1 alone,
  // committed; THEN decision 2, planned against a REAL fresh D1 read of
  // what decision 1 actually left behind (not the in-memory nextState
  // object at all -- a completely independent code path). This is the
  // ground truth planFactAcceptanceStep() must reproduce when used
  // in-batch, per the task's own requirement.
  // ================================================================
  const seqDb = freshDatabase();
  seed(seqDb);
  const seqStep1 = planFactAcceptanceStep(emptyState, decisionInput("monday-int-1", NOW_BASE - 5 * 86400, TEXT_1, pinnedFresh));
  materializeAndExec(seqDb, seqStep1.intent, "d1", "u1", NOW_BASE);

  const freshState = loadDonorStateFromDb(seqDb, "d1", "u1");
  const seqStep2 = planFactAcceptanceStep(freshState.workingState, decisionInput("monday-int-2", NOW_BASE - 1 * 86400, TEXT_2, freshState.pinnedFresh));
  assert.equal(seqStep2.intent.supersedeFactId, seqStep1.intent.newFact.id, "a genuine second request, reading real post-commit D1 state, must ALSO supersede decision 1's fact -- this is the ground truth the batch fix must match");
  materializeAndExec(seqDb, seqStep2.intent, "d1", "u1", NOW_BASE);

  const seqFacts = currentFactRows(seqDb);
  const seqAudits = auditActionCounts(seqDb);
  const seqSnapshot = donorSnapshot(seqDb);

  // Structural equivalence (ids are random UUIDs and legitimately differ
  // per run/scenario -- category/lifecycle/fact_text/status/supersession
  // shape must not).
  assert.deepEqual(batchFacts, seqFacts, "the batch scenario's resulting current facts and supersession chain must be structurally identical to two genuinely sequential requests");
  assert.deepEqual(batchAudits.sort(), seqAudits.sort(), "the batch scenario's audit trail shape must be structurally identical to two genuinely sequential requests");
  assert.deepEqual(batchSnapshot, seqSnapshot, "the batch scenario's synthesized donors.relationship_summary/institutional_memory must be byte-identical to two genuinely sequential requests");

  // ================================================================
  // Scenario C -- proves the bug is real: re-planning decision 2
  // against the STALE pre-batch state (emptyState, never threaded) --
  // exactly what the OLD per-decision-fresh-D1-read code effectively
  // did within one batch, since a D1 read issued while building a batch
  // cannot see that same batch's own earlier, not-yet-executed
  // statements. This must produce a DIFFERENT, WRONG result: no
  // supersession, both facts left current.
  // ================================================================
  const buggyDb = freshDatabase();
  seed(buggyDb);
  const buggyStep1 = planFactAcceptanceStep(emptyState, decisionInput("monday-int-1", NOW_BASE - 5 * 86400, TEXT_1, pinnedFresh));
  materializeAndExec(buggyDb, buggyStep1.intent, "d1", "u1", NOW_BASE);
  // The bug: decision 2 planned against emptyState (the STALE state),
  // not buggyStep1.nextState.
  const buggyStep2 = planFactAcceptanceStep(emptyState, decisionInput("monday-int-2", NOW_BASE - 1 * 86400, TEXT_2, pinnedFresh));
  assert.equal(buggyStep2.intent.supersedeFactId, null, "THE BUG (pre-fix behavior): planned against stale state, decision 2 finds no supersession target at all");
  materializeAndExec(buggyDb, buggyStep2.intent, "d1", "u1", NOW_BASE);

  const buggyFacts = currentFactRows(buggyDb);
  assert.equal(buggyFacts.filter((f) => f.status === "current").length, 2, "THE BUG: both facts wrongly left current -- exactly the incorrect result the fix eliminates");
  assert.notDeepEqual(buggyFacts, batchFacts, "the buggy (unthreaded) result must differ from the fixed (threaded) result -- proving this is a real behavior change, not a no-op refactor");

  console.log("relationship-fact-monday-supersession-race: ok");
}

await run();
