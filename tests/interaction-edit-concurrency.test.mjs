// Generic interaction edit concurrency safety (2026-10-21, third
// follow-up review -- defect A: "app/api/interactions/[id]/route.ts
// checks expectedSummary before writing, but its UPDATE remains
// unconditional. A concurrent trip completion or notes save can land
// after that check and then be overwritten. Enforce concurrency
// protection at the database write. Ensure a rejected edit cannot
// change reminders, relationship facts, donor assignment, or other
// companion state."). Calls the REAL, unmodified `applyInteractionEdit`
// exported from lib/capture/interaction-edit.ts -- the exact function
// app/api/interactions/[id]/route.ts's PATCH handler uses -- against a
// real in-memory SQLite database built from this repo's own
// migrations, intercepting "cloudflare:workers" the same way
// tests/trip-reconciliation-concurrency.test.mjs already does for
// lib/relationships/trips-data.ts's own functions (fact-accept.ts has
// the identical `env.DB` dependency shape). Never a hand-copied
// reproduction of its SQL.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);

const { env } = await import("./helpers/cloudflare-workers-shim.mjs");
const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const { applyInteractionEdit } = await import("../lib/capture/interaction-edit.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const USER_ID = "u1";
const DONOR_A = "donor-a";
const DONOR_B = "donor-b";
const INTERACTION_ID = "interaction-1";

function freshDb(initialSummary) {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Donor A', ?, ?)").bind(DONOR_A, USER_ID, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Donor B', ?, ?)").bind(DONOR_B, USER_ID, NOW, NOW).run();
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, 'call', ?, ?, 'capture:call', ?, ?)")
    .bind(INTERACTION_ID, DONOR_A, USER_ID, NOW - 86400, initialSummary, NOW, NOW).run();
  return db;
}

function interaction(db) {
  const row = db.raw().prepare("SELECT donor_id, summary, source FROM interactions WHERE id = ?").get(INTERACTION_ID);
  return { donorId: row.donor_id, summary: row.summary, source: row.source };
}

function reminderRow(db, reminderId) {
  const row = db.raw().prepare("SELECT action, due_at FROM recommendations WHERE id = ?").get(reminderId);
  return row ? { action: row.action, due_at: row.due_at } : null;
}

function factRows(db, donorId) {
  return db.raw().prepare("SELECT id, status, source_interaction_id FROM donor_relationship_facts WHERE donor_id = ? ORDER BY id").all(donorId)
    .map((row) => ({ id: row.id, status: row.status, source_interaction_id: row.source_interaction_id }));
}

const baseInput = (overrides = {}) => ({
  interactionId: INTERACTION_ID, userId: USER_ID, existingDonorId: DONOR_A, donorId: DONOR_A,
  type: "call", summary: "Subject\nUpdated note.", casBaseline: "Subject\nOriginal note.",
  source: "capture:call", occurredAtEpoch: NOW, now: NOW, reminderId: `activity-${INTERACTION_ID}`,
  reminderDueAtEpoch: null, reminderNextAction: "Follow up", acceptRelationshipSnapshot: false,
  scheduled: false, note: "Original note.", subject: "Subject",
  ...overrides,
});

async function run() {
  // --- 1. An ordinary, non-stale edit applies: the interaction row
  // updates, and a requested reminder is created. ---
  {
    const db = freshDb("Subject\nOriginal note.");
    env.DB = db;
    const outcome = await applyInteractionEdit(db, baseInput({ reminderDueAtEpoch: NOW + 86400 }));
    assert.deepEqual(outcome, { status: "applied", relationshipUpdated: false });
    assert.equal(interaction(db).summary, "Subject\nUpdated note.");
    assert.deepEqual(reminderRow(db, `activity-${INTERACTION_ID}`), { action: "Follow up", due_at: NOW + 86400 });
  }

  // --- 2. THE CONFIRMED DEFECT: an edit reads the interaction, another
  // notes save or completion lands in the gap (simulated here by
  // directly mutating the row to a NEWER value between "read" and this
  // call, mirroring exactly what a concurrent trip completion/notes
  // save would do), then the edit attempts its write using the NOW-
  // STALE value it originally read as its `casBaseline`. The edit must
  // be rejected, AND -- the actual bug being closed -- no reminder, no
  // relationship-fact statement, and no donor reassignment may happen
  // either. ---
  {
    const db = freshDb("Subject\nOriginal note.");
    env.DB = db;
    const readBaseline = interaction(db).summary; // "the edit's own read"
    // A concurrent trip completion appends its own note in the gap.
    db.raw().prepare("UPDATE interactions SET summary = ? WHERE id = ?").run("Subject\nOriginal note.\n\n--- Marked completed ---\nCompletion note.", INTERACTION_ID);
    const concurrentState = interaction(db).summary;

    const outcome = await applyInteractionEdit(db, baseInput({
      casBaseline: readBaseline, // stale -- the edit never saw the completion's own write
      donorId: DONOR_B, // also requests a donor reassignment
      reminderDueAtEpoch: NOW + 86400,
      acceptRelationshipSnapshot: true,
      note: "A detailed note about a generous new pledge commitment and upcoming visit plans.",
    }));
    assert.deepEqual(outcome, { status: "conflict", currentSummary: concurrentState });
    // Nothing the rejected edit would have done actually happened:
    assert.equal(interaction(db).donorId, DONOR_A, "donor reassignment must never apply on a rejected edit");
    assert.equal(interaction(db).summary, concurrentState, "the concurrent completion's own note must survive completely untouched -- never overwritten by the rejected edit, never reverted to the stale pre-edit value either");
    assert.equal(reminderRow(db, `activity-${INTERACTION_ID}`), null, "no reminder may be created by a rejected edit");
    assert.deepEqual(factRows(db, DONOR_A), [], "no relationship fact may be archived off Donor A by a rejected edit");
    assert.deepEqual(factRows(db, DONOR_B), [], "no relationship fact may be created for Donor B by a rejected edit, even though acceptRelationshipSnapshot was requested");
  }

  // --- 3. Donor reassignment on a SUCCESSFUL edit still archives any
  // current fact the interaction sourced for the OLD donor -- a
  // companion write that must actually happen when the edit is not
  // rejected (the fix must not accidentally suppress legitimate writes
  // while closing off rejected ones). ---
  {
    const db = freshDb("Subject\nOriginal note.");
    env.DB = db;
    // Seed a current fact Donor A has sourced from this exact interaction.
    db.raw().prepare(`INSERT INTO donor_relationship_facts (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, status, fingerprint, created_at, updated_at)
        VALUES ('fact-1', ?, ?, 'general', 'durable', 'Existing fact text', ?, ?, 'current', 'fingerprint-1', ?, ?)`)
      .run(DONOR_A, USER_ID, INTERACTION_ID, NOW - 86400, NOW, NOW);

    const outcome = await applyInteractionEdit(db, baseInput({ donorId: DONOR_B, casBaseline: "Subject\nOriginal note." }));
    assert.equal(outcome.status, "applied");
    assert.equal(interaction(db).donorId, DONOR_B);
    const factsA = factRows(db, DONOR_A);
    assert.equal(factsA.length, 1);
    assert.equal(factsA[0].status, "archived_with_source", "the old donor's current fact sourced from this interaction must be archived once the reassignment actually applies");
  }

  console.log("interaction-edit-concurrency.test.mjs: all assertions passed");
}

await run();
