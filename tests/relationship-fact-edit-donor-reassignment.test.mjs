import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";
import { planFactAcceptanceStep } from "../lib/relationships/fact-accept-plan.ts";

// Relationship Intelligence Phase 2 -- regression coverage for the
// edit-route donor-reassignment principle explicitly approved for this
// checkpoint (see docs/AI-HANDOFF.md's Phase 2 section): when an
// interaction moves from Donor A to Donor B (app/api/interactions/[id]/
// route.ts's PATCH handler, donorId !== existing.donor_id), any CURRENT
// relationship fact that interaction sourced for Donor A must stop being
// current (archived_with_source -- never deleted), but Donor B must NOT
// automatically receive a transferred/recreated fact just because the
// interaction moved. Donor B can only get a new fact through the same
// normal explicit-acceptance flow (acceptRelationshipSnapshot === true)
// every other accept path already requires.
//
// The route file itself imports "cloudflare:workers" and can't be
// invoked directly in Node (this repo's established constraint -- see
// tests/relationship-fact-monday-supersession-race.test.mjs's own header
// for the same note), so this test proves the underlying data-shape
// guarantee directly against a real SQLite database (matching this
// repo's own convention -- tests/relationship-facts-schema.test.mjs,
// tests/asks.test.mjs), using the exact real pure functions
// (planFactAcceptanceStep, synthesizeRelationshipSnapshot) and mirroring
// planFactArchival()'s own literal SQL (lib/relationships/fact-accept.ts)
// for the archival half, which has no pure-function form to import
// directly. A separate structural check (below) confirms the route
// itself actually wires archival-on-reassignment plus a
// still-explicit-acceptance-gated new fact, matching this proof.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-08-22T12:00:00Z") / 1000);

function seed(database) {
  database.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("u1", "owner@example.test", NOW, NOW);
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, 'u1', 'live', ?, ?, ?)").run("donor-a", "Donor A", NOW, NOW);
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, 'u1', 'live', ?, ?, ?)").run("donor-b", "Donor B", NOW, NOW);
  // The interaction being edited/reassigned -- initially belongs to
  // Donor A, matching the route's own pre-edit `existing.donor_id`.
  database.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES ('int-1', 'donor-a', 'u1', 'call', ?, 'Subject\nNote', 'capture:call', ?, ?)")
    .run(NOW - 2 * 86400, NOW, NOW);
}

// Mirrors lib/relationships/fact-accept.ts's materializeFactAcceptanceIntent()
// literally, same as tests/relationship-fact-monday-supersession-race.test.mjs.
function materializeAndExecAcceptance(database, intent, donorId, userId, now) {
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

// Mirrors lib/relationships/fact-accept.ts's planFactArchival() literally
// -- no pure-function form exists to import directly (unlike
// acceptance's planFactAcceptanceStep()), since this task's fix was
// scoped to the acceptance race, not archival.
function planAndExecArchival(database, donorId, userId, sourceInteractionId, now) {
  const affected = database.prepare("SELECT id FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND source_interaction_id = ? AND status = 'current'").all(donorId, userId, sourceInteractionId);
  if (affected.length === 0) return;
  for (const fact of affected) {
    database.prepare("UPDATE donor_relationship_facts SET status = 'archived_with_source', updated_at = ? WHERE id = ? AND status = 'current'").run(now, fact.id);
    database.prepare(`INSERT INTO donor_relationship_fact_changes (id, fact_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'archived_with_source', ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), fact.id, userId, donorId, JSON.stringify(["status"]), JSON.stringify({ status: "current" }), JSON.stringify({ status: "archived_with_source" }), now);
  }
  const allCurrent = database.prepare("SELECT id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND status = 'current'").all(donorId, userId);
  const remaining = allCurrent
    .filter((fact) => !affected.some((item) => item.id === fact.id))
    .map((fact) => ({ factText: fact.fact_text, category: fact.category, lifecycle: fact.lifecycle, status: "current", sourceInteractionId: fact.source_interaction_id, sourceInteractionOccurredAt: fact.source_interaction_occurred_at }));
  const donorRow = database.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").get(donorId, userId);
  const synthesis = synthesizeRelationshipSnapshot(remaining, now, new Set());
  database.prepare(`UPDATE donors SET relationship_summary = ?, institutional_memory = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND relationship_summary IS ? AND institutional_memory IS ?`)
    .run(synthesis.relationshipSummary, synthesis.institutionalMemory, now, donorId, userId, donorRow?.relationship_summary ?? null, donorRow?.institutional_memory ?? null);
}

function allFactRows(database) {
  return database.prepare("SELECT id, donor_id, status, fact_text FROM donor_relationship_facts ORDER BY created_at").all();
}

const NOTE_TEXT = "Discussed a $10,000 pledge for the building fund; he wants to think it over.";

async function run() {
  const database = freshDatabase();
  seed(database);

  // ---- Setup: Donor A has one accepted, current fact sourced from
  // int-1 (the interaction about to be reassigned). ----
  const initialAccept = planFactAcceptanceStep(
    { facts: [], relationshipSummary: null, institutionalMemory: null },
    { donorId: "donor-a", userId: "u1", sourceInteractionId: "int-1", sourceInteractionOccurredAt: NOW - 2 * 86400, noteText: NOTE_TEXT, kind: "call", subject: "", now: NOW, pinnedFresh: new Set() },
  );
  assert.ok(initialAccept.intent, "setup: the fixture note must extract a real fact");
  materializeAndExecAcceptance(database, initialAccept.intent, "donor-a", "u1", NOW);
  const oldFactId = initialAccept.intent.newFact.id;

  assert.equal(allFactRows(database).length, 1, "setup: exactly one fact row exists before reassignment");
  assert.deepEqual({ ...database.prepare("SELECT donor_id, status FROM donor_relationship_facts WHERE id = ?").get(oldFactId) }, { donor_id: "donor-a", status: "current" });

  // ================================================================
  // Reassignment: int-1 moves from Donor A to Donor B (PATCH,
  // donorId !== existing.donor_id). The route archives Donor A's
  // current fact(s) sourced from int-1 -- independent of whether a new
  // acceptance for Donor B happens at all.
  // ================================================================
  planAndExecArchival(database, "donor-a", "u1", "int-1", NOW + 3600);

  // ---- 1: old donor's fact becomes non-current. ----
  const oldFactAfterReassignment = database.prepare("SELECT donor_id, status FROM donor_relationship_facts WHERE id = ?").get(oldFactId);
  assert.equal(oldFactAfterReassignment.status, "archived_with_source", "Donor A's fact must stop being current once its source interaction leaves Donor A");

  // ---- 2: old fact remains historically preserved (still readable, not
  // deleted -- proven below by the row-count invariant too). ----
  const preserved = database.prepare("SELECT id, fact_text FROM donor_relationship_facts WHERE id = ?").get(oldFactId);
  assert.equal(preserved.fact_text, NOTE_TEXT, "the archived fact's own text must remain exactly as originally accepted -- never rewritten");

  // ---- 5 (part 1): no fact row physically reassigned between donors --
  // the archived fact's donor_id must still be Donor A's, never changed
  // to Donor B's. ----
  assert.equal(oldFactAfterReassignment.donor_id, "donor-a", "archival must never change donor_id -- a fact belongs to the donor it was originally accepted for, permanently");

  // ---- 3: new donor (Donor B) gets NO fact merely because the
  // interaction was reassigned -- reassignment alone (no acceptance
  // call at all here) must leave Donor B with zero facts. ----
  const donorBFactsBeforeAcceptance = database.prepare("SELECT COUNT(*) AS n FROM donor_relationship_facts WHERE donor_id = 'donor-b'").get();
  assert.equal(donorBFactsBeforeAcceptance.n, 0, "Donor B must receive no fact from a bare reassignment -- only the normal explicit-acceptance flow can create one");

  // ================================================================
  // Now the fundraiser explicitly re-accepts the (edited, now
  // Donor-B-owned) interaction's Relationship Snapshot --
  // acceptRelationshipSnapshot === true, attributed to int-1's own id,
  // for the new donor.
  // ================================================================
  const reacceptState = { facts: [], relationshipSummary: null, institutionalMemory: null }; // Donor B's own working state -- no prior facts
  const reaccept = planFactAcceptanceStep(reacceptState, {
    donorId: "donor-b", userId: "u1", sourceInteractionId: "int-1", sourceInteractionOccurredAt: NOW - 2 * 86400, noteText: NOTE_TEXT, kind: "call", subject: "", now: NOW + 3600, pinnedFresh: new Set(),
  });
  assert.ok(reaccept.intent, "explicit re-acceptance for Donor B must produce a real intent");
  materializeAndExecAcceptance(database, reaccept.intent, "donor-b", "u1", NOW + 3600);
  const newFactId = reaccept.intent.newFact.id;

  // ---- 4: with explicit acceptance, the new donor gets a NEW fact with
  // correct provenance (attributed to int-1, the interaction actually
  // being edited -- and a genuinely new row, never the old fact
  // resurrected or repurposed). ----
  const newFact = database.prepare("SELECT donor_id, status, source_interaction_id, fact_text FROM donor_relationship_facts WHERE id = ?").get(newFactId);
  assert.equal(newFact.donor_id, "donor-b");
  assert.equal(newFact.status, "current");
  assert.equal(newFact.source_interaction_id, "int-1", "the new fact's provenance must be int-1 -- the interaction actually being edited");
  assert.notEqual(newFactId, oldFactId, "the new fact must be a genuinely new row, never the old (Donor A) fact's own row reused or repurposed");

  // ---- 5 (part 2): no fact row physically deleted -- the total row
  // count only ever grows (1 after setup, still 1 after archival, 2
  // after the new acceptance), never shrinks. ----
  const finalRows = allFactRows(database);
  assert.equal(finalRows.length, 2, "no fact row is ever deleted -- archival transitions status in place, acceptance adds a new row; the total count must simply be setup(1) + acceptance(1) = 2");
  assert.deepEqual(finalRows.map((r) => r.donor_id).sort(), ["donor-a", "donor-b"], "exactly one fact per donor, each still attached to its own original donor_id");
  assert.deepEqual(finalRows.map((r) => r.status).sort(), ["archived_with_source", "current"]);

  // ---- Donor A's own snapshot resynthesizes to blank once its only
  // fact is archived (no other current facts remain for Donor A). ----
  const donorASnapshot = database.prepare("SELECT relationship_summary FROM donors WHERE id = 'donor-a'").get();
  assert.equal(donorASnapshot.relationship_summary, null, "Donor A's relationship_summary must resynthesize to null once its only current fact is archived");
  const donorBSnapshot = database.prepare("SELECT relationship_summary FROM donors WHERE id = 'donor-b'").get();
  assert.equal(donorBSnapshot.relationship_summary, NOTE_TEXT, "Donor B's relationship_summary must reflect its own newly-accepted fact");

  // ================================================================
  // Structural check: the real route actually wires this shape --
  // archival on reassignment, a still-independently-gated acceptance for
  // the (possibly new) donor, and never a special "transfer this fact"
  // code path.
  // ================================================================
  const editRoute = await readFile(new URL("../app/api/interactions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(
    editRoute,
    /if \(donorId !== existing\.donor_id\) \{\s*const archival = await planFactArchival\(\{ donorId: existing\.donor_id, userId: profile\.id, sourceInteractionId: id, now \}\);/,
    "the route must archive the OLD donor's fact(s) on reassignment, scoped to existing.donor_id (the donor being left), never the new donorId",
  );
  assert.match(
    editRoute,
    /if \(body\.acceptRelationshipSnapshot === true && !scheduled\) \{\s*const plan = await planFactAcceptance\(\{\s*donorId, userId: profile\.id, sourceInteractionId: id,/,
    "the route's acceptance call must target `donorId` (the possibly-new donor) and remain independently gated on an explicit acceptRelationshipSnapshot === true -- never automatic just because donorId changed",
  );
  assert.doesNotMatch(editRoute, /UPDATE donor_relationship_facts SET donor_id/i, "the route must never reassign a fact row's donor_id directly -- a fact belongs permanently to the donor it was accepted for");

  console.log("relationship-fact-edit-donor-reassignment: ok");
}

await run();
