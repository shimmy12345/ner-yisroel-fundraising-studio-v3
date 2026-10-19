import assert from "node:assert/strict";
import { createLocalD1Database } from "../lib/calendar/testing/local-d1.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";
import { StatefulCalendarClient } from "../lib/calendar/testing/stateful-calendar-client.ts";
import { ScriptedCalendarClient, createDeferred, err404, ok201 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";
import { D1CalendarStore } from "../lib/calendar/d1-calendar-store.ts";
import {
  attemptImmediateTripCalendarSync, buildTripMeetingCancelledStatements, buildTripMeetingScheduledStatements,
  getTripMeetingCalendarLink, googleCalendarEventViewUrl, isCalendarSyncEnabledForUser,
  loadCalendarConnectionStatus, loadTripMeetingFields, reconcileTripMeetingCalendarLink, recordTripMeetingCancelled,
  recordTripMeetingScheduled, setCalendarSyncEnabledForUser,
} from "../lib/relationships/trip-calendar-sync.ts";

// Trip Planning Google Calendar sync -- the narrowed first release
// (2026-10-19, see docs/AI-HANDOFF.md). Exercises the ONE layer this
// round actually adds (lib/relationships/trip-calendar-sync.ts) against
// a REAL local D1 binding (same lib/calendar/testing/local-d1.ts harness
// tests/calendar-adapters-integration.test.mjs already uses -- CI-only,
// same reason: this project's Windows sandbox cannot run the bundled
// workerd.exe binary; see that harness's own header) and a STATEFUL
// simulated Google calendar (StatefulCalendarClient -- real create/409/
// 412/404 semantics across a full schedule/reschedule/cancel cycle,
// never a hand-scripted one-shot response sequence), proving the
// COMPLETE path end to end rather than re-proving the already-covered
// core (lib/calendar/'s own 11 test files). Run via `pnpm run
// test:calendar-d1`, not `pnpm test`.
//
// A fresh MockHttpTransport, scripted with exactly one token+userinfo
// pair, backs ONLY the live identity check every attempt makes
// (resolveVerifiedGoogleAccountEmail) -- the actual calendar operations
// go through the injected StatefulCalendarClient instead (see
// trip-calendar-sync.ts's own ImmediateSyncArgs.client doc comment for
// why this test-only seam exists). An empty, never-enqueued transport
// that NO call reaches is itself the proof that "disabled/no credentials"
// skips the network entirely, not merely that the function returned null.

const NOW = 3_000_000;
const CREDENTIALS = { clientId: "c", clientSecret: "s", refreshToken: "r" };
const OWNER_EMAIL = "sgoldstein@nirc.edu";

function identityTransport(email = OWNER_EMAIL) {
  const transport = new MockHttpTransport();
  transport.enqueue(tokenResponse());
  transport.enqueue(jsonResponse(200, { email }));
  return transport;
}

let nextId = 0;
function uniqueId(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

// Lease protection regressions (2026-10-19 review, follow-up): a test-
// controlled clock that genuinely advances, the same pattern
// tests/calendar-sync-clock-regression.test.mjs already uses for the
// core reconciler -- here driven through the actual production Trip
// call path (attemptImmediateTripCalendarSync/reconcileTripMeetingCalendarLink)
// instead of calling the core reconciler directly, since the bug this
// proves was fixed is specifically that this production call path never
// supplied an advancing clock at all before this round.
function makeAdvanceableClock(initial) {
  let current = initial;
  const clock = () => current;
  clock.advanceTo = (value) => {
    current = value;
  };
  return clock;
}

// Wraps a real GoogleCalendarClient so its NEXT get() call blocks until
// the test explicitly releases it -- used to prove a concurrent intent
// change (a cancel landing mid-flight) is correctly detected by
// revalidateBeforeMutation before any stale mutating call is sent,
// without needing ScriptedCalendarClient's own separate queue mechanics.
function delayNextGet(inner) {
  const started = createDeferred();
  const gate = createDeferred();
  let armed = true;
  return {
    client: {
      async get(calendarId, eventId) {
        if (armed) {
          armed = false;
          started.resolve();
          await gate.promise;
        }
        return inner.get(calendarId, eventId);
      },
      insert: (...args) => inner.insert(...args),
      update: (...args) => inner.update(...args),
      delete: (...args) => inner.delete(...args),
    },
    started: started.promise,
    release: () => gate.resolve(),
  };
}

async function seedTripMeeting(db, { userId, donorId, interactionId, occurredAt, endAt, location, donorState = "IL", userTimezone = "America/Chicago" }) {
  await db.prepare("INSERT OR IGNORE INTO users (id, email, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(userId, `${userId}@example.test`, userTimezone, NOW, NOW).run();
  await db.prepare("INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, display_name, state, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?, ?)").bind(donorId, userId, donorState, NOW, NOW).run();
  await db.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, end_at, location, summary, source, created_at, updated_at)
      VALUES (?, ?, ?, 'meeting', ?, ?, ?, 'Trip meeting scheduled with Test Donor.', 'capture-scheduled:trip:t1:meeting', ?, ?)`)
    .bind(interactionId, donorId, userId, occurredAt, endAt, location, NOW, NOW).run();
}

async function run() {
  const { db, dispose } = await createLocalD1Database();
  try {
    // =======================================================================
    // Full vertical slice: schedule -> synced -> reschedule -> still
    // synced (same event id, updated content) -> cancel -> deleted.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: "Donor's office" });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      assert.equal(await isCalendarSyncEnabledForUser(db, userId), true);

      const fields = await loadTripMeetingFields(db, interactionId, "https://example.test");
      assert.equal(fields.donorDisplayName, "Test Donor");
      assert.equal(fields.timezone, "America/Chicago", "IL maps to America/Chicago via timezoneForState -- never the fallback unless the donor has no state");
      assert.equal(fields.location, "Donor's office");
      assert.equal(fields.endAt, NOW + 86400 + 1800);

      const client = new StatefulCalendarClient();

      // Schedule: no link exists yet -> enrollMeetingForSync's path.
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);
      const afterSchedule = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport(), client,
      });
      assert.equal(afterSchedule.reconciled.length, 1);
      assert.equal(afterSchedule.reconciled[0].kind, "synced");
      assert.equal(client.activeEventIds("primary").length, 1, "exactly one real event must exist on the simulated calendar after scheduling");
      let link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.syncStatus, "synced");
      const eventId = link.googleEventId;

      // Reschedule: link already exists and is 'present' -> recordReschedule's path.
      // Simulate the reschedule the same way scheduleProspectMeeting's own
      // UPDATE would (a later meeting time, same deterministic
      // interactionId -- see trip-model.ts's tripMeetingInteractionId()).
      await db.prepare("UPDATE interactions SET occurred_at = ?, end_at = ? WHERE id = ?").bind(NOW + 172800, NOW + 172800 + 1800, interactionId).run();
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW + 2);
      const afterReschedule = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 3,
        transport: identityTransport(), client,
      });
      assert.equal(afterReschedule.reconciled[0].kind, "synced");
      assert.deepEqual(client.activeEventIds("primary"), [eventId], "a reschedule must update the SAME event id, never create a second one");
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.googleEventId, eventId);

      // Cancel: "removes only its linked FOS-created event."
      await recordTripMeetingCancelled(db, interactionId, NOW + 4);
      const afterCancel = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 5,
        transport: identityTransport(), client,
      });
      assert.equal(afterCancel.reconciled[0].kind, "deleted");
      assert.deepEqual(client.activeEventIds("primary"), [], "cancellation must remove the real event from the simulated calendar");

      // "View on Google Calendar" link shape -- a base64 blob, never the
      // raw event/calendar id text leaked into the URL unencoded.
      const viewUrl = googleCalendarEventViewUrl(eventId, "primary");
      assert.ok(viewUrl.startsWith("https://calendar.google.com/calendar/event?eid="));
      assert.ok(!viewUrl.includes(eventId), "the raw event id must not appear unencoded in the view URL");
    }

    // =======================================================================
    // "Preserve existing scheduling when Calendar is disabled or
    // unavailable": disabled, and no credentials -- zero network calls of
    // ANY kind (an empty, never-enqueued transport is the proof -- any
    // attempted call would throw "no scripted response enqueued").
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);

      const disabledResult = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: false, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: new MockHttpTransport(), client: new StatefulCalendarClient(),
      });
      assert.equal(disabledResult, null, "disabled sync must make no attempt at all");

      const noCredentialsResult = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: null,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: new MockHttpTransport(), client: new StatefulCalendarClient(),
      });
      assert.equal(noCredentialsResult, null, "no configured credentials must make no attempt at all");

      // The link remains exactly as recordTripMeetingScheduled left it --
      // the meeting itself (seeded above) is completely unaffected either way.
      const link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.syncStatus, "pending");
    }

    // =======================================================================
    // Guard refusal with credentials present and sync enabled: the live
    // identity check DOES run, but the guard still refuses (Staging with
    // no configured test calendar id) -- the identity check happening is
    // not itself a safety gap, since zero calendar mutations ever reach
    // the simulated calendar.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      await recordTripMeetingScheduled(db, interactionId, userId, "", NOW);

      const client = new StatefulCalendarClient();
      const result = await attemptImmediateTripCalendarSync({
        db, userId, environment: "staging-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport("someone-else@example.test"), client,
      });
      assert.equal(result, null, "no explicit Staging test calendar id configured must refuse the whole attempt");
      assert.equal(client.calls.length, 0, "a refused guard must never reach the calendar client at all");
    }

    // =======================================================================
    // Settings' live connection status (loadCalendarConnectionStatus) --
    // no credentials configured (true on every environment this round)
    // reports it immediately, with zero network calls.
    // =======================================================================
    {
      const userId = uniqueId("u");
      await db.prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW).run();
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      const status = await loadCalendarConnectionStatus({
        db, userId, environment: "production-independent", credentials: null, calendarId: "primary", stagingTestCalendarId: null,
        transport: new MockHttpTransport(),
      });
      assert.deepEqual(status, { enabled: true, credentialsConfigured: false, verifiedEmail: null, calendarId: "primary", allowed: false, reason: "no Google Calendar OAuth credentials are configured" });

      const connectedStatus = await loadCalendarConnectionStatus({
        db, userId, environment: "production-independent", credentials: CREDENTIALS, calendarId: "primary", stagingTestCalendarId: null,
        transport: identityTransport(),
      });
      assert.equal(connectedStatus.allowed, true);
      assert.equal(connectedStatus.verifiedEmail, OWNER_EMAIL);
    }

    // =======================================================================
    // Lease protection, through the ACTUAL Trip reconciliation path
    // (2026-10-19 review, follow-up): before this round,
    // attemptImmediateTripCalendarSync passed no `clock` at all, so a
    // lease's own genuine real-world expiry while suspended on a network
    // call could never be detected. Exact reproduction of the same class
    // of bug commit 1fffef2 fixed inside the core reconciler, but now
    // proven at the production call site that was still missing the fix.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);
      const eventId = deriveGoogleEventId(interactionId, 0);

      const client = new ScriptedCalendarClient();
      const getCallStarted = createDeferred();
      const deferredGet = createDeferred();
      client.enqueue("get", eventId, () => {
        getCallStarted.resolve();
        return deferredGet.promise;
      });
      const clock = makeAdvanceableClock(NOW);
      const pending = attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW,
        transport: identityTransport(), client, clock,
      });
      await getCallStarted.promise;
      // Past the sweep's own 120s lease TTL -- the real advancing clock,
      // now threaded all the way through this production call path, must
      // let this attempt detect its own lease as expired.
      clock.advanceTo(NOW + 130);
      deferredGet.resolve(err404());
      const result = await pending;
      assert.equal(result.reconciled.length, 1);
      assert.equal(result.reconciled[0].kind, "lease_contended", "the advancing clock, now reaching this production call path, must reject the attempt once its own lease has genuinely expired");
      assert.ok(!client.calls.some((c) => c.op === "insert"), "INSERT must never be sent once the lease has expired, even with no takeover");
      let link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.syncStatus, "pending", "no bookkeeping write must have landed from the expired attempt");

      // Expiry WITHOUT takeover: a later, independent Retry (the safe,
      // intent-free reconcile path) with a fresh clock must still
      // complete normally -- the first attempt's own expired lease,
      // released by its own `finally`, must never block it.
      const laterClock = makeAdvanceableClock(NOW + 140);
      const okClient = new StatefulCalendarClient();
      const retryOutcome = await reconcileTripMeetingCalendarLink({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 140,
        transport: identityTransport(), client: okClient, clock: laterClock, interactionId,
      });
      assert.equal(retryOutcome.kind, "synced", "once the first attempt's lease has naturally expired, a later retry must proceed and succeed normally");
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.syncStatus, "synced");
    }

    // =======================================================================
    // Lease protection: expiry WITH takeover, and unique lease tokens per
    // acquisition. Two separate production sweep invocations for the
    // SAME meeting -- attempt 1 stalls on its own INSERT past its lease's
    // real expiry; attempt 2, via a second independent call into the
    // SAME attemptImmediateTripCalendarSync entry point, takes over and
    // completes. Attempt 1's long-delayed INSERT finally resolving must
    // still be rejected. This can only pass if the production path
    // generates a genuinely UNIQUE lease token per acquisition -- the OLD
    // deterministic `trip:${userId}:${link.id}` string, shared by every
    // call for this same meeting, would let attempt 1's late write wrongly
    // match attempt 2's current lease and corrupt its result.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);
      const eventId = deriveGoogleEventId(interactionId, 0);

      const client = new ScriptedCalendarClient();
      client.enqueueValue("get", eventId, err404());
      const insertCallStarted = createDeferred();
      const deferredInsert = createDeferred();
      client.enqueue("insert", eventId, () => {
        insertCallStarted.resolve();
        return deferredInsert.promise;
      });

      const clock1 = makeAdvanceableClock(NOW);
      const pending = attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW,
        transport: identityTransport(), client, clock: clock1,
      });
      await insertCallStarted.promise;

      // Attempt 1's lease (120s TTL) is now genuinely expired in real
      // terms. Attempt 2 arrives via a second, independent call into the
      // SAME production entry point, with its own fresh clock.
      const clock2 = makeAdvanceableClock(NOW + 130);
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, ok201({ id: eventId }));
      const w2 = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 130,
        transport: identityTransport(), client, clock: clock2,
      });
      assert.equal(w2.reconciled[0].kind, "synced", "a second, independent sweep invocation must be able to take over the genuinely expired lease and complete its own sync");

      // Attempt 1's long-delayed INSERT finally resolves.
      deferredInsert.resolve(ok201({ id: eventId }));
      const w1 = await pending;
      assert.equal(w1.reconciled[0].kind, "lease_contended", "attempt 1's own stale bookkeeping write must be rejected once a real takeover has happened -- this requires attempt 1 and attempt 2 to have used genuinely DISTINCT lease tokens, never the same deterministic string");

      const link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.syncStatus, "synced", "worker 2's own successful write must be the one that stands");
    }

    // =======================================================================
    // Owner isolation: the immediate reconciliation sweep triggered by one
    // authenticated owner's own action must never see, lease, or mutate
    // another owner's pending link.
    // =======================================================================
    {
      const userA = uniqueId("u");
      const donorA = uniqueId("d");
      const interactionA = uniqueId("int");
      const userB = uniqueId("u");
      const donorB = uniqueId("d");
      const interactionB = uniqueId("int");
      await seedTripMeeting(db, { userId: userA, donorId: donorA, interactionId: interactionA, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await seedTripMeeting(db, { userId: userB, donorId: donorB, interactionId: interactionB, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userA, true, NOW);
      await setCalendarSyncEnabledForUser(db, userB, true, NOW);
      await recordTripMeetingScheduled(db, interactionA, userA, "primary", NOW);
      await recordTripMeetingScheduled(db, interactionB, userB, "primary", NOW);
      const beforeB = await getTripMeetingCalendarLink(db, interactionB);
      const eventIdB = deriveGoogleEventId(interactionB, 0);

      const client = new StatefulCalendarClient();
      const result = await attemptImmediateTripCalendarSync({
        db, userId: userA, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport(), client,
      });
      assert.equal(result.reconciled.length, 1, "owner A's own scoped sweep must process exactly one link -- its own, never owner B's");
      assert.equal(result.reconciled[0].kind, "synced");

      const afterA = await getTripMeetingCalendarLink(db, interactionA);
      assert.equal(afterA.syncStatus, "synced");

      const afterB = await getTripMeetingCalendarLink(db, interactionB);
      assert.deepEqual(afterB, beforeB, "owner A's own scoped sweep must leave owner B's pending link completely untouched -- byte-for-byte identical, not merely unchanged by coincidence");
      assert.ok(!client.calls.some((c) => c.eventId === eventIdB), "the simulated calendar must never have been reached for owner B's own event as a side effect of owner A's action");
    }

    // =======================================================================
    // Safe Retry: reconciles the CURRENT desired state only -- never
    // scheduling logic that could reopen a canceled meeting. Retry on a
    // canceled meeting preserves the cancellation and finishes cleanup.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      const client = new StatefulCalendarClient();
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);
      await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport(), client,
      });
      assert.equal(client.activeEventIds("primary").length, 1);

      await recordTripMeetingCancelled(db, interactionId, NOW + 2);

      // Retry on the now-canceled meeting: must delete the real event
      // and finish cleanup -- never reopen it (recordTripMeetingScheduled/
      // enrollMeetingForSync/recordReopen are never called by this path).
      const retryOutcome = await reconcileTripMeetingCalendarLink({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 3,
        transport: identityTransport(), client, interactionId,
      });
      assert.equal(retryOutcome.kind, "deleted");
      assert.deepEqual(client.activeEventIds("primary"), [], "retry must finish the deletion the cancellation requires");
      let link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredState, "absent", "retry must never reopen a canceled meeting");

      // Retrying again on an already-fully-cleaned-up cancellation stays
      // a safe, idempotent no-op.
      const retryAgain = await reconcileTripMeetingCalendarLink({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 4,
        transport: identityTransport(), client, interactionId,
      });
      assert.equal(retryAgain.kind, "deleted");
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredState, "absent", "a second retry must still never reopen it");
    }

    // =======================================================================
    // Safe Retry: a DELAYED retry racing a concurrent cancellation. The
    // retry's own in-flight GET must be revalidated against the live
    // desired state before any mutating call -- a cancellation landing
    // mid-flight must be preserved, never overwritten by a stale "present"
    // push.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: null });
      await setCalendarSyncEnabledForUser(db, userId, true, NOW);
      const real = new StatefulCalendarClient();
      await recordTripMeetingScheduled(db, interactionId, userId, "primary", NOW);
      await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport(), client: real,
      });
      const syncedLink = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(syncedLink.syncStatus, "synced");

      const { client: delayed, started, release } = delayNextGet(real);
      const retryPromise = reconcileTripMeetingCalendarLink({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 2,
        transport: identityTransport(), client: delayed, interactionId,
      });
      await started;
      // Concurrently, the owner cancels the meeting while the delayed
      // retry's own GET is still in flight.
      await recordTripMeetingCancelled(db, interactionId, NOW + 3);
      release();
      const retryOutcome = await retryPromise;
      assert.equal(retryOutcome.kind, "superseded", "a delayed retry must be rejected once desired_state changed out from under it mid-flight, never allowed to push a stale update over a cancellation");

      const link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredState, "absent");
      assert.deepEqual(real.activeEventIds("primary"), [link.googleEventId], "the retry's own mutating call must never have been sent -- the event must still exist exactly as it did before the race");

      // A later, ordinary retry (no race this time) finishes the job.
      const finish = await reconcileTripMeetingCalendarLink({
        db, userId, environment: "production-independent", calendarSyncEnabled: true, credentials: CREDENTIALS,
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 4,
        transport: identityTransport(), client: real, interactionId,
      });
      assert.equal(finish.kind, "deleted");
      assert.deepEqual(real.activeEventIds("primary"), []);
    }

    // =======================================================================
    // Atomic persistence: the durable calendar-sync intent statements
    // (buildTripMeetingScheduledStatements/buildTripMeetingCancelledStatements)
    // merge into the SAME db.batch() call as a stand-in "meeting change"
    // statement, proving the meeting change and the calendar intent
    // commit together as one indivisible D1 operation -- covering
    // scheduling, rescheduling, cancellation, and reopening.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const interactionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId, occurredAt: NOW + 86400, endAt: NOW + 86400 + 1800, location: "Original" });

      // Schedule (enroll): the meeting-change statement and the link+
      // history insert pair commit together.
      const scheduleStatements = await buildTripMeetingScheduledStatements(db, interactionId, userId, "primary", NOW);
      assert.equal(scheduleStatements.length, 2, "enrolling for the first time builds the link+history insert pair");
      await db.batch([
        db.prepare("UPDATE interactions SET location = ? WHERE id = ?").bind("Updated atomically", interactionId),
        ...scheduleStatements,
      ]);
      assert.equal((await db.prepare("SELECT location FROM interactions WHERE id = ?").bind(interactionId).first()).location, "Updated atomically");
      let link = await getTripMeetingCalendarLink(db, interactionId);
      assert.ok(link, "the calendar link committed in the SAME atomic batch as the meeting change");
      assert.equal(link.desiredState, "present");
      assert.equal(link.desiredRevision, 1);

      // Reschedule: an already-present link dispatches to exactly one
      // guarded UPDATE, still merged into the caller's own batch.
      const rescheduleStatements = await buildTripMeetingScheduledStatements(db, interactionId, userId, "primary", NOW + 1);
      assert.equal(rescheduleStatements.length, 1, "an already-present link reschedules via exactly one guarded UPDATE");
      await db.batch([
        db.prepare("UPDATE interactions SET location = ? WHERE id = ?").bind("Rescheduled atomically", interactionId),
        ...rescheduleStatements,
      ]);
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredRevision, 2);

      // Cancellation: the desired_state flip and the history cleanup flag
      // commit together with the meeting-side change in one batch.
      const cancelStatements = await buildTripMeetingCancelledStatements(db, interactionId, NOW + 2);
      assert.equal(cancelStatements.length, 2, "cancel commits the desired_state flip and the history cleanup flag together");
      await db.batch([
        db.prepare("UPDATE interactions SET source = ? WHERE id = ?").bind("cancelled:capture-scheduled:trip:t1:meeting", interactionId),
        ...cancelStatements,
      ]);
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredState, "absent");
      assert.equal(link.desiredRevision, 3);

      // Reopen: scheduling again after a cancellation dispatches to
      // applyReopen, still merged into the caller's own single batch.
      const reopenStatements = await buildTripMeetingScheduledStatements(db, interactionId, userId, "primary", NOW + 3);
      await db.batch([
        db.prepare("UPDATE interactions SET source = ? WHERE id = ?").bind("capture-scheduled:trip:t1:meeting", interactionId),
        ...reopenStatements,
      ]);
      link = await getTripMeetingCalendarLink(db, interactionId);
      assert.equal(link.desiredState, "present");
      assert.equal(link.generation, 1, "reopening bumped the generation");

      // Preserve existing scheduling when Calendar is unavailable: a
      // build failure (simulated by a bad fosBaseUrl is not enough to
      // fail the READ this performs, so instead confirm directly that a
      // meeting with NO link at all still builds zero cancel statements,
      // never blocking a cancel-only caller that has no calendar
      // involvement yet) contributes nothing, never blocks the caller.
      const neverEnrolledInteractionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId: neverEnrolledInteractionId, occurredAt: NOW + 172800, endAt: NOW + 172800 + 1800, location: null });
      const noopCancelStatements = await buildTripMeetingCancelledStatements(db, neverEnrolledInteractionId, NOW);
      assert.deepEqual(noopCancelStatements, [], "cancelling a meeting that was never enrolled for sync must contribute nothing to the caller's batch");

      // Failure at the persistence boundary: a combined batch containing
      // a genuine constraint violation (a duplicate calendar_event_links
      // primary key, discovered only at write time, never at prepare
      // time) must roll back the WHOLE batch -- the meeting-side change
      // included -- never a partial commit of one half only.
      const secondInteractionId = uniqueId("int");
      await seedTripMeeting(db, { userId, donorId, interactionId: secondInteractionId, occurredAt: NOW + 259200, endAt: NOW + 259200 + 1800, location: "Before" });
      const store = new D1CalendarStore(db);
      const doomedStatements = store.insertLinkWithHistoryStatements(
        {
          id: link.id, interactionId: secondInteractionId, userId, googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null,
          desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null,
          attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null,
        },
        NOW + 4,
      );
      await assert.rejects(
        () => db.batch([
          db.prepare("UPDATE interactions SET location = ? WHERE id = ?").bind("Should never land", secondInteractionId),
          ...doomedStatements,
        ]),
        "a genuine persistence-boundary failure (a real primary-key collision) must reject the whole combined batch",
      );
      const secondLink = await getTripMeetingCalendarLink(db, secondInteractionId);
      assert.equal(secondLink, null, "the doomed link insert must never have landed");
      const secondLocation = (await db.prepare("SELECT location FROM interactions WHERE id = ?").bind(secondInteractionId).first()).location;
      assert.equal(secondLocation, "Before", "the meeting-side change in the SAME doomed batch must roll back too -- true atomicity, not independent partial writes");

      // Recovery: a subsequent, real attempt for the second meeting must
      // proceed normally -- the rolled-back failure above left no
      // leftover lock or half-written state behind.
      const recoveryStatements = await buildTripMeetingScheduledStatements(db, secondInteractionId, userId, "primary", NOW + 5);
      await db.batch([
        db.prepare("UPDATE interactions SET location = ? WHERE id = ?").bind("Recovered", secondInteractionId),
        ...recoveryStatements,
      ]);
      const recoveredLink = await getTripMeetingCalendarLink(db, secondInteractionId);
      assert.ok(recoveredLink, "a subsequent real attempt must succeed cleanly after the earlier rolled-back batch");
      assert.equal(recoveredLink.desiredState, "present");
    }

    process.stdout.write("trip-calendar-sync-integration.test.mjs: all assertions passed\n");
  } finally {
    await dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
