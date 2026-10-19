import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enrollMeetingForSync, recordCancel, recordReopen, recordReschedule, reconcilePresentAbsent } from "../lib/calendar/calendar-sync-reconciler.ts";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { SqliteCalendarStore } from "../lib/calendar/testing/sqlite-calendar-store.ts";
import { ScriptedCalendarClient, createDeferred, ok200, ok204, err404 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Regression tests for the 4 reproducible bugs an independent review of
// commit de57005 found (2026-10-19). Each test reproduces the review's
// own exact scenario against the PUBLIC entry points
// (reconcilePresentAbsent/recordXxx), never by manually calling internal
// helpers to force the outcome.

function makeFields(interactionId) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief" };
}

const migrationDir = path.join(path.resolve(import.meta.dirname, ".."), "drizzle");
const migrations = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshSqliteStore(interactionId) {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(fs.readFileSync(path.join(migrationDir, migration), "utf8"));
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', 1000, 1000)").run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Test Donor', 1000, 1000)").run();
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, 'd1', 'u1', 'meeting', 86400, 'Meeting', 1000, 1000)").run(interactionId);
  return new SqliteCalendarStore(db);
}

async function run() {
  // =========================================================================
  // Bug 3: crash recovery fails to record confirmed creation.
  // Reproduction (exact): seed createStatus='in_flight' (representing a
  // crash after Google creation but before local confirmation); a
  // recovery reconcile GET finds the event, UPDATE succeeds; the link
  // becomes synced but (pre-fix) history.createStatus stayed 'in_flight'.
  // Then: manually delete the event, record a reschedule, GET returns
  // 404 -- pre-fix, the reconciler INSERTed again instead of reporting
  // missing_remotely. Exercised only through reconcilePresentAbsent /
  // recordReschedule -- never by manually calling resolveCreateOutcome
  // or updateHistory to force the fix's own effect.
  // =========================================================================
  for (const makeStore of [() => new InMemoryCalendarStore(), () => freshSqliteStore("int-crash-recovery")]) {
    const store = makeStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    const interactionId = "int-crash-recovery";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    const link = await store.getLinkByInteraction(interactionId);
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);

    // Seed the crash state: Google genuinely has the event (simulated by
    // the next GET returning 200), but history still shows 'in_flight' --
    // a prior attempt crashed after its INSERT call reached Google but
    // before it recorded success locally. This is test SETUP (seeding
    // initial state the real system could land in after a real crash),
    // not a call into the code path under test.
    await store.updateHistory(link.id, 0, { createStatus: "in_flight" });

    // Recovery reconcile: GET finds the event directly (the crash-
    // recovery path, never the insert/409 paths). THE FIX under test:
    // this must durably confirm createStatus='succeeded' here too.
    client.enqueueValue("get", eventId, ok200({ id: eventId, summary: "Meeting" }, "etag-1"));
    client.enqueueValue("update", eventId, ok200({ id: eventId }, "etag-2"));
    const recovery = await reconcilePresentAbsent(store, client, getFields, interactionId, "recovery-worker", now + 1);
    assert.equal(recovery.kind, "synced");

    const historyAfterRecovery = await store.getHistory(link.id, 0);
    assert.equal(historyAfterRecovery.createStatus, "succeeded", "a successful recovery GET must durably confirm createStatus, correcting a stale 'in_flight' left by a prior crash -- not just the link's own syncStatus");

    // The owner (or someone) manually deletes the event directly in
    // Google. The owner also reschedules in FOS (bumping desiredRevision,
    // which is what would trigger a real sweep to reconcile again).
    await recordReschedule(store, now + 2, interactionId);
    client.enqueueValue("get", eventId, err404());
    const afterManualDeletion = await reconcilePresentAbsent(store, client, getFields, interactionId, "recovery-worker-2", now + 3);

    assert.equal(afterManualDeletion.kind, "missing_remotely", "with createStatus correctly confirmed 'succeeded' by the recovery fix, a later 404 must be classified as a manual deletion");
    assert.ok(!client.calls.some((c) => c.op === "insert"), "the fix must prevent a silent re-INSERT after a confirmed-then-manually-deleted event -- this is exactly what the pre-fix bug got wrong");
  }

  // =========================================================================
  // Bug 4: revision/generation increments are not atomic. recordReschedule
  // used to read desiredRevision and pass desiredRevision+1 to an
  // unconditional write -- two simultaneous calls both read 1 and wrote
  // 2, losing one increment. Exercised via TRUE Promise.all concurrency,
  // against BOTH the in-memory store and the real SQLite store.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-atomic-reschedule")]]) {
    const store = makeStore();
    const now = 1000;
    const interactionId = "int-atomic-reschedule";
    const link = await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    assert.equal(link.desiredRevision, 1);

    const N = 10;
    await Promise.all(Array.from({ length: N }, () => recordReschedule(store, now + 1, interactionId)));

    const after = await store.getLinkByInteraction(interactionId);
    assert.equal(after.desiredRevision, 1 + N, `[${label}] ${N} truly simultaneous recordReschedule calls must each contribute exactly one increment -- lost updates would leave this below ${1 + N}`);
  }

  // --- Same atomicity proof for recordCancel's revision bump (only the
  // FIRST of several concurrent cancels should actually flip
  // desired_state and bump the revision; see the idempotent-cancel test
  // elsewhere for the single-cancel case -- this specifically proves no
  // revision is lost when a cancel races OTHER reschedules). ---
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-atomic-cancel-race")]]) {
    const store = makeStore();
    const now = 1000;
    const interactionId = "int-atomic-cancel-race";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });

    // 5 concurrent reschedules racing 1 concurrent cancel -- every one of
    // the 6 calls must contribute its own atomic increment, regardless of
    // final desired_state.
    const results = await Promise.all([...Array.from({ length: 5 }, () => recordReschedule(store, now + 1, interactionId)), recordCancel(store, now + 1, interactionId)]);
    assert.ok(results.every(Boolean), `[${label}] every one of the 6 concurrent calls must report success`);

    const after = await store.getLinkByInteraction(interactionId);
    assert.equal(after.desiredRevision, 1 + 6, `[${label}] 6 truly simultaneous recordReschedule/recordCancel calls must each contribute exactly one atomic increment`);
    assert.equal(after.desiredState, "absent", `[${label}] the cancel must still have taken effect`);
  }

  // --- Generation allocation atomicity: concurrent reopen attempts for
  // the SAME cancellation must allocate exactly ONE new generation
  // between them, never one generation per caller.
  //
  // Bug 3 (2026-10-21 independent review of commit 0c21a46): this test
  // previously asserted the OPPOSITE -- that N concurrent reopen calls
  // must allocate N distinct generations -- which is exactly the
  // duplicate-transition bug the review found (two remote Google events
  // for what should be a single reopened meeting). The correct
  // invariant is one generation per actual canceled-to-scheduled
  // TRANSITION, not one per caller: whichever concurrent call reaches
  // the atomic store operation first wins and performs the transition;
  // every other concurrent call for the SAME cancellation must detect
  // that transition already happened and reuse it, reporting success
  // without allocating anything further. See
  // tests/calendar-sync-regression-2026-10-21.test.mjs for the review's
  // own exact deferred-ordering reproduction (interleaved with a real
  // reconcile and a full sweep) and the stale-reopen-must-not-reopen-a-
  // later-cancellation coverage. ---
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-atomic-reopen")]]) {
    const store = makeStore();
    const now = 1000;
    const interactionId = "int-atomic-reopen";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    await recordCancel(store, now + 1, interactionId);

    const N = 6;
    const results = await Promise.all(Array.from({ length: N }, () => recordReopen(store, now + 2, interactionId)));
    assert.ok(results.every(Boolean), `[${label}] every concurrent reopen call for the SAME cancellation must report success -- whichever one wins the transition, every other correctly reuses it rather than failing`);

    const after = await store.getLinkByInteraction(interactionId);
    assert.equal(after.generation, 1, `[${label}] ${N} truly simultaneous reopen calls for the SAME cancellation must allocate exactly ONE new generation -- one per real transition, never one per caller`);

    // Only the one real generation has a history row; no further
    // generation was ever allocated for any of the other N-1 callers.
    const history = await store.getHistory(after.id, 1);
    assert.ok(history, `[${label}] generation 1 must have its own history row`);
    assert.equal(await store.getHistory(after.id, 2), null, `[${label}] no generation beyond 1 must ever have been allocated`);
  }

  // --- The SAME concurrent-reopen race, but proving it is specifically
  // the SHARED cancellation that collapses to one generation -- genuinely
  // SEPARATE, sequential cancel/reopen cycles must still each allocate
  // their own distinct generation, one per real transition. ---
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-sequential-reopen")]]) {
    const store = makeStore();
    const now = 1000;
    const interactionId = "int-sequential-reopen";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    for (let i = 1; i <= 3; i++) {
      await recordCancel(store, now + i, interactionId);
      const ok = await recordReopen(store, now + i, interactionId);
      assert.ok(ok, `[${label}] sequential reopen ${i} must succeed`);
    }
    const after = await store.getLinkByInteraction(interactionId);
    assert.equal(after.generation, 3, `[${label}] 3 genuinely separate cancel/reopen cycles must allocate 3 distinct generations, one per real transition -- the fix must not collapse unrelated, non-overlapping reopens together`);
  }

  // =========================================================================
  // "Also inspect the cancellation helper's async lifetime": a bare
  // `return reconcileDeleteCurrentGeneration(...)` (no await) inside the
  // try block let the surrounding finally{} release the lease BEFORE the
  // helper's own lease-protected bookkeeping writes completed. Proven by
  // suspending the DELETE call and checking the lease is still held while
  // it's pending, only released after it resolves AND the bookkeeping is
  // correctly persisted.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    const interactionId = "int-cancel-lease-lifetime";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);

    // First, actually create the event so there's something to delete.
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok200({ id: eventId }, "etag-1"));
    const created = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 1);
    assert.equal(created.kind, "synced");

    await recordCancel(store, now + 2, interactionId);

    const deferredDelete = createDeferred();
    client.enqueue("delete", eventId, () => deferredDelete.promise);
    const cancelAttempt = reconcilePresentAbsent(store, client, getFields, interactionId, "w2", now + 3);
    await new Promise((resolve) => setImmediate(resolve)); // let it reach the suspended DELETE

    const whileDeletePending = await store.getLinkByInteraction(interactionId);
    assert.equal(whileDeletePending.leaseOwner, "w2", "the lease must still be held by the cancelling worker while its own DELETE call is still pending -- a premature release (the bug) would show this as null here");

    deferredDelete.resolve(ok204());
    const cancelOutcome = await cancelAttempt;
    assert.equal(cancelOutcome.kind, "deleted");

    const afterCancel = await store.getLinkByInteraction(interactionId);
    assert.equal(afterCancel.leaseOwner, null, "the lease must be released once the delete helper's own work is actually finished");
    assert.equal(afterCancel.syncStatus, "synced", "the cancellation's own bookkeeping (syncStatus/syncedRevision) must have been successfully written before the lease was released -- a premature release would have made this write silently fail against an already-cleared lease");
    assert.equal(afterCancel.syncedRevision, afterCancel.desiredRevision);
    const history = await store.getHistory(whileDeletePending.id, 0);
    assert.equal(history.cleanupStatus, "done", "the history bookkeeping must also have been written successfully before lease release");
  }

  process.stdout.write("calendar-sync-regression-2026-10-19.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
