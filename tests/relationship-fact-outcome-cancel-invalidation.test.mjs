import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";
import { planFactAcceptanceStep } from "../lib/relationships/fact-accept-plan.ts";
import { activityStatus, isCompletedActivity } from "../lib/workspace/scheduled-activity.ts";

// Relationship Intelligence Phase 2 -- Outcome-route cancellation
// investigation and fix (see docs/AI-HANDOFF.md's Phase 2 section,
// "Outcome-route cancellation" for the full trace and conclusion).
//
// CONCLUSION (traced, not inferred from the word "cancel" alone):
// cancelling an activity in this route -- INCLUDING one that was already
// completed, which this route's own pre-existing convention already
// allows (nextSource wraps a "cancelled:" prefix around whatever source
// was there, even a "capture-completed:..." one; activityStatus()
// resolves "cancelled:" before "capture-completed:", so the result is
// unconditionally "cancelled" -- see lib/workspace/scheduled-activity.ts
// and the pre-existing `cancelled:${completedSource}` fixture in
// tests/activity-outcome.test.mjs, proven again below) -- genuinely
// INVALIDATES the source interaction as something that should still
// count as having happened. Proof: lib/relationships/meeting-brief.ts's
// "Last Contact"/lastCompletedInteraction computation explicitly
// excludes any interaction whose source matches 'cancelled:%'
// ("AND i.source NOT LIKE 'cancelled:%'"), even though the interaction
// row itself is preserved (never deleted) and still visible in the
// timeline, correctly labeled "cancelled" (lib/relationships/
// unified-timeline.ts). So a cancelled activity -- even a previously-
// completed, previously-accepted one -- no longer counts as real contact
// for relationship-recency purposes. Therefore any CURRENT fact that
// interaction sourced must stop being current on cancel, exactly like
// the edit route's own archive/reassignment paths (never a new
// invented behavior -- the same archival semantics, applied to a third,
// now-traced trigger).
//
// The route itself (app/api/interactions/[id]/outcome/route.ts) imports
// "cloudflare:workers" and can't be invoked directly in Node, so this
// test proves the underlying data-shape guarantee against real SQLite
// (matching tests/relationship-fact-edit-donor-reassignment.test.mjs's
// own convention and mirrored helpers), plus a structural check that the
// route actually wires this unconditionally on action === "cancel".

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
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, 'u1', 'live', ?, ?, ?)").run("d1", "Donor One", NOW, NOW);
  database.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES ('int-1', 'd1', 'u1', 'call', ?, 'Subject\nOutcome: Confirmed', ?, ?, ?)")
    .run(NOW - 3600, `capture-completed:${NOW - 7200}:completed:capture:call`, NOW, NOW);
}

// Mirrors lib/relationships/fact-accept.ts's materializeFactAcceptanceIntent().
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
  database.prepare(`UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = 86, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND relationship_summary IS ? AND institutional_memory IS ?`)
    .run(intent.relationshipSummary, intent.institutionalMemory, now, donorId, userId, intent.casRelationshipSummary, intent.casInstitutionalMemory);
}

// Mirrors lib/relationships/fact-accept.ts's planFactArchival() literally.
function planAndExecArchival(database, donorId, userId, sourceInteractionId, now) {
  const affected = database.prepare("SELECT id FROM donor_relationship_facts WHERE donor_id = ? AND user_id = ? AND source_interaction_id = ? AND status = 'current'").all(donorId, userId, sourceInteractionId);
  if (affected.length === 0) return { archivedCount: 0 };
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
  return { archivedCount: affected.length };
}

const NOTE_TEXT = "Discussed a $10,000 pledge for the building fund; he wants to think it over.";

async function run() {
  // ================================================================
  // 0: traced conclusion, re-verified directly -- cancelling an
  // already-completed activity's source is a real, already-supported
  // path (not a hypothetical): activityStatus() resolves a
  // cancelled-wrapped completed source to "cancelled", and Last
  // Contact's own SQL excludes it.
  // ================================================================
  const completedSource = `capture-completed:${NOW - 7200}:completed:capture:call`;
  assert.equal(isCompletedActivity(completedSource), true);
  assert.equal(activityStatus(`cancelled:${completedSource}`, NOW - 3600, NOW - 7200), "cancelled", "cancelling an already-completed activity's source must resolve to status 'cancelled', not 'completed' -- the pre-existing, already-tested convention this fix relies on");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
  assert.match(meetingBrief, /AND i\.occurred_at <= \? AND i\.source NOT LIKE 'cancelled:%' AND i\.source NOT LIKE 'archived:%'/, "Last Contact's own query must exclude cancelled interactions -- the actual evidence that cancellation invalidates an interaction as counted contact");

  // ================================================================
  // 1: cancelling an activity that HAD an accepted, current fact must
  // archive that fact (archived_with_source, never deleted) and
  // resynthesize the donor's Snapshot.
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    const accept = planFactAcceptanceStep(
      { facts: [], relationshipSummary: null, institutionalMemory: null },
      { donorId: "d1", userId: "u1", sourceInteractionId: "int-1", sourceInteractionOccurredAt: NOW - 3600, noteText: NOTE_TEXT, kind: "call", subject: "", now: NOW, pinnedFresh: new Set() },
    );
    assert.ok(accept.intent, "setup: the fixture note must extract a real fact");
    materializeAndExecAcceptance(database, accept.intent, "d1", "u1", NOW);
    const factId = accept.intent.newFact.id;
    assert.equal(database.prepare("SELECT status FROM donor_relationship_facts WHERE id = ?").get(factId).status, "current");
    assert.equal(database.prepare("SELECT relationship_summary FROM donors WHERE id = 'd1'").get().relationship_summary, NOTE_TEXT, "setup: the donor's snapshot must reflect the accepted fact before cancellation");

    // Cancel the (already-completed) activity.
    const { archivedCount } = planAndExecArchival(database, "d1", "u1", "int-1", NOW + 600);

    assert.equal(archivedCount, 1, "cancelling must find and archive exactly the one current fact this interaction sourced");
    const factAfterCancel = database.prepare("SELECT status, fact_text FROM donor_relationship_facts WHERE id = ?").get(factId);
    assert.equal(factAfterCancel.status, "archived_with_source", "the fact must stop being current once its source interaction is cancelled");
    assert.equal(factAfterCancel.fact_text, NOTE_TEXT, "the fact row itself must be preserved, not deleted -- still readable with its original text");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM donor_relationship_facts").get().n, 1, "no fact row is ever deleted by cancellation -- the same row transitions status in place");
    assert.equal(database.prepare("SELECT relationship_summary FROM donors WHERE id = 'd1'").get().relationship_summary, null, "the donor's snapshot must resynthesize to null once its only current fact is archived by the cancellation");
  }

  // ================================================================
  // 2: cancelling an activity that never had an accepted fact (the
  // ordinary case -- most cancelled activities were never accepted at
  // all) must be a safe no-op -- no error, no fact touched, nothing
  // created.
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    const { archivedCount } = planAndExecArchival(database, "d1", "u1", "int-1", NOW + 600);
    assert.equal(archivedCount, 0, "cancelling an activity with no accepted fact must be a pure no-op");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM donor_relationship_facts").get().n, 0);
  }

  // ================================================================
  // Structural check: the route actually wires archival unconditionally
  // on action === "cancel", never gated on currentStatus (so it applies
  // whether the activity was scheduled-only or already completed).
  // ================================================================
  const outcomeRoute = await readFile(new URL("../app/api/interactions/[id]/outcome/route.ts", import.meta.url), "utf8");
  assert.match(
    outcomeRoute,
    /if \(body\.action === "cancel"\) \{\s*const archival = await planFactArchival\(\{ donorId: existing\.donor_id, userId: profile\.id, sourceInteractionId: id, now \}\);/,
    "the outcome route must archive this interaction's current fact(s) unconditionally whenever action === \"cancel\", regardless of whether the activity was scheduled or already completed",
  );
  assert.doesNotMatch(
    outcomeRoute,
    /if \(body\.action === "cancel" && currentStatus/,
    "the cancel-archival call must never be additionally gated on currentStatus -- an already-completed activity's cancel must invalidate its fact just as much as a scheduled one's",
  );

  console.log("relationship-fact-outcome-cancel-invalidation: ok");
}

await run();
