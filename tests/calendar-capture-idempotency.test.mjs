import assert from "node:assert/strict";
import { createMeetingIdempotently, computeMeetingFingerprint, MeetingCreateKeySession } from "../lib/calendar/meeting-create-idempotency.ts";

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

async function run() {
  // --- A genuinely new save creates exactly once ---
  {
    const store = new FakeKeyStore();
    let created = 0;
    const result = await createMeetingIdempotently(store, NOW, {
      key: "key-1",
      ownerUserId: "owner-A",
      fingerprint: computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" }),
      createInteraction: async () => {
        created += 1;
        return { id: "int-1" };
      },
    });
    assert.equal(result.outcome, "created");
    assert.equal(result.interactionId, "int-1");
    assert.equal(created, 1);
  }

  // --- Retrying the SAME save (same key, same content) is a safe replay, never a second create ---
  {
    const store = new FakeKeyStore();
    let created = 0;
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const createInteraction = async () => {
      created += 1;
      return { id: `int-${created}` };
    };
    const first = await createMeetingIdempotently(store, NOW, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    const second = await createMeetingIdempotently(store, NOW + 1, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    const third = await createMeetingIdempotently(store, NOW + 2, { key: "key-retry", ownerUserId: "owner-A", fingerprint, createInteraction });
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "replayed");
    assert.equal(third.outcome, "replayed");
    assert.equal(created, 1, "only the FIRST attempt may actually create an interaction -- every retry of the same save must replay the same result");
    assert.equal(second.interactionId, first.interactionId);
    assert.equal(third.interactionId, first.interactionId);
  }

  // --- A reused key with DIFFERENT meeting content is rejected as a conflict, never silently accepted ---
  {
    const store = new FakeKeyStore();
    const fpA = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting with Donor A" });
    const fpB = computeMeetingFingerprint({ donorId: "d2", type: "meeting", occurredAt: 6000, allDay: false, allDayDate: null, summary: "Meeting with Donor B" });
    await createMeetingIdempotently(store, NOW, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpA, createInteraction: async () => ({ id: "int-A" }) });
    const conflicting = await createMeetingIdempotently(store, NOW + 1, { key: "reused-key", ownerUserId: "owner-A", fingerprint: fpB, createInteraction: async () => ({ id: "int-B" }) });
    assert.equal(conflicting.outcome, "conflict", "reusing a key with genuinely different meeting content must be rejected, never treated as a safe retry");
  }

  // --- Scoped to the authenticated owner: lookups never cross owners, even for the identical key string ---
  {
    const store = new FakeKeyStore();
    const fingerprint = computeMeetingFingerprint({ donorId: "d1", type: "meeting", occurredAt: 5000, allDay: false, allDayDate: null, summary: "Meeting" });
    const forOwnerA = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-A", fingerprint, createInteraction: async () => ({ id: "int-owner-A" }) });
    // Owner B uses the EXACT SAME key string, with DIFFERENT content --
    // must be treated as a brand-new, independent save, never see or
    // collide with owner A's record.
    const differentFingerprint = computeMeetingFingerprint({ donorId: "d9", type: "call", occurredAt: 9999, allDay: false, allDayDate: null, summary: "Totally different" });
    const forOwnerB = await createMeetingIdempotently(store, NOW, { key: "shared-literal-key", ownerUserId: "owner-B", fingerprint: differentFingerprint, createInteraction: async () => ({ id: "int-owner-B" }) });
    assert.equal(forOwnerA.outcome, "created");
    assert.equal(forOwnerB.outcome, "created", "a different owner using the identical key string must never see owner A's record as a conflict or a replay");
    assert.notEqual(forOwnerB.interactionId, forOwnerA.interactionId);

    // And a direct lookup by owner B for that key must NEVER return owner
    // A's record -- "return no other owner's record on ID collision."
    const lookedUpByB = await store.find("owner-B", "shared-literal-key");
    assert.equal(lookedUpByB.interactionId, "int-owner-B");
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
    const result = await createMeetingIdempotently(store, NOW, { key: "race-key", ownerUserId: "owner-A", fingerprint, createInteraction: async () => ({ id: "int-loser" }) });
    assert.equal(result.outcome, "replayed", "losing a creation race against an identical concurrent request must defer to the winner, not error out");
    assert.equal(result.interactionId, "int-winner");
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
