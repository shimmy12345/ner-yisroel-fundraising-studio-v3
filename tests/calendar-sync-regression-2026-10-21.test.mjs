import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enrollMeetingForSync, recordCancel, recordReopen, recordReschedule, reconcilePresentAbsent, runReconciliationSweep } from "../lib/calendar/calendar-sync-reconciler.ts";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { SqliteCalendarStore } from "../lib/calendar/testing/sqlite-calendar-store.ts";
import { StatefulCalendarClient } from "../lib/calendar/testing/stateful-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Regression tests for Bug 3 of the 2026-10-21 independent review of
// commit 0c21a46: "overlapping reopen requests can allocate two new
// generations for a single cancellation," plus the same stale-state
// class in applyCancel/applyReschedule the review asked be inspected.
// Each test reproduces the review's own exact scenario against the
// PUBLIC entry points (recordXxx/reconcilePresentAbsent/
// runReconciliationSweep) wherever possible; the exact deferred-ordering
// reproduction below additionally orchestrates the raw store primitives
// directly (store.applyReopen) to get the SAME precise, deliberate
// control over "both callers read the same stale state, one wins, the
// other resumes later" that the 2026-10-20 regression file used for
// store.insertLink to reproduce a crash -- not a call into any internal
// (non-interface) helper to force the fix's own effect.

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
  // The exact review reproduction, end to end, with a STATEFUL simulated
  // Google calendar (so "exactly one active event exists" is checked
  // against the fake's own real event store, not only a call log):
  //  1. Enroll a meeting, then cancel it.
  //  2. Two reopen requests both read desiredState=absent at generation 0
  //     (captured once here, representing what BOTH concurrent callers
  //     independently read before either won).
  //  3. The first applyReopen completes, creating generation 1.
  //  4. Reconcile generation 1 -- creates its simulated Google event.
  //  5. The second (stale) applyReopen, still carrying generation 0 as
  //     its target, finally runs its atomic store operation.
  //  6. Run the normal reconciliation sweep.
  // Pre-fix, actual result: two remote events (generations 1 and 2),
  // generation 1's history falsely shows cleanupNeeded=false with no
  // pending cleanup, and the link points only to generation 2 -- a real
  // orphaned, permanently-live duplicate Google event. THE FIX: the
  // second, stale request must recognize generation 1 as the already-
  // won transition and reuse it, never allocating generation 2 at all.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-overlap-reopen")]]) {
    const store = makeStore();
    const client = new StatefulCalendarClient();
    const now = 1000;
    const interactionId = "int-overlap-reopen";
    const getFields = async () => makeFields(interactionId);

    // 1. Enroll, then cancel.
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    await recordCancel(store, now + 1, interactionId);

    // 2. Both reopen requests read the SAME current state (generation 0,
    // absent) -- captured once, since that is genuinely what two truly
    // concurrent recordReopen callers would each have independently read
    // via their own getLinkByInteraction call, before either had won.
    const linkBeforeEitherReopen = await store.getLinkByInteraction(interactionId);
    assert.equal(linkBeforeEitherReopen.generation, 0);
    assert.equal(linkBeforeEitherReopen.desiredState, "absent");
    const linkId = linkBeforeEitherReopen.id;
    const capturedGeneration = linkBeforeEitherReopen.generation;

    // 3. The FIRST reopen's atomic store operation completes, creating
    // generation 1.
    const firstReopen = await store.applyReopen(linkId, capturedGeneration, now + 2);
    assert.ok(firstReopen, `[${label}] the winning reopen must succeed`);
    assert.equal(firstReopen.generation, 1);
    assert.equal(firstReopen.desiredState, "present");

    // 4. Reconcile generation 1 -- GET 404 (never created), INSERT
    // succeeds -- creating its real simulated Google event.
    const reconcileGen1 = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 3);
    assert.equal(reconcileGen1.kind, "synced", `[${label}] generation 1 must sync successfully`);
    const gen1EventId = deriveGoogleEventId(interactionId, 1);
    assert.deepEqual(client.activeEventIds("primary"), [gen1EventId], `[${label}] exactly generation 1's event must exist on the simulated calendar after it syncs`);

    // 5. The SECOND, stale reopen request -- still carrying
    // capturedGeneration=0, the generation it read before either reopen
    // had won -- finally runs its own atomic store operation now.
    const secondReopen = await store.applyReopen(linkId, capturedGeneration, now + 4);
    assert.ok(secondReopen, `[${label}] the stale reopen request must still be told "reopened" -- it must not be told its request failed, since the meeting genuinely IS open again`);
    assert.equal(secondReopen.generation, 1, `[${label}] the stale reopen must reuse generation 1 -- it must NOT allocate a second new generation for the same cancellation`);

    // 6. Run the normal reconciliation sweep -- there must be nothing
    // left for it to create (no phantom generation 2 ever existed) and
    // generation 0's real prior cleanup obligation must still complete.
    const sweepResult = await runReconciliationSweep(store, client, getFields, "sweep", now + 5);

    const finalLink = await store.getLinkByInteraction(interactionId);
    assert.equal(finalLink.generation, 1, `[${label}] the link must still point at generation 1 only`);
    assert.equal(finalLink.syncStatus, "synced");
    assert.equal(client.activeEventIds("primary").length, 1, `[${label}] exactly ONE active event must exist after the sweep settles -- the pre-fix bug produced two (generations 1 and 2)`);
    assert.deepEqual(client.activeEventIds("primary"), [gen1EventId], `[${label}] generation 1's event specifically, never a generation-2 duplicate`);

    assert.equal(await store.getHistory(linkId, 2), null, `[${label}] no generation-2 history row must ever have been created`);

    const historyGen1 = await store.getHistory(linkId, 1);
    assert.equal(historyGen1.createStatus, "succeeded");
    assert.equal(historyGen1.cleanupNeeded, false, `[${label}] generation 1 (the real, current, live meeting) must never be marked needing cleanup`);

    // Preserve all prior cleanup obligations: generation 0's cancellation
    // (from step 1, before either reopen) must still have been honored --
    // its cleanup must have resolved (it was never actually created, so
    // "done" with no real event to find, exactly as it would without any
    // of this round's changes).
    const historyGen0 = await store.getHistory(linkId, 0);
    assert.equal(historyGen0.cleanupNeeded, true);
    assert.equal(historyGen0.cleanupStatus, "done", `[${label}] generation 0's pre-existing cleanup obligation must still be honored by the sweep, unaffected by the reopen race on generation 1`);

    // No cleanup remains pending for this link at all.
    const stillPending = (await store.listPendingCleanup(now + 5)).filter((h) => h.linkId === linkId);
    assert.equal(stillPending.length, 0, `[${label}] no pending cleanup must remain`);
    assert.ok(sweepResult.cleaned.length >= 1, `[${label}] the sweep must actually have attempted generation 0's cleanup`);
  }

  // =========================================================================
  // A stale reopen request must not reopen a LATER, separately canceled
  // meeting it was never asked to reopen. The request captured
  // generation 0 (absent); by the time it finally runs, the meeting has
  // since been reopened to generation 1 AND cancelled again -- a
  // different cancellation entirely. The stale request must be rejected,
  // not silently reopen whatever generation happens to be absent now.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-stale-reopen")]]) {
    const store = makeStore();
    const client = new StatefulCalendarClient();
    const now = 1000;
    const interactionId = "int-stale-reopen";
    const getFields = async () => makeFields(interactionId);

    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    await recordCancel(store, now + 1, interactionId);
    const staleLink = await store.getLinkByInteraction(interactionId);
    const staleCapturedGeneration = staleLink.generation; // 0 -- this is the stale request's own transition identity

    // A full, unrelated reopen/cancel cycle happens before the stale
    // request ever runs its own store operation: generation 0 -> 1
    // (reopened), then cancelled AGAIN (generation 1, absent).
    await recordReopen(store, now + 2, interactionId);
    await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 3);
    await recordCancel(store, now + 4, interactionId);

    const beforeStaleResume = await store.getLinkByInteraction(interactionId);
    assert.equal(beforeStaleResume.generation, 1);
    assert.equal(beforeStaleResume.desiredState, "absent");

    // The stale request finally runs, still carrying generation 0.
    const staleResult = await store.applyReopen(staleLink.id, staleCapturedGeneration, now + 5);
    assert.equal(staleResult, null, `[${label}] a stale reopen request must be rejected -- it must never reopen generation 1's SEPARATE, later cancellation it was never asked about`);

    const afterStaleResume = await store.getLinkByInteraction(interactionId);
    assert.equal(afterStaleResume.generation, 1, `[${label}] the rejected stale reopen must leave the link completely unchanged`);
    assert.equal(afterStaleResume.desiredState, "absent", `[${label}] generation 1's real, later cancellation must still stand -- untouched by the stale request`);

    // The real, current cancellation (generation 1) can still be
    // reopened normally and correctly through the public entry point.
    const realReopen = await recordReopen(store, now + 6, interactionId);
    assert.ok(realReopen, `[${label}] the genuinely current cancellation must still be reopenable normally`);
    const finalLink = await store.getLinkByInteraction(interactionId);
    assert.equal(finalLink.generation, 2);
  }

  // =========================================================================
  // applyCancel: a delayed cancel request must target cleanup at the
  // CURRENT generation at the moment it actually runs, never a stale
  // generation it happened to read earlier. Reproduction: the meeting is
  // cancelled, reconciled (its event deleted), reopened, and reconciled
  // again (a new event created) BEFORE a "delayed" cancel request
  // finally executes -- it must flag and successfully clean up the REAL
  // current generation, never silently miss it (the exact Bug 2-shaped
  // symptom -- "cleanup cannot find history... cancellation reports
  // 'delete failed' without sending any Google DELETE" -- that a stale
  // generation parameter would reproduce here).
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-delayed-cancel")]]) {
    const store = makeStore();
    const client = new StatefulCalendarClient();
    const now = 1000;
    const interactionId = "int-delayed-cancel";
    const getFields = async () => makeFields(interactionId);

    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 1); // creates generation 0's event

    // A full cancel -> cleanup -> reopen -> create cycle happens,
    // advancing the meeting to generation 1, BEFORE the "delayed" cancel
    // (representing a request that, pre-fix, would have captured
    // generation 0 at some earlier point) finally runs.
    await recordCancel(store, now + 2, interactionId);
    await reconcilePresentAbsent(store, client, getFields, interactionId, "w2", now + 3); // deletes generation 0's event
    await recordReopen(store, now + 4, interactionId);
    await reconcilePresentAbsent(store, client, getFields, interactionId, "w3", now + 5); // creates generation 1's event

    const gen1EventId = deriveGoogleEventId(interactionId, 1);
    assert.deepEqual(client.activeEventIds("primary"), [gen1EventId]);

    // The delayed cancel finally executes now, through the public
    // recordCancel entry point. THE FIX: store.applyCancel determines
    // the generation to flag FRESH, atomically, from the live row --
    // never from any value a caller captured earlier.
    const delayedCancelResult = await recordCancel(store, now + 6, interactionId);
    assert.ok(delayedCancelResult, `[${label}] the delayed cancel must succeed`);

    const link = await store.getLinkByInteraction(interactionId);
    assert.equal(link.generation, 1);
    const historyGen1 = await store.getHistory(link.id, 1);
    assert.equal(historyGen1.cleanupNeeded, true, `[${label}] the delayed cancel must flag the CURRENT generation (1) for cleanup -- a stale generation-0 target would leave this false and the real live event permanently stuck`);

    // Reconciling the cancellation must actually send a real Google
    // DELETE for generation 1's event, not report "delete failed"
    // without ever attempting it.
    const cancelOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w4", now + 7);
    assert.equal(cancelOutcome.kind, "deleted", `[${label}] cancellation must actually succeed and target the correct, current generation's real event`);
    assert.equal(client.activeEventIds("primary").length, 0, `[${label}] no event must remain active once cancellation settles`);
    assert.ok(client.calls.some((c) => c.op === "delete" && c.eventId === gen1EventId), `[${label}] a real DELETE must have been sent for generation 1's actual event`);
  }

  // =========================================================================
  // applyReschedule: a reschedule request must be rejected -- not bump
  // the revision of an absent meeting -- if the meeting has genuinely
  // been cancelled by the moment its OWN atomic store operation runs,
  // regardless of what any caller read earlier. Exercised directly
  // against store.applyReschedule (the same store-primitive-level
  // precision used above and in the 2026-10-20 file), proving the
  // precondition lives IN the atomic operation itself.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", () => new InMemoryCalendarStore()], ["sqlite", () => freshSqliteStore("int-stale-reschedule")]]) {
    const store = makeStore();
    const now = 1000;
    const interactionId = "int-stale-reschedule";

    const enrolled = await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    assert.equal(enrolled.desiredRevision, 1);

    await recordCancel(store, now + 1, interactionId);
    const afterCancel = await store.getLinkByInteraction(interactionId);
    assert.equal(afterCancel.desiredRevision, 2);
    assert.equal(afterCancel.desiredState, "absent");

    // A reschedule's own atomic operation, finally running against the
    // NOW-cancelled meeting -- must be rejected by applyReschedule
    // itself, atomically, not merely by a caller's own earlier check
    // (which, under the pre-fix code, could have read 'present' before
    // this cancellation ever happened).
    const staleReschedule = await store.applyReschedule(enrolled.id, now + 2);
    assert.equal(staleReschedule, null, `[${label}] applyReschedule must reject when the meeting is not 'present' AT THE MOMENT it runs, regardless of any earlier read`);

    const afterStaleReschedule = await store.getLinkByInteraction(interactionId);
    assert.equal(afterStaleReschedule.desiredRevision, 2, `[${label}] the rejected reschedule must not have bumped the revision`);
    assert.equal(afterStaleReschedule.desiredState, "absent");

    // The public recordReschedule entry point reports the same rejection
    // as a plain `false`, never throwing or silently appearing to
    // succeed.
    const publicResult = await recordReschedule(store, now + 3, interactionId);
    assert.equal(publicResult, false, `[${label}] recordReschedule must report false for a cancelled meeting, via applyReschedule's own atomic check -- not a stale pre-check in recordReschedule itself (removed by this fix)`);
  }

  process.stdout.write("calendar-sync-regression-2026-10-21.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
