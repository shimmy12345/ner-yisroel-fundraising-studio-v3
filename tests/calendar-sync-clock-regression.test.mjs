import assert from "node:assert/strict";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { ScriptedCalendarClient, ok201, err404, createDeferred } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { enrollMeetingForSync, reconcilePresentAbsent } from "../lib/calendar/calendar-sync-reconciler.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Independent reproduction against commit bf8a8ed: reconcilePresentAbsent
// received ONE fixed `now` and reused that SAME frozen value for every
// expiry check and protected write for the entire call, including after
// awaited network operations -- so a lease's own expiry, derived from
// that same frozen `now`, could never be observed as past by this SAME
// attempt's own later checks, no matter how long it was actually
// suspended. Exact reproduction: start at now=1000 with a 5s lease
// (expires 1005); suspend GET; advance the clock to 1010; GET returns
// 404; pre-fix, INSERT still executed and the link was marked synced
// despite the lease having genuinely expired at 1005.
//
// Fixed with an injectable Clock (calendar-sync-reconciler.ts's own
// `Clock` type) -- every test below passes an explicit, test-controlled
// clock that the test itself advances mid-call, via a mutable variable
// closed over by the clock function, never a plain number.

function makeFields(interactionId) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief" };
}

function makeAdvanceableClock(initial) {
  let current = initial;
  const clock = () => current;
  clock.advanceTo = (value) => {
    current = value;
  };
  return clock;
}

async function run() {
  // =========================================================================
  // THE EXACT REPRODUCTION: a 5s lease, the clock genuinely advances past
  // expiry WHILE the GET is suspended, with NO takeover by anyone else.
  // Pre-fix: INSERT still executed, link marked synced. Fixed: the
  // revalidation immediately after GET must now see the lease as
  // expired (clock() reads 1010, past the 1005 expiry) and reject the
  // attempt before INSERT is ever called.
  // =========================================================================
  {
    const interactionId = "int-clock-exact-repro";
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);
    const clock = makeAdvanceableClock(1000);

    await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });

    // `getCallStarted` is a pure SIGNAL, resolved the instant the
    // reconciler genuinely calls client.get() -- i.e., only once
    // acquireLease (and the lease's own expiry, derived from clock() AT
    // THAT MOMENT) has already completed. Without this signal, the
    // test's own `clock.advanceTo()` call -- which runs SYNCHRONOUSLY
    // immediately after merely CALLING reconcilePresentAbsent, since an
    // async function only runs up to its own first await before
    // returning control to its caller -- could race ahead of
    // acquireLease itself, advancing the clock before the lease was
    // even acquired with the ORIGINAL time. Awaiting this signal
    // guarantees the lease was genuinely acquired at clock()=1000
    // before the clock is advanced to 1010.
    const getCallStarted = createDeferred();
    const deferredGet = createDeferred();
    client.enqueue("get", eventId, () => {
      getCallStarted.resolve();
      return deferredGet.promise;
    });

    const pending = reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1000, 5, clock);
    await getCallStarted.promise;

    // Advance the clock PAST the lease's own expiry (1000 + 5 = 1005)
    // while the GET is still outstanding, then let it resolve 404.
    clock.advanceTo(1010);
    deferredGet.resolve(err404());

    const result = await pending;
    assert.equal(result.kind, "lease_contended", "FIXED: the attempt's own lease must be recognized as expired (clock() now reads past 1005) immediately after the delayed GET resolves -- never allowed to proceed to INSERT");
    assert.ok(!client.calls.some((c) => c.op === "insert"), "INSERT must never be called once the lease has genuinely expired, even with no takeover");
    const link = await store.getLinkByInteraction(interactionId);
    assert.notEqual(link.syncStatus, "synced", "the link must never be marked synced off an attempt whose own lease had already expired");
    assert.equal(link.syncStatus, "pending", "no bookkeeping write must have landed at all -- the link remains exactly as enrollMeetingForSync left it");
  }

  // =========================================================================
  // Expiry WITHOUT takeover, delayed GET: same as above, but confirm the
  // link remains cleanly retryable afterward (nobody is stuck holding a
  // lease forever) -- a SECOND attempt, with a fresh clock, must succeed
  // normally once the first attempt's lease has naturally expired.
  // =========================================================================
  {
    const interactionId = "int-clock-no-takeover-retry";
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);
    const clock = makeAdvanceableClock(1000);

    await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
    const getCallStarted = createDeferred();
    const deferredGet = createDeferred();
    client.enqueue("get", eventId, () => {
      getCallStarted.resolve();
      return deferredGet.promise;
    });
    const firstAttempt = reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1000, 5, clock);
    await getCallStarted.promise;
    clock.advanceTo(1010);
    deferredGet.resolve(err404());
    const firstResult = await firstAttempt;
    assert.equal(firstResult.kind, "lease_contended");

    // A second attempt, with its own fresh clock, must proceed normally
    // -- the first attempt's expired (and never-released, since it
    // bailed before reaching its own `finally`-released lease... no,
    // `finally` always runs) lease must not block it.
    const clock2 = makeAdvanceableClock(1011);
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const secondResult = await reconcilePresentAbsent(store, client, getFields, interactionId, "w2", 1011, 120, clock2);
    assert.equal(secondResult.kind, "synced", "a later attempt, after the first attempt's own (genuinely expired) lease was released by its own finally block, must complete normally");
  }

  // =========================================================================
  // Expiry WITH takeover: a second worker, with its own real clock,
  // acquires the lease once it has genuinely expired (via the reconciler's
  // own acquireLease call, not a direct store call) WHILE the first
  // attempt is still suspended; the first attempt's eventual (delayed)
  // INSERT must still be rejected at the bookkeeping stage, by the
  // takeover, not merely by its own self-detected expiry.
  // =========================================================================
  {
    const interactionId = "int-clock-takeover";
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);
    const clock1 = makeAdvanceableClock(1000);

    await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });

    // Attempt 1 gets all the way to its own INSERT call and suspends
    // there (a genuinely delayed Google response), using a signal
    // deferred so the test knows exactly when attempt 1 has reached it
    // (see tests/calendar-adapters-regression-2026-10-19.test.mjs for
    // why this exact signal pattern is needed to avoid a deadlock).
    client.enqueueValue("get", eventId, err404());
    const insertCallStarted = createDeferred();
    const deferredInsert = createDeferred();
    client.enqueue("insert", eventId, () => {
      insertCallStarted.resolve();
      return deferredInsert.promise;
    });
    const pending = reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1000, 5, clock1);
    await insertCallStarted.promise;

    // Attempt 1's lease (expires 1005) is now genuinely expired in real
    // terms -- worker 2 arrives with its OWN fresh clock and takes over
    // via the reconciler's own public entry point.
    const clock2 = makeAdvanceableClock(1020);
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const w2Result = await reconcilePresentAbsent(store, client, getFields, interactionId, "w2", 1020, 120, clock2);
    assert.equal(w2Result.kind, "synced", "worker 2 must be able to take over the genuinely expired lease and complete its own sync");

    // NOW attempt 1's long-delayed INSERT finally resolves.
    deferredInsert.resolve(ok201({ id: eventId }));
    const w1Result = await pending;
    assert.equal(w1Result.kind, "lease_contended", "attempt 1's own bookkeeping write must be rejected once a real takeover has happened, regardless of which specific check (self-detected expiry or ownership mismatch) catches it");

    // "Retain remote-outcome knowledge for requests already sent": even
    // though attempt 1's link-level write was rejected, its own
    // createStatus history write (unconditional, never lease-gated)
    // must still durably record that Google really did create the event.
    const link = await store.getLinkByInteraction(interactionId);
    const history = await store.getHistory(link.id, 0);
    assert.equal(history.createStatus, "succeeded", "a stale worker's late-resolving, real remote outcome must still be durably recorded, even though its lease-gated bookkeeping write was correctly rejected");
  }

  // =========================================================================
  // "Verify unique lease tokens per acquisition": two logically-separate
  // reconcile attempts must never be able to collide on the SAME
  // leaseOwner string by accident -- confirms the store's own ownership
  // check is a real string-identity check (not, say, a prefix or
  // category match), so two genuinely distinct callers using distinct
  // generated tokens can never be mistaken for the same lease holder.
  // =========================================================================
  {
    const interactionId = "int-unique-lease-tokens";
    const store = new InMemoryCalendarStore();
    const link = await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
    const tokenA = `reconcile:${interactionId}:${crypto.randomUUID()}`;
    const tokenB = `reconcile:${interactionId}:${crypto.randomUUID()}`;
    assert.notEqual(tokenA, tokenB, "two independently generated lease tokens for the SAME interaction must never collide");

    const acquiredA = await store.acquireLease(link.id, tokenA, 1000, 60);
    assert.equal(acquiredA, true);
    const acquiredBWhileHeld = await store.acquireLease(link.id, tokenB, 1001, 60);
    assert.equal(acquiredBWhileHeld, false, "a second, genuinely distinct token must not be able to acquire a lease the first token still validly holds");
    const releasedByWrongToken = await store.releaseLease(link.id, tokenB);
    assert.equal(releasedByWrongToken, false, "a distinct token must never be able to release a lease it does not hold, confirming tokens are compared by real identity, not merely 'some token is set'");
  }

  process.stdout.write("calendar-sync-clock-regression.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
