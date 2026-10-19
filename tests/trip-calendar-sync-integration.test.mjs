import assert from "node:assert/strict";
import { createLocalD1Database } from "../lib/calendar/testing/local-d1.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";
import { StatefulCalendarClient } from "../lib/calendar/testing/stateful-calendar-client.ts";
import {
  attemptImmediateTripCalendarSync, getTripMeetingCalendarLink, googleCalendarEventViewUrl, isCalendarSyncEnabledForUser,
  loadCalendarConnectionStatus, loadTripMeetingFields, recordTripMeetingCancelled, recordTripMeetingScheduled,
  setCalendarSyncEnabledForUser,
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

    process.stdout.write("trip-calendar-sync-integration.test.mjs: all assertions passed\n");
  } finally {
    await dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
