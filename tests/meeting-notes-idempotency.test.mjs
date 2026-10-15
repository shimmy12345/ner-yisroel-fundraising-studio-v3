import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { interactionContentMatches, followUpListsMatch } from "../lib/meeting-notes/idempotency.ts";

// Meeting Notes save idempotency -- CONTROLLED, SYNTHETIC-DATA
// VERIFICATION (docs/AI-HANDOFF.md, "Meeting Notes Final Safeguards and
// AI Readiness"). No real donor data anywhere in this file. Same
// established convention as tests/pledge-balance-correction-e2e.test.mjs:
// a fresh in-memory SQLite database built from the real committed
// migrations, write helpers that mirror app/api/meeting-notes/route.ts's
// own control flow (not a reimplementation), using the REAL, actually-
// imported interactionContentMatches/followUpListsMatch -- never mocked.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-10-15T14:00:00Z") / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)")
    .run(id, userId, displayName, NOW, NOW);
}
function getInteraction(db, id) { return db.prepare("SELECT * FROM interactions WHERE id = ?").get(id); }
function countInteractions(db) { return db.prepare("SELECT COUNT(*) AS cnt FROM interactions").get().cnt; }
function countRecommendations(db) { return db.prepare("SELECT COUNT(*) AS cnt FROM recommendations").get().cnt; }
function existingFollowUps(db, interactionId, maxFollowUps = 20) {
  const candidateIds = Array.from({ length: maxFollowUps }, (_, index) => `meeting-note-${interactionId}-${index}`);
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, action, due_at FROM recommendations WHERE id IN (${placeholders})`).all(...candidateIds);
  return rows.map((row) => ({ index: candidateIds.indexOf(row.id), description: row.action, dueAtEpoch: row.due_at }));
}

// Mirrors app/api/meeting-notes/route.ts's own control flow exactly:
// interaction insert FIRST (so a conflict on it short-circuits before any
// follow-up statement is even attempted -- the real route puts both in
// ONE D1.batch() call for true atomicity; node:sqlite has no multi-
// statement batch, so this mirror instead proves the call ORDERING and
// the compare-on-conflict DECISION logic, same documented limitation as
// tests/pledge-balance-correction-e2e.test.mjs -- true cross-statement
// rollback is D1's own batch guarantee, not re-provable in a single-
// process Node test.
function attemptSave(db, { interactionId, donorId, userId = "u1", type, occurredAtEpoch, occurredAtDateOnly, summary, followUps }) {
  const incomingContent = { donorId, type, occurredAtEpoch, occurredAtDateOnly, summary };
  let followUpStatementsAttempted = 0;
  try {
    db.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, occurred_at_date_only, summary, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'meeting-notes:manual', ?, ?)`)
      .run(interactionId, donorId, userId, type, occurredAtEpoch, occurredAtDateOnly ? 1 : 0, summary, NOW, NOW);
  } catch (error) {
    if (!/UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error))) throw error;
    // Conflict on the interaction row itself -- the real route never
    // attempts any follow-up statement once this happens (both are in
    // the same batch); this mirror enforces the same short-circuit by
    // simply returning before the follow-up insert loop below.
    const existing = getInteraction(db, interactionId);
    const existingContent = { donorId: existing.donor_id, type: existing.type, occurredAtEpoch: existing.occurred_at, occurredAtDateOnly: existing.occurred_at_date_only === 1, summary: existing.summary };
    const existingFollows = existingFollowUps(db, interactionId);
    const isReplay = interactionContentMatches(existingContent, incomingContent) && followUpListsMatch(existingFollows, followUps);
    return isReplay
      ? { status: 200, saved: true, followUpsCreated: 0, followUpStatementsAttempted }
      : { status: 409, error: "conflict", followUpStatementsAttempted };
  }
  for (const followUp of followUps) {
    followUpStatementsAttempted += 1;
    db.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Follow-up proposed from meeting notes.', 90, 'open', ?, ?, ?)`)
      .run(`meeting-note-${interactionId}-${followUp.index}`, donorId, userId, followUp.description, followUp.dueAtEpoch, NOW, NOW);
  }
  return { status: 201, saved: true, followUpsCreated: followUps.length, followUpStatementsAttempted };
}

// --- Pure comparison function coverage ---

const base = { donorId: "d1", type: "meeting", occurredAtEpoch: 1000, occurredAtDateOnly: true, summary: "Met about the building fund." };
assert.equal(interactionContentMatches(base, { ...base }), true);
assert.equal(interactionContentMatches(base, { ...base, summary: "Different text." }), false);
assert.equal(interactionContentMatches(base, { ...base, donorId: "d2" }), false, "a reused key under a different donor must never be treated as a replay");
assert.equal(interactionContentMatches(base, { ...base, occurredAtEpoch: 2000 }), false);
assert.equal(interactionContentMatches(base, { ...base, occurredAtDateOnly: false }), false);

const f = (index, description, dueAtEpoch = null) => ({ index, description, dueAtEpoch });
assert.equal(followUpListsMatch([f(0, "Call back")], [f(0, "Call back")]), true);
assert.equal(followUpListsMatch([f(0, "Call back")], [f(0, "Call back"), f(1, "A new one")]), false, "more follow-ups than were originally saved must never be a replay");
assert.equal(followUpListsMatch([f(0, "Call back"), f(1, "Second")], [f(0, "Call back")]), false, "fewer follow-ups than were originally saved must never be a replay");
assert.equal(followUpListsMatch([f(0, "Call back")], [f(0, "Edited text")]), false);
assert.equal(followUpListsMatch([f(0, "Call back", 500)], [f(0, "Call back", 999)]), false, "a changed due date is a content change");
assert.equal(followUpListsMatch([], []), true);

// --- Identical retry: no additional writes, treated as a successful replay ---

{
  const db = freshDatabase();
  // The committed migrations seed one demo interaction/recommendation
  // pair (used for the app's own demo mode) -- every count assertion
  // below is relative to this baseline, never an assumed-zero start.
  const baseInteractions = countInteractions(db);
  const baseRecommendations = countRecommendations(db);
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Test Donor" });
  const key = "idem-key-identical";
  const payload = { interactionId: key, donorId: "donor-1", type: "meeting", occurredAtEpoch: 2000, occurredAtDateOnly: true, summary: "Synthetic test note.", followUps: [f(0, "Call after Yom Tov", 3000)] };

  const first = attemptSave(db, payload);
  assert.equal(first.status, 201);
  assert.equal(first.followUpsCreated, 1);
  assert.equal(countInteractions(db), baseInteractions + 1);
  assert.equal(countRecommendations(db), baseRecommendations + 1);

  const retry = attemptSave(db, payload); // byte-identical request
  assert.equal(retry.status, 200, "an identical retry must be treated as a successful replay, not an error");
  assert.equal(retry.followUpsCreated, 0, "a replay creates nothing new");
  assert.equal(retry.followUpStatementsAttempted, 0, "the follow-up insert loop must never even run on a replay");
  assert.equal(countInteractions(db), baseInteractions + 1, "still exactly one new interaction after the retry");
  assert.equal(countRecommendations(db), baseRecommendations + 1, "still exactly one new recommendation after the retry");

  const retryAgain = attemptSave(db, payload); // a second retry, proving this isn't a one-shot fluke
  assert.equal(retryAgain.status, 200);
  assert.equal(countInteractions(db), baseInteractions + 1);
  assert.equal(countRecommendations(db), baseRecommendations + 1);
}

// --- Changed-payload retry under the same key: rejected, nothing written ---

{
  const db = freshDatabase();
  const baseInteractions = countInteractions(db);
  const baseRecommendations = countRecommendations(db);
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Test Donor" });
  const key = "idem-key-changed";
  const original = { interactionId: key, donorId: "donor-1", type: "meeting", occurredAtEpoch: 2000, occurredAtDateOnly: true, summary: "Original synthetic note.", followUps: [f(0, "Call after Yom Tov", 3000)] };
  attemptSave(db, original);
  assert.equal(countInteractions(db), baseInteractions + 1);
  assert.equal(countRecommendations(db), baseRecommendations + 1);

  // Same key, different summary text -- must be rejected outright.
  const changedSummary = { ...original, summary: "A completely different note, as if an attacker or a buggy retry changed the content." };
  const r1 = attemptSave(db, changedSummary);
  assert.equal(r1.status, 409);
  assert.equal(r1.followUpStatementsAttempted, 0, "no follow-up statement may run once the interaction itself conflicts");
  assert.equal(countInteractions(db), baseInteractions + 1, "the original interaction must be completely unchanged");
  assert.equal(getInteraction(db, key).summary, "Original synthetic note.", "the stored summary must still be the original, never overwritten");
  assert.equal(countRecommendations(db), baseRecommendations + 1, "no additional recommendation may be created");

  // Same key, same summary, but an ADDITIONAL follow-up -- the exact
  // vulnerability this task asked to close (previously: INSERT OR IGNORE
  // on follow-ups independently could let a changed-content retry add
  // extra tasks even though the interaction itself was unchanged).
  const extraFollowUp = { ...original, followUps: [...original.followUps, f(1, "A second, never-approved task that must never be created")] };
  const r2 = attemptSave(db, extraFollowUp);
  assert.equal(r2.status, 409);
  assert.equal(countRecommendations(db), baseRecommendations + 1, "a changed-payload retry must never be able to add an additional follow-up");
  assert.equal(db.prepare("SELECT COUNT(*) AS cnt FROM recommendations WHERE action LIKE '%never-approved%'").get().cnt, 0);

  // Same key, a follow-up's due date changed -- also rejected, also no write.
  const changedDueDate = { ...original, followUps: [f(0, "Call after Yom Tov", 9999999)] };
  const r3 = attemptSave(db, changedDueDate);
  assert.equal(r3.status, 409);
  assert.equal(existingFollowUps(db, key)[0].dueAtEpoch, 3000, "the original follow-up's due date must be completely unchanged");
}

// --- "Concurrent" retries: two calls with the same key, same content,
// arriving in either order, must converge on the identical safe outcome
// (sequential execution in this Node test inherently serializes them;
// true simultaneous-arrival safety is D1's own single-writer/transactional
// guarantee for a real batch() call against the live database, not
// reproducible in-process -- see this file's attemptSave doc comment). ---

{
  const db = freshDatabase();
  const baseInteractions = countInteractions(db);
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Test Donor" });
  const key = "idem-key-concurrent";
  const payload = { interactionId: key, donorId: "donor-1", type: "meeting", occurredAtEpoch: 2000, occurredAtDateOnly: true, summary: "Race-condition test note.", followUps: [] };

  const results = [attemptSave(db, payload), attemptSave(db, payload), attemptSave(db, payload)];
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 201], "exactly one of the three identical calls creates the row; the rest are safe replays");
  assert.equal(countInteractions(db), baseInteractions + 1, "three identical concurrent-style saves must still produce exactly one new interaction");
}

// --- Partial-failure safety: a conflict on the interaction row itself
// must prevent ANY follow-up statement from running, so a half-applied
// save (interaction written, follow-ups not, or vice versa) can never
// happen from this route's own call ordering. ---

{
  const db = freshDatabase();
  const baseRecommendations = countRecommendations(db);
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Test Donor" });
  const key = "idem-key-partial";
  const payload = { interactionId: key, donorId: "donor-1", type: "meeting", occurredAtEpoch: 2000, occurredAtDateOnly: true, summary: "Note.", followUps: [f(0, "First"), f(1, "Second"), f(2, "Third")] };
  attemptSave(db, payload);
  assert.equal(countRecommendations(db), baseRecommendations + 3);

  // Retried with one fewer follow-up (a buggy/malicious shortened retry):
  // conflicts on the interaction row before even reaching the follow-up
  // loop, so the two still-present original follow-ups are untouched and
  // nothing is removed or added.
  const shortened = { ...payload, followUps: payload.followUps.slice(0, 2) };
  const result = attemptSave(db, shortened);
  assert.equal(result.status, 409);
  assert.equal(result.followUpStatementsAttempted, 0);
  assert.equal(countRecommendations(db), baseRecommendations + 3, "all three original follow-ups must survive a rejected, shortened retry untouched");
}

console.log("meeting-notes-idempotency.test.mjs: all assertions passed");
