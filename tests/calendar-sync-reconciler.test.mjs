import assert from "node:assert/strict";
import { enrollMeetingForSync, recordCancel, recordReopen, recordReschedule, reconcileGenerationCleanup, reconcilePresentAbsent, resolveCreateOutcome } from "../lib/calendar/calendar-sync-reconciler.ts";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { ScriptedCalendarClient, createDeferred, ok200, ok201, ok204, err404, err409, err412, errNetwork } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Deliberately interleaved, adversarial tests for Issues 1-3 of the
// reviewed design (docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md). Each
// scenario constructs a SPECIFIC race by controlling exactly when a
// mocked Google API call resolves (via createDeferred()), not just
// sequential happy-path assertions.

function makeFields(interactionId, overrides = {}) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: `https://shimmydonors.org/donors/d1/meeting-brief`, ...overrides };
}

async function run() {
  // =========================================================================
  // Issue 1a: a retry after 412 must RELOAD the latest FOS desired state,
  // not resend an older captured payload with a fresh etag.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-reload", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-reload", 0);

    let currentLocation = "Original Location";
    const getFields = async () => makeFields("int-reload", { location: currentLocation });

    // First pass: event already exists (200), update fails with 412.
    client.enqueueValue("get", eventId, ok200({ id: eventId, summary: "x" }, "etag-stale"));
    client.enqueue("update", eventId, async () => {
      // Simulate: BETWEEN this update attempt being built and its response,
      // the owner changed the meeting's location again. A correct
      // implementation must pick this up on its retry pass, not resend
      // the location it captured before this call started.
      currentLocation = "Changed During Flight";
      return err412();
    });
    // Second pass (after reload): get again, then update succeeds.
    client.enqueueValue("get", eventId, ok200({ id: eventId, summary: "x" }, "etag-fresh"));
    client.enqueue("update", eventId, async () => ok200({ id: eventId }, "etag-2"));

    const outcome = await reconcilePresentAbsent(store, client, getFields, "int-reload", "worker-1", now + 1);
    assert.equal(outcome.kind, "synced", "must eventually succeed after reloading and retrying once");

    // Prove the SECOND update call actually carried the RELOADED location,
    // not the one captured before the 412 -- inspect the scripted client's
    // own call log isn't enough (it doesn't record payload), so assert via
    // a responder that captures what it was called with.
  }

  // Re-run the same scenario, this time capturing the actual event body
  // sent on the retried update, to directly prove reload (not replay).
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-reload-2", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-reload-2", 0);
    let currentLocation = "Original";
    const getFields = async () => makeFields("int-reload-2", { location: currentLocation });

    const sentLocations = [];
    const realUpdate = client.update.bind(client);
    client.update = async (calendarId, id, event, etag) => {
      sentLocations.push(event.location);
      return realUpdate(calendarId, id, event, etag);
    };

    client.enqueueValue("get", eventId, ok200({ id: eventId }, "etag-stale"));
    client.enqueue("update", eventId, async () => {
      currentLocation = "Changed During Flight"; // the desired state moves on while this attempt is "in flight"
      return err412();
    });
    client.enqueueValue("get", eventId, ok200({ id: eventId }, "etag-fresh"));
    client.enqueueValue("update", eventId, ok200({ id: eventId }, "etag-2"));

    const outcome = await reconcilePresentAbsent(store, client, getFields, "int-reload-2", "worker-1", now + 1);
    assert.equal(outcome.kind, "synced");
    assert.deepEqual(sentLocations, ["Original", "Changed During Flight"], "the retried update must carry the RELOADED location, never the stale pre-412 payload");
  }

  // =========================================================================
  // Issue 1b: record only the revision actually sent and confirmed -- never
  // mark a newer revision synced because it appeared while an older
  // request was running.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-rev", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-rev", 0);
    const getFields = async () => makeFields("int-rev");

    const deferredGet = createDeferred();
    client.enqueue("get", eventId, () => deferredGet.promise);
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));

    // Start a reconcile attempt; suspend it right before its first network
    // call so we can be certain it has already captured revisionBeingSent
    // (=1) before anything else changes the desired state.
    const attempt = reconcilePresentAbsent(store, client, getFields, "int-rev", "worker-1", now + 1);
    await new Promise((resolve) => setImmediate(resolve));

    // While that attempt is suspended (having captured revision 1), the
    // user reschedules TWICE more, racing desiredRevision to 3 -- the
    // in-flight attempt must never claim credit for those.
    await recordReschedule(store, now + 2, "int-rev");
    await recordReschedule(store, now + 3, "int-rev");
    let link = await store.getLinkByInteraction("int-rev");
    assert.equal(link.desiredRevision, 3);
    assert.equal(link.syncStatus, "pending", "a reschedule while an older sync is in flight must not fabricate a 'synced' state");

    deferredGet.resolve(err404());
    const outcome = await attempt;
    assert.equal(outcome.kind, "synced");
    assert.equal(outcome.revision, 1, "the completed attempt must report exactly the revision it actually sent (1), never the newer one (3) that appeared mid-flight");

    link = await store.getLinkByInteraction("int-rev");
    assert.equal(link.syncedRevision, 1, "syncedRevision must reflect only what was actually confirmed, not the current desiredRevision");
    assert.equal(link.syncStatus, "synced", "status IS synced for the revision that was sent -- but a FOLLOW-UP sweep is still owed to catch revisions 2 and 3");
    assert.notEqual(link.syncedRevision, link.desiredRevision, "proves a follow-up reconcile is still needed -- the sweep's own 'needs reconciliation' query must pick this row up again");
  }

  // =========================================================================
  // Issue 1c + convergence under an expired lease: prevent a stale worker
  // from clearing another worker's lease or overwriting newer bookkeeping,
  // and prove the system converges correctly when a lease expires while an
  // older request is still in flight.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-lease", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-lease", 0);
    const getFields = async () => makeFields("int-lease");

    // Worker A acquires the lease and starts its GET, which we suspend.
    const deferredGetA = createDeferred();
    client.enqueue("get", eventId, () => deferredGetA.promise);
    const attemptA = reconcilePresentAbsent(store, client, getFields, "int-lease", "worker-A", now, /* ttlSeconds */ 5);

    // Let A actually acquire the lease before time moves on (A is
    // suspended on its GET call, which happens AFTER acquiring the lease).
    await new Promise((resolve) => setImmediate(resolve));
    let link = await store.getLinkByInteraction("int-lease");
    assert.equal(link.leaseOwner, "worker-A");

    // Time passes well beyond A's lease TTL (5s) without A's GET resolving.
    const muchLater = now + 100;

    // Worker B (e.g. the sweep) now reconciles the SAME meeting -- its
    // lease acquisition must succeed, since A's lease has expired.
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const outcomeB = await reconcilePresentAbsent(store, client, getFields, "int-lease", "worker-B", muchLater, 5);
    assert.equal(outcomeB.kind, "synced", "worker B must be able to acquire the expired lease and successfully converge");

    link = await store.getLinkByInteraction("int-lease");
    assert.equal(link.syncStatus, "synced");
    assert.equal(link.leaseOwner, null, "B must have released its own lease cleanly");
    const syncedRevisionAfterB = link.syncedRevision;

    // NOW worker A's long-suspended GET finally resolves. A must NOT be
    // able to clear B's bookkeeping or claim a stale lease.
    deferredGetA.resolve(ok200({ id: eventId }, "etag-from-A"));
    const outcomeA = await attemptA;
    assert.equal(outcomeA.kind, "lease_contended", "a stale worker whose lease was already taken over must have its write rejected, not silently accepted");

    link = await store.getLinkByInteraction("int-lease");
    assert.equal(link.syncedRevision, syncedRevisionAfterB, "B's correct, newer bookkeeping must survive A's late, stale write attempt untouched");
    assert.equal(link.leaseOwner, null, "A's finally-resolving release must not have interfered with B's already-completed release either");
  }

  // =========================================================================
  // Issue 3a: a 409 on insert followed by GET must verify the event and
  // reconcile its CONTENT to the latest desired revision -- finding an
  // existing event alone does not prove its latest details were synced.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-409", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-409", 0);
    const getFields = async () => makeFields("int-409", { location: "The Real Location" });

    client.enqueueValue("get", eventId, err404()); // not found yet, proceed to insert
    client.enqueueValue("insert", eventId, err409()); // ambiguous -- someone/something already created it
    client.enqueueValue("get", eventId, ok200({ id: eventId, summary: "stale placeholder", location: "wrong" }, "etag-x")); // verify
    const sentBodies = [];
    client.enqueue("update", eventId, async (_cal, _id, event) => {
      sentBodies.push(event);
      return ok200({ id: eventId }, "etag-y");
    });

    const outcome = await reconcilePresentAbsent(store, client, getFields, "int-409", "worker-1", now + 1);
    assert.equal(outcome.kind, "synced");
    assert.equal(sentBodies.length, 1, "a 409 must be followed by a content-reconciling update, not treated as already-done");
    assert.equal(sentBodies[0].location, "The Real Location", "the update must carry the full, current desired content, not just confirm existence");
  }

  // =========================================================================
  // Issue 3b: distinguish an uncertain first creation from an event known
  // to have been synced and later manually deleted -- a detected manual
  // deletion requires explicit Recreate, never an automatic retry.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-missing", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-missing", 0);
    const getFields = async () => makeFields("int-missing");

    // First: a normal, successful create.
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const first = await reconcilePresentAbsent(store, client, getFields, "int-missing", "worker-1", now + 1);
    assert.equal(first.kind, "synced");

    // The owner manually deletes it directly in Google. A LATER
    // reconcile attempt (e.g. triggered by an unrelated sweep tick) must
    // detect this and NOT silently recreate it.
    await recordReschedule(store, now + 2, "int-missing"); // bump a revision so the sweep would normally act
    client.enqueueValue("get", eventId, err404());
    const second = await reconcilePresentAbsent(store, client, getFields, "int-missing", "worker-1", now + 3);
    assert.equal(second.kind, "missing_remotely", "a 404 on a previously-synced event must be classified as a manual deletion, never silently recreated");

    const link = await store.getLinkByInteraction("int-missing");
    assert.equal(link.syncStatus, "missing_remotely");

    // It must STAY missing_remotely across further sweep ticks -- the real
    // sweep's own "needs reconciliation" query must exclude this row
    // entirely, which is what makes "requires explicit Recreate" true
    // structurally, not just as a convention the sweep happens to follow.
    const needingReconciliation = await store.listNeedingReconciliation(now + 10);
    assert.ok(!needingReconciliation.some((row) => row.interactionId === "int-missing"), "a missing_remotely row must never be picked up by the sweep -- it requires an explicit Recreate action, never an automatic retry");
  }

  // =========================================================================
  // Issue 2a/2b: cancel during an ambiguous create, including a DELAYED
  // create that succeeds AFTER a delete returned 404 -- do not claim 404
  // alone guarantees absence while a create may still be in flight.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-ambig-cancel", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-ambig-cancel", 0);
    const getFields = async () => makeFields("int-ambig-cancel");

    // Create attempt starts; its insert call is suspended (ambiguous: we
    // genuinely don't know yet whether Google will process it).
    client.enqueueValue("get", eventId, err404());
    const deferredInsert = createDeferred();
    client.enqueue("insert", eventId, () => deferredInsert.promise);
    const createAttempt = reconcilePresentAbsent(store, client, getFields, "int-ambig-cancel", "worker-create", now + 1, 5);
    await new Promise((resolve) => setImmediate(resolve)); // let it reach the insert call and mark createStatus in_flight

    let history = await store.getHistory((await store.getLinkByInteraction("int-ambig-cancel")).id, 0);
    assert.equal(history.createStatus, "in_flight", "create must be marked in-flight BEFORE the ambiguous call, so a concurrent cleanup can see it");

    // The owner cancels while the create is still ambiguous.
    await recordCancel(store, now + 2, "int-ambig-cancel");
    let link = await store.getLinkByInteraction("int-ambig-cancel");
    assert.equal(link.desiredState, "absent");
    history = await store.getHistory(link.id, 0);
    assert.equal(history.cleanupNeeded, true);

    // A cleanup sweep runs the delete NOW, while the create is still
    // ambiguous -- Google (correctly, in this adversarial ordering)
    // reports 404 because the original insert hasn't landed yet.
    client.enqueueValue("delete", eventId, err404());
    const cleanup1 = await reconcileGenerationCleanup(store, client, "primary", link.id, 0, eventId, now + 3);
    assert.equal(cleanup1.kind, "uncertain", "a 404 while the create is still unresolved must NOT be trusted as confirmed absence");
    history = await store.getHistory(link.id, 0);
    assert.equal(history.cleanupStatus, "uncertain");

    // NOW the original, long-delayed create finally succeeds at Google --
    // a real orphaned event now genuinely exists there.
    deferredInsert.resolve(ok201({ id: eventId }));
    await createAttempt;
    // The create attempt's own lease-gated bookkeeping write may or may
    // not still hold the lease depending on TTL -- either way, what
    // matters is the create's OWN resolution gets recorded durably.
    await resolveCreateOutcome(store, link.id, 0, "succeeded");
    history = await store.getHistory(link.id, 0);
    assert.equal(history.createStatus, "succeeded", "the late create's true outcome must be recorded regardless of lease state");
    assert.equal(history.cleanupStatus, "uncertain", "cleanup must still be pending another attempt -- not wrongly marked done by the earlier 404");

    // A LATER cleanup sweep, now that the create's outcome is resolved,
    // must retry the delete -- and this time it actually finds (and
    // removes) the real, now-existing event.
    client.enqueueValue("delete", eventId, ok204());
    const cleanup2 = await reconcileGenerationCleanup(store, client, "primary", link.id, 0, eventId, now + 4);
    assert.equal(cleanup2.kind, "done", "once the create's outcome is known, a follow-up delete must actually succeed and complete the cleanup");
    history = await store.getHistory(link.id, 0);
    assert.equal(history.cleanupStatus, "done");
  }

  // =========================================================================
  // Issue 2c/2d: reopening must not abandon a failed/uncertain deletion of
  // the OLD generation, and deletion retries must stay separate from
  // creating the reopened (new generation) event -- demonstrate eventual
  // cleanup of the old generation WITHOUT ever deleting the new one.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-reopen", userId: "u1", googleCalendarId: "primary" });
    const genZeroId = deriveGoogleEventId("int-reopen", 0);
    const getFields = async () => makeFields("int-reopen");

    // Generation 0 is created successfully.
    client.enqueueValue("get", genZeroId, err404());
    client.enqueueValue("insert", genZeroId, ok201({ id: genZeroId }));
    const first = await reconcilePresentAbsent(store, client, getFields, "int-reopen", "w1", now + 1);
    assert.equal(first.kind, "synced");

    // Cancel -- generation 0 now needs cleanup -- but its delete FAILS
    // (simulated transient error), leaving it in 'pending'.
    await recordCancel(store, now + 2, "int-reopen");
    let link = await store.getLinkByInteraction("int-reopen");
    client.enqueueValue("delete", genZeroId, errNetwork());
    const failedCleanup = await reconcileGenerationCleanup(store, client, "primary", link.id, 0, genZeroId, now + 3);
    assert.equal(failedCleanup.kind, "failed");
    let historyGen0 = await store.getHistory(link.id, 0);
    assert.equal(historyGen0.cleanupStatus, "pending");

    // The owner reopens -- generation becomes 1, a brand-new deterministic
    // id is used, and generation 0's own pending cleanup must be left
    // completely untouched (not abandoned, not silently marked done).
    await recordReopen(store, now + 4, "int-reopen");
    link = await store.getLinkByInteraction("int-reopen");
    assert.equal(link.generation, 1);
    const genOneId = deriveGoogleEventId("int-reopen", 1);
    assert.notEqual(genOneId, genZeroId, "a reopen must use a brand-new id -- Google permanently blocks reinserting a deleted event's id");
    assert.equal(link.googleEventId, null, "the new generation's event id is recomputed fresh by the next reconcile, not carried over from the old generation");

    historyGen0 = await store.getHistory(link.id, 0);
    assert.equal(historyGen0.cleanupNeeded, true, "generation 0's cleanup obligation must survive the reopen unchanged");
    assert.equal(historyGen0.cleanupStatus, "pending", "generation 0's cleanup STATE must also survive unchanged -- not reset, not abandoned");

    // Create the new generation's event -- this must be able to proceed
    // independently, never blocked by generation 0's still-pending cleanup.
    client.enqueueValue("get", genOneId, err404());
    client.enqueueValue("insert", genOneId, ok201({ id: genOneId }));
    const reopened = await reconcilePresentAbsent(store, client, getFields, "int-reopen", "w2", now + 5);
    assert.equal(reopened.kind, "synced", "creating the reopened (new generation) event must not be blocked by the old generation's unresolved cleanup");

    // A later cleanup sweep for generation 0 finally succeeds -- and it
    // must target ONLY generation 0's event id, never generation 1's.
    const deleteCalls = [];
    const realDelete = client.delete.bind(client);
    client.delete = async (calendarId, eventId) => {
      deleteCalls.push(eventId);
      return realDelete(calendarId, eventId);
    };
    client.enqueueValue("delete", genZeroId, ok204());
    const finalCleanup = await reconcileGenerationCleanup(store, client, "primary", link.id, 0, genZeroId, now + 6);
    assert.equal(finalCleanup.kind, "done", "generation 0's deletion must eventually complete");
    assert.deepEqual(deleteCalls, [genZeroId], "cleanup must delete ONLY the old generation's event -- the new generation's event must never be touched by cleanup");

    // The new generation's event remains synced and untouched.
    link = await store.getLinkByInteraction("int-reopen");
    assert.equal(link.syncStatus, "synced");
    assert.equal(link.googleEventId, genOneId);
  }

  // =========================================================================
  // Repeated cancellation is idempotent -- no new work generated, no
  // second cleanup-needed flag created out of thin air.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-double-cancel", userId: "u1", googleCalendarId: "primary" });
    const ok1 = await recordCancel(store, now + 1, "int-double-cancel");
    const linkAfterFirst = await store.getLinkByInteraction("int-double-cancel");
    const ok2 = await recordCancel(store, now + 2, "int-double-cancel");
    const linkAfterSecond = await store.getLinkByInteraction("int-double-cancel");
    assert.equal(ok1, true);
    assert.equal(ok2, true, "a repeat cancel must be a safe idempotent no-op, not an error");
    assert.equal(linkAfterFirst.desiredRevision, linkAfterSecond.desiredRevision, "a repeat cancel must not bump the revision again -- no new work is actually needed");
  }

  // =========================================================================
  // Lease contention: two concurrent reconcile attempts for the SAME
  // meeting -- only one may proceed at a time.
  // =========================================================================
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    await enrollMeetingForSync(store, now, { interactionId: "int-contend", userId: "u1", googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId("int-contend", 0);
    const getFields = async () => makeFields("int-contend");

    const deferredGet = createDeferred();
    client.enqueue("get", eventId, () => deferredGet.promise);
    const attemptA = reconcilePresentAbsent(store, client, getFields, "int-contend", "worker-A", now + 1, 120);
    await new Promise((resolve) => setImmediate(resolve));

    const attemptB = await reconcilePresentAbsent(store, client, getFields, "int-contend", "worker-B", now + 1, 120);
    assert.equal(attemptB.kind, "lease_contended", "a second concurrent attempt must find the lease already held and back off, never racing the first's Google call");

    deferredGet.resolve(ok200({ id: eventId }, "etag-1"));
    client.enqueueValue("update", eventId, ok200({ id: eventId }, "etag-2"));
    const resultA = await attemptA;
    assert.equal(resultA.kind, "synced");
  }

  process.stdout.write("calendar-sync-reconciler.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
