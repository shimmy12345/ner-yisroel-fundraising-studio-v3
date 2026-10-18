import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMeetingIdempotently, computeMeetingFingerprint, deriveInteractionIdForKey, MeetingCreateKeySession } from "../lib/calendar/meeting-create-idempotency.ts";

// In-memory IdempotencyKeyStore, scoped by (ownerUserId, key) exactly as
// the contract requires -- never by key alone.
class FakeKeyStore {
  constructor() {
    this.rows = new Map(); // key: `${ownerUserId}:${key}`
  }
  async find(ownerUserId, key) {
    return this.rows.get(`${ownerUserId}:${key}`) ?? null;
  }
  async save(record) {
    const k = `${record.ownerUserId}:${record.key}`;
    if (this.rows.has(k)) return false;
    this.rows.set(k, record);
    return true;
  }
}

// A real, atomic "interactions" table stand-in: create-or-find by id, with
// NO await between the existence check and the write -- the same
// guarantee a single `INSERT ... ON CONFLICT(id) DO NOTHING` SQL statement
// gives a real database engine, regardless of how many concurrent async
// callers reach this method. This is what Bug 1's fix actually depends
// on, not an accident of JS being single-threaded: see the real SQLite
// version of this same table further below, which proves the guarantee
// holds against a genuine database engine, not just this fake.
class FakeInteractionsTable {
  constructor() {
    this.rows = new Map();
    this.createCalls = 0; // every ATTEMPT, including ones that find an existing row
  }
  async createWithId(id, payload) {
    this.createCalls += 1;
    if (this.rows.has(id)) return { id, created: false };
    this.rows.set(id, { id, ...payload });
    return { id, created: true };
  }
}

const NOW = 1000;

async function run() {
  // --- A genuinely new save creates exactly once ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const result = await createMeetingIdempotently(store, NOW, {
      key: "key-1",
      ownerUserId: "owner-A",
      fingerprint: computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" }),
      createInteraction: (candidateId) => interactions.createWithId(candidateId, { donorId: "d1" }),
    });
    assert.equal(result.outcome, "created");
    assert.equal(interactions.rows.size, 1);
    assert.equal(result.interactionId, [...interactions.rows.keys()][0]);
  }

  // --- Retrying the SAME save (same key, same content) is a safe replay, never a second create ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const createInteraction = (candidateId) => interactions.createWithId(candidateId, { donorId: "d1" });
    const first = await createMeetingIdempotently(store, NOW, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    const second = await createMeetingIdempotently(store, NOW + 1, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    const third = await createMeetingIdempotently(store, NOW + 2, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "replayed");
    assert.equal(third.outcome, "replayed");
    assert.equal(interactions.rows.size, 1, "only the FIRST attempt may actually create an interaction row -- every retry of the same save must replay the same result");
    assert.equal(second.interactionId, first.interactionId);
    assert.equal(third.interactionId, first.interactionId);
  }

  // --- A reused key with DIFFERENT meeting content is rejected as a conflict, never silently accepted ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const createInteraction = (candidateId) => interactions.createWithId(candidateId, {});
    const fpA = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting with Donor A" });
    const fpB = computeMeetingFingerprint({ donorId: "d2", type: "meeting", occurredAt: 6000, allDay: false, allDayDate: null, summary: "Meeting with Donor B" });
    await createMeetingIdempotently(store, NOW, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpA, createInteraction });
    const conflicting = await createMeetingIdempotently(store, NOW + 1, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpB, createInteraction });
    assert.equal(conflicting.outcome, "conflict", "reusing a key with genuinely different meeting content must be rejected, never treated as a safe retry");
    assert.equal(interactions.rows.size, 1, "a rejected conflicting reuse of a key must never create a second interaction row");
  }

  // --- Scoped to the authenticated owner: lookups never cross owners, even for the identical key string ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const forOwnerA = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => interactions.createWithId(id, { owner: "A" }) });
    // Owner B uses the EXACT SAME key string, with DIFFERENT content --
    // must be treated as a brand-new, independent save, never see or
    // collide with owner A's record.
    const differentFingerprint = computeMeetingFingerprint({ donorId: "d9", type: "call", occurredAt: 9999, allDay: false, allDayDate: null, summary: "Totally different" });
    const forOwnerB = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-B", fingerprint: differentFingerprint, createInteraction: (id) => interactions.createWithId(id, { owner: "B" }) });
    assert.equal(forOwnerA.outcome, "created");
    assert.equal(forOwnerB.outcome, "created", "a different owner using the identical key string must never see owner A's record as a conflict or a replay");
    assert.notEqual(forOwnerB.interactionId, forOwnerA.interactionId);
    assert.equal(interactions.rows.size, 2, "two different owners sharing a literal key string must each get their own real interaction row");

    // And a direct lookup by owner B for that key must NEVER return owner
    // A's record -- "return no other owner's record on ID collision."
    const lookedUpByB = await store.find("owner-B", "shared-literal-key");
    assert.equal(lookedUpByB.interactionId, forOwnerB.interactionId);
    assert.notEqual(lookedUpByB.interactionId, forOwnerA.interactionId);
    assert.equal(lookedUpByB.ownerUserId, "owner-B");
  }

  // --- Lost race against a concurrent identical save: both callers converge on the SAME winning record ---
  {
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    class RacyStore extends FakeKeyStore {
      async save(record) {
        // Simulate: by the time this "insert" actually lands, a concurrent
        // caller's save already won (a real UNIQUE-constraint race).
        this.rows.set(`${record.ownerUserId}:${record.key}`, { ...record, interactionId: "int-winner" });
        return false; // signal "lost the race" regardless of what we just set, mirroring a DB unique-constraint rejection
      }
    }
    const store = new RacyStore();
    const interactions = new FakeInteractionsTable();
    const result = await createMeetingIdempotently(store, NOW, { key: "race-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => interactions.createWithId(id, {}) });
    assert.equal(result.outcome, "replayed", "losing a creation race against an identical concurrent request must defer to the winner, not error out");
    assert.equal(result.interactionId, "int-winner");
  }

  // =========================================================================
  // Bug 1 (2026-10-19 independent review): createInteraction() used to run
  // BEFORE the idempotency key was claimed, so two genuinely concurrent
  // calls (Promise.all) with the same owner/key/fingerprint both created a
  // real interaction row before either reached the key-claim step. The
  // fix derives a single deterministic, owner-scoped interaction id from
  // (ownerUserId, key) and routes creation through an atomic create-or-
  // find. These tests exercise TRUE simultaneous calls via Promise.all,
  // and check the actual PERSISTED interaction count, not just the
  // returned ids (the exact gap that let the original bug pass unnoticed).
  // =========================================================================

  // --- Exact reproduction from the review: two concurrent calls, same
  // owner/key/fingerprint, a callback that creates a FRESH interaction
  // each time it is actually invoked -- must still persist exactly one row. ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const request = { key: "concurrent-key", ownerUserId: "owner-A", fingerprint, createInteraction: (candidateId) => interactions.createWithId(candidateId, { donorId: "d1" }) };

    const [resultA, resultB] = await Promise.all([createMeetingIdempotently(store, NOW, request), createMeetingIdempotently(store, NOW, request)]);

    assert.equal(interactions.rows.size, 1, "exactly one interaction row must actually be persisted for two truly simultaneous identical save attempts");
    assert.equal(resultA.interactionId, resultB.interactionId, "both concurrent callers must reference the same winning interaction");
    assert.ok((resultA.outcome === "created" && resultB.outcome === "replayed") || (resultA.outcome === "replayed" && resultB.outcome === "created"), "exactly one of the two concurrent calls reports 'created'; the other reports 'replayed' -- never both 'created'");
  }

  // --- Many-way concurrency, not just two -- the same guarantee must hold
  // under a wider race. ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const request = { key: "concurrent-key-wide", ownerUserId: "owner-A", fingerprint, createInteraction: (candidateId) => interactions.createWithId(candidateId, {}) };
    const results = await Promise.all(Array.from({ length: 8 }, () => createMeetingIdempotently(store, NOW, request)));
    assert.equal(interactions.rows.size, 1, "8 truly simultaneous identical save attempts must still persist exactly one interaction row");
    const ids = new Set(results.map((r) => r.interactionId));
    assert.equal(ids.size, 1, "every one of the 8 concurrent callers must converge on the same single interaction id");
    assert.equal(results.filter((r) => r.outcome === "created").length, 1, "exactly one of the 8 concurrent callers reports 'created'");
  }

  // --- Simultaneous CONFLICTING payloads under the same key: at most one
  // interaction row is ever created; the loser(s) are rejected as a
  // conflict, never silently merged or duplicated. ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fpA = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting with Donor A" });
    const fpB = computeMeetingFingerprint({ donorId: "d2", type: "meeting", occurredAt: 6000, allDay: false, allDayDate: null, summary: "Meeting with Donor B" });
    const requestA = { key: "conflicting-key", ownerUserId: "owner-A", fingerprint: fpA, createInteraction: (id) => interactions.createWithId(id, { donorId: "d1" }) };
    const requestB = { key: "conflicting-key", ownerUserId: "owner-A", fingerprint: fpB, createInteraction: (id) => interactions.createWithId(id, { donorId: "d2" }) };

    const [resultA, resultB] = await Promise.all([createMeetingIdempotently(store, NOW, requestA), createMeetingIdempotently(store, NOW, requestB)]);

    assert.equal(interactions.rows.size, 1, "two simultaneous DIFFERENT-content saves under the same key must still persist at most one interaction row");
    const outcomes = [resultA.outcome, resultB.outcome].sort();
    assert.deepEqual(outcomes, ["conflict", "created"], "exactly one of the two conflicting concurrent saves succeeds; the other is rejected as a conflict, never silently accepted or duplicated");
  }

  // --- Owner isolation under TRUE concurrency, not just sequential calls:
  // two different owners racing the identical literal key must each get
  // their own interaction, never collide. ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const requestA = { key: "shared-key-concurrent", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => interactions.createWithId(id, { owner: "A" }) };
    const requestB = { key: "shared-key-concurrent", ownerUserId: "owner-B", fingerprint, createInteraction: (id) => interactions.createWithId(id, { owner: "B" }) };

    const [resultA, resultB] = await Promise.all([createMeetingIdempotently(store, NOW, requestA), createMeetingIdempotently(store, NOW, requestB)]);

    assert.equal(resultA.outcome, "created");
    assert.equal(resultB.outcome, "created");
    assert.notEqual(resultA.interactionId, resultB.interactionId, "two different owners racing the identical key string must never be merged into one interaction");
    assert.equal(interactions.rows.size, 2);
  }

  // --- Deterministic id derivation itself: pure, stable, owner-scoped. ---
  {
    assert.equal(deriveInteractionIdForKey("owner-A", "key-1"), deriveInteractionIdForKey("owner-A", "key-1"));
    assert.notEqual(deriveInteractionIdForKey("owner-A", "key-1"), deriveInteractionIdForKey("owner-A", "key-2"));
    assert.notEqual(deriveInteractionIdForKey("owner-A", "key-1"), deriveInteractionIdForKey("owner-B", "key-1"));
  }

  // =========================================================================
  // Same concurrency proof against a REAL SQLite-backed interactions
  // table, not only the in-memory fake -- proving the atomic create-or-
  // find guarantee holds at the database-engine level
  // (`INSERT ... ON CONFLICT(id) DO NOTHING`), not merely because of how
  // this fake's JS happens to be scheduled.
  // =========================================================================
  {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE interactions (id TEXT PRIMARY KEY, donor_id TEXT)");
    const createWithId = async (candidateId, payload) => {
      const result = db.prepare("INSERT INTO interactions (id, donor_id) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(candidateId, payload.donorId ?? null);
      const changes = Number(result.changes);
      return { id: candidateId, created: changes === 1 };
    };

    const store = new FakeKeyStore();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const request = { key: "sqlite-concurrent-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => createWithId(id, { donorId: "d1" }) };

    const [resultA, resultB] = await Promise.all([createMeetingIdempotently(store, NOW, request), createMeetingIdempotently(store, NOW, request)]);

    const rowCount = db.prepare("SELECT COUNT(*) AS n FROM interactions").get().n;
    assert.equal(rowCount, 1, "exactly one row must be persisted in the REAL SQLite table for two truly simultaneous identical save attempts");
    assert.equal(resultA.interactionId, resultB.interactionId);
    assert.ok((resultA.outcome === "created" && resultB.outcome === "replayed") || (resultA.outcome === "replayed" && resultB.outcome === "created"));
  }

  // --- MeetingCreateKeySession: retains the key across retries, rotates only after success ---
  {
    let nextId = 0;
    const session = new MeetingCreateKeySession(() => `generated-${nextId++}`);
    const keyAtStart = session.currentKey();
    assert.equal(keyAtStart, "generated-0");

    // Simulate two failed/timed-out save attempts -- the key must NOT change.
    assert.equal(session.currentKey(), keyAtStart);
    assert.equal(session.currentKey(), keyAtStart);

    // A successful save rotates the key for the NEXT, genuinely new meeting.
    session.onSaveSucceeded();
    const keyAfterSuccess = session.currentKey();
    assert.notEqual(keyAfterSuccess, keyAtStart, "a successful save must issue a fresh key for the next, genuinely new meeting");

    // That new key, too, stays stable across retries of ITS OWN save.
    assert.equal(session.currentKey(), keyAfterSuccess);
  }

  process.stdout.write("calendar-capture-idempotency.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
