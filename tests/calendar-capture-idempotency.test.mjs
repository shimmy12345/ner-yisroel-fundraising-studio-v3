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

const NOW = 1000;

function payload(overrides = {}) {
  return { donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, endAt: 5900, location: null, summary: "Meeting", ...overrides };
}

// A real, atomic "interactions" table stand-in: create-or-find by id, with
// NO await between the existence check and the write -- the same
// guarantee a single `INSERT ... ON CONFLICT(id) DO NOTHING` SQL statement
// gives a real database engine, regardless of how many concurrent async
// callers reach this method. This is what Bug 1's fix actually depends
// on, not an accident of JS being single-threaded: see the real SQLite
// version of this same table further below, which proves the guarantee
// holds against a genuine database engine, not just this fake.
//
// 2026-10-20 review fix: `createWithId` now always returns `persistedFields`
// -- the ACTUAL content stored at that id (whichever call wrote it) -- so
// createMeetingIdempotently can verify content, not just existence.
class FakeInteractionsTable {
  constructor() {
    this.rows = new Map();
    this.createCalls = 0; // every ATTEMPT, including ones that find an existing row
  }
  async createWithId(id, meetingPayload) {
    this.createCalls += 1;
    const existing = this.rows.get(id);
    if (existing) return { id, created: false, persistedFields: { ...existing } };
    this.rows.set(id, { ...meetingPayload });
    return { id, created: true, persistedFields: { ...meetingPayload } };
  }
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function run() {
  // --- A genuinely new save creates exactly once ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const result = await createMeetingIdempotently(store, NOW, {
      key: "key-1",
      ownerUserId: "owner-A",
      fingerprint: computeMeetingFingerprint(payload()),
      createInteraction: (candidateId) => interactions.createWithId(candidateId, payload()),
    });
    assert.equal(result.outcome, "created");
    assert.equal(interactions.rows.size, 1);
    assert.equal(result.interactionId, [...interactions.rows.keys()][0]);
  }

  // --- Retrying the SAME save (same key, same content) is a safe replay, never a second create ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint(payload());
    const createInteraction = (candidateId) => interactions.createWithId(candidateId, payload());
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
    const fpA = computeMeetingFingerprint(payload({ summary: "Meeting with Donor A" }));
    const fpB = computeMeetingFingerprint(payload({ donorId: "d2", occurredAt: 6000, summary: "Meeting with Donor B" }));
    await createMeetingIdempotently(store, NOW, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpA, createInteraction: (id) => interactions.createWithId(id, payload({ summary: "Meeting with Donor A" })) });
    const conflicting = await createMeetingIdempotently(store, NOW + 1, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpB, createInteraction: (id) => interactions.createWithId(id, payload({ donorId: "d2", occurredAt: 6000, summary: "Meeting with Donor B" })) });
    assert.equal(conflicting.outcome, "conflict", "reusing a key with genuinely different meeting content must be rejected, never treated as a safe retry");
    assert.equal(interactions.rows.size, 1, "a rejected conflicting reuse of a key must never create a second interaction row");
  }

  // --- Fingerprint includes end time/duration and location (2026-10-20 review) ---
  {
    const base = payload({ endAt: 5900, location: "Office" });
    const differentEnd = payload({ endAt: 7200, location: "Office" });
    const differentLocation = payload({ endAt: 5900, location: "Donor's home" });
    assert.notEqual(computeMeetingFingerprint(base), computeMeetingFingerprint(differentEnd), "a different end time/duration must change the fingerprint");
    assert.notEqual(computeMeetingFingerprint(base), computeMeetingFingerprint(differentLocation), "a different location must change the fingerprint");
  }

  // --- Scoped to the authenticated owner: lookups never cross owners, even for the identical key string ---
  {
    const store = new FakeKeyStore();
    const interactions = new FakeInteractionsTable();
    const fingerprint = computeMeetingFingerprint(payload());
    const forOwnerA = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => interactions.createWithId(id, payload()) });
    // Owner B uses the EXACT SAME key string, with DIFFERENT content --
    // must be treated as a brand-new, independent save, never see or
    // collide with owner A's record.
    const differentFingerprint = computeMeetingFingerprint(payload({ donorId: "d9", type: "call", occurredAt: 9999, endAt: 9999, summary: "Totally different" }));
    const forOwnerB = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-B", fingerprint: differentFingerprint, createInteraction: (id) => interactions.createWithId(id, payload({ donorId: "d9", type: "call", occurredAt: 9999, endAt: 9999, summary: "Totally different" })) });
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
    const fingerprint = computeMeetingFingerprint(payload());
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
    const result = await createMeetingIdempotently(store, NOW, { key: "race-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => interactions.createWithId(id, payload()) });
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
    const fingerprint = computeMeetingFingerprint(payload());
    const request = { key: "concurrent-key", ownerUserId: "owner-A", fingerprint, createInteraction: (candidateId) => interactions.createWithId(candidateId, payload()) };

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
    const fingerprint = computeMeetingFingerprint(payload());
    const request = { key: "concurrent-key-wide", ownerUserId: "owner-A", fingerprint, createInteraction: (candidateId) => interactions.createWithId(candidateId, payload()) };
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
    const fpA = computeMeetingFingerprint(payload({ summary: "Meeting with Donor A" }));
    const fpB = computeMeetingFingerprint(payload({ donorId: "d2", occurredAt: 6000, summary: "Meeting with Donor B" }));
    const requestA = { key: "conflicting-key", ownerUserId: "owner-A", fingerprint: fpA, createInteraction: (id) => interactions.createWithId(id, payload({ summary: "Meeting with Donor A" })) };
    const requestB = { key: "conflicting-key", ownerUserId: "owner-A", fingerprint: fpB, createInteraction: (id) => interactions.createWithId(id, payload({ donorId: "d2", occurredAt: 6000, summary: "Meeting with Donor B" })) };

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
    const requestA = { key: "shared-key-concurrent", ownerUserId: "owner-A", fingerprint: computeMeetingFingerprint(payload({ summary: "Owner A's meeting" })), createInteraction: (id) => interactions.createWithId(id, payload({ summary: "Owner A's meeting" })) };
    const requestB = { key: "shared-key-concurrent", ownerUserId: "owner-B", fingerprint: computeMeetingFingerprint(payload({ summary: "Owner B's meeting" })), createInteraction: (id) => interactions.createWithId(id, payload({ summary: "Owner B's meeting" })) };

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
  function sqliteInteractionsTable() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE interactions (id TEXT PRIMARY KEY, donor_id TEXT, type TEXT, occurred_at INTEGER, all_day INTEGER, all_day_date TEXT, end_at INTEGER, location TEXT, summary TEXT)");
    const toFields = (row) => ({ donorId: row.donor_id, type: row.type, occurredAt: row.occurred_at, allDay: Boolean(row.all_day), allDayDate: row.all_day_date, endAt: row.end_at, location: row.location, summary: row.summary });
    const createWithId = (candidateId, meetingPayload) => {
      const insertResult = db
        .prepare("INSERT INTO interactions (id, donor_id, type, occurred_at, all_day, all_day_date, end_at, location, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(candidateId, meetingPayload.donorId, meetingPayload.type, meetingPayload.occurredAt, meetingPayload.allDay ? 1 : 0, meetingPayload.allDayDate, meetingPayload.endAt, meetingPayload.location, meetingPayload.summary);
      const created = Number(insertResult.changes) === 1;
      const row = db.prepare("SELECT * FROM interactions WHERE id = ?").get(candidateId);
      return Promise.resolve({ id: candidateId, created, persistedFields: toFields(row) });
    };
    return { db, createWithId };
  }

  {
    const { db, createWithId } = sqliteInteractionsTable();
    const store = new FakeKeyStore();
    const fingerprint = computeMeetingFingerprint(payload());
    const request = { key: "sqlite-concurrent-key", ownerUserId: "owner-A", fingerprint, createInteraction: (id) => createWithId(id, payload()) };

    const [resultA, resultB] = await Promise.all([createMeetingIdempotently(store, NOW, request), createMeetingIdempotently(store, NOW, request)]);

    const rowCount = db.prepare("SELECT COUNT(*) AS n FROM interactions").get().n;
    assert.equal(rowCount, 1, "exactly one row must be persisted in the REAL SQLite table for two truly simultaneous identical save attempts");
    assert.equal(resultA.interactionId, resultB.interactionId);
    assert.ok((resultA.outcome === "created" && resultB.outcome === "replayed") || (resultA.outcome === "replayed" && resultB.outcome === "created"));
  }

  // =========================================================================
  // Bug 1 (2026-10-20 independent review): "conflicting saves can mismatch
  // the saved meeting and idempotency record." Exact reproduction: request
  // A's create-or-find writes meeting A's content and then pauses before
  // returning; request B (same owner/key, DIFFERENT fingerprint) runs its
  // own create-or-find, finds A's already-persisted content, and (pre-fix)
  // reported "replayed" using B's OWN fingerprint -- leaving the persisted
  // meeting as A's content but the idempotency record pointing at
  // fingerprint B. Checks ACTUAL PERSISTED CONTENT and BOTH responses, not
  // just outcome strings. Run against both the in-memory and SQLite
  // interactions tables.
  // =========================================================================
  for (const useSqlite of [false, true]) {
    const { table, getPersisted } = useSqlite
      ? (() => {
          const { db, createWithId } = sqliteInteractionsTable();
          return { table: { createWithId }, getPersisted: (id) => db.prepare("SELECT * FROM interactions WHERE id = ?").get(id) };
        })()
      : (() => {
          const fake = new FakeInteractionsTable();
          return { table: fake, getPersisted: (id) => fake.rows.get(id) };
        })();

    const store = new FakeKeyStore();
    const key = "shared-key";
    const ownerUserId = "owner-A";
    const payloadA = payload({ summary: "Meeting A", donorId: "donor-A" });
    const payloadB = payload({ summary: "Meeting B", donorId: "donor-B" });
    const fingerprintA = computeMeetingFingerprint(payloadA);
    const fingerprintB = computeMeetingFingerprint(payloadB);
    const candidateId = deriveInteractionIdForKey(ownerUserId, key);

    // Request A's create-or-find: writes meeting A's content immediately,
    // but the call back to createMeetingIdempotently is held open
    // (deferred) until resumed explicitly below -- modeling "pauses
    // before returning" from the exact reproduction.
    const deferredA = createDeferred();
    let aHasWritten = false;
    const requestA = {
      key,
      ownerUserId,
      fingerprint: fingerprintA,
      createInteraction: async (id) => {
        const result = await table.createWithId(id, payloadA);
        aHasWritten = true;
        await deferredA.promise; // pause here -- the write already landed, the call just hasn't returned yet
        return result;
      },
    };
    const attemptA = createMeetingIdempotently(store, NOW, requestA);

    // Let A's write actually land before B starts (reproduces "its
    // createInteraction(candidateId) atomically inserts meeting A, then
    // pauses before returning").
    while (!aHasWritten) await new Promise((resolve) => setImmediate(resolve));

    // Request B: same owner/key, DIFFERENT fingerprint. Its own
    // create-or-find finds A's already-persisted content.
    const requestB = { key, ownerUserId, fingerprint: fingerprintB, createInteraction: (id) => table.createWithId(id, payloadB) };
    const resultB = await createMeetingIdempotently(store, NOW + 1, requestB);

    // THE FIX: B must detect that the persisted content (A's) doesn't
    // match what B asked for, and must report "conflict" -- never
    // "replayed" for content that was never actually saved for B.
    assert.equal(resultB.outcome, "conflict", `[sqlite=${useSqlite}] B must see a conflict -- the persisted content belongs to A's request, not B's`);

    // B must NOT have saved an idempotency record at all (never with its
    // own mismatched fingerprint).
    const keyRecordAfterB = await store.find(ownerUserId, key);
    assert.equal(keyRecordAfterB, null, `[sqlite=${useSqlite}] B's conflict must never result in a saved idempotency record`);

    // Resume A.
    deferredA.resolve();
    const resultA = await attemptA;
    assert.equal(resultA.outcome, "created", `[sqlite=${useSqlite}] A, whose content actually matches what was persisted, must succeed`);
    assert.equal(resultA.interactionId, candidateId);

    // Final state must be fully consistent: the persisted meeting is A's
    // content, AND the idempotency record's fingerprint is A's -- never a
    // B-fingerprint pointing at A's content (the exact bug).
    const persisted = getPersisted(candidateId);
    assert.ok(persisted, `[sqlite=${useSqlite}] the interaction must actually exist`);
    const persistedSummary = useSqlite ? persisted.summary : persisted.summary;
    assert.equal(persistedSummary, "Meeting A", `[sqlite=${useSqlite}] the actually persisted content must be A's, never B's`);
    const keyRecordFinal = await store.find(ownerUserId, key);
    assert.ok(keyRecordFinal, `[sqlite=${useSqlite}] the idempotency record must exist after A completes`);
    assert.equal(keyRecordFinal.fingerprint, fingerprintA, `[sqlite=${useSqlite}] the saved fingerprint must match the ACTUAL persisted content (A's), never a mismatched one`);
    assert.equal(keyRecordFinal.interactionId, candidateId);
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
