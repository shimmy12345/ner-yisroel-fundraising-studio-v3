import assert from "node:assert/strict";
import { createLocalD1Database } from "../lib/calendar/testing/local-d1.ts";
import { D1CalendarStore } from "../lib/calendar/d1-calendar-store.ts";
import { createGoogleCalendarClient } from "../lib/calendar/google-calendar-client.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";
import { enrollMeetingForSync, recordCancel, recordReschedule, reconcilePresentAbsent } from "../lib/calendar/calendar-sync-reconciler.ts";
import { buildGoogleEventBody, validateMeetingDesiredFields } from "../lib/calendar/calendar-event-body.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// BOTH real adapters together: the real D1-backed store AND the real
// Google Calendar HTTP client (mocked transport only -- no live Google
// call), driven through the SAME unmodified reconciler every production
// call site will use. CI-only, same reason as calendar-d1-store.test.mjs
// (requires a real local Workers/D1 runtime) -- run via `pnpm run
// test:calendar-d1`, not `pnpm test`.

const NOW = 2_000_000;
let nextId = 0;
function uniqueId(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

async function seedInteraction(db, { interactionId, userId = "u1", donorId = "d1" }) {
  await db.prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW).run();
  await db.prepare("INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?)").bind(donorId, userId, NOW, NOW).run();
  await db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, 'Meeting', ?, ?)").bind(interactionId, donorId, userId, NOW + 86400, NOW, NOW).run();
}

const CREDENTIALS = { clientId: "c", clientSecret: "s", refreshToken: "r" };

async function run() {
  const { db, dispose } = await createLocalD1Database();
  try {
    const store = new D1CalendarStore(db);

    // =======================================================================
    // Full enroll -> reconcile (create) -> reschedule -> reconcile (update,
    // location cleared) -> cancel -> reconcile (delete) cycle, entirely
    // through the real D1 store AND the real Google client together.
    // =======================================================================
    {
      const interactionId = uniqueId("int-full-cycle");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      const eventId = deriveGoogleEventId(interactionId, 0);

      let fields = { interactionId, donorDisplayName: "Test Donor", allDay: false, allDayDate: null, occurredAt: NOW + 3600, endAt: NOW + 7200, timezone: "America/Chicago", location: "123 Main St", fosUrl: "https://shimmydonors.org/donors/d1" };
      const getFields = async () => fields;

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });

      // GET 404 (never created), then the real INSERT. The client caches
      // its OAuth token per instance (getAccessToken() only re-fetches
      // once the cached one is near expiry) -- this ONE token response is
      // the only one needed for every real API call this whole block
      // makes (create, reschedule, cancel), never one per call.
      transport.enqueue(tokenResponse());
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue(jsonResponse(201, { id: eventId, summary: "x", description: "y", start: fields2start(fields), end: fields2end(fields), extendedProperties: { private: { fosManagedEventId: eventId } }, etag: "\"etag-1\"" }));
      const createOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(createOutcome.kind, "synced");
      const insertCall = transport.calls.find((c) => c.init.method === "POST" && c.url.includes("/calendar/v3/"));
      const insertedBody = JSON.parse(insertCall.init.body);
      assert.deepEqual(insertedBody.start, { dateTime: new Date(fields.occurredAt * 1000).toISOString(), timeZone: "America/Chicago" }, "a timed meeting's explicit timezone must be sent exactly as recorded");
      assert.equal(insertedBody.location, "123 Main St");

      // Reschedule, AND clear the location -- the exact bug this phase's
      // location-clearing fix targets.
      fields = { ...fields, location: null };
      await recordReschedule(store, NOW + 2, interactionId);
      transport.enqueue(jsonResponse(200, { id: eventId, summary: "old", description: "old", location: "123 Main St", start: fields2start({ ...fields, location: "123 Main St" }), end: fields2end(fields), etag: "\"etag-1\"", htmlLink: "https://calendar.google.com/x", extendedProperties: { private: { fosManagedEventId: eventId } } }));
      transport.enqueue(jsonResponse(200, { id: eventId, summary: "x", description: "y", location: "", start: fields2start(fields), end: fields2end(fields), etag: "\"etag-2\"", extendedProperties: { private: { fosManagedEventId: eventId } } }));
      const rescheduleOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 3);
      assert.equal(rescheduleOutcome.kind, "synced");
      const updateCall = transport.calls.filter((c) => c.init.method === "PUT").at(-1);
      const updatedBody = JSON.parse(updateCall.init.body);
      assert.equal(updatedBody.location, "", "clearing a previously-set location must send an explicit empty string, never omit the key");
      assert.equal(updatedBody.htmlLink, undefined, "a read-only field from the GET response must never be sent back on UPDATE");

      // Cancel -> the real DELETE (via its own internal verifying GET).
      await recordCancel(store, NOW + 4, interactionId);
      transport.enqueue(jsonResponse(200, { id: eventId, summary: "x", description: "y", start: fields2start(fields), end: fields2end(fields), etag: "\"etag-2\"", extendedProperties: { private: { fosManagedEventId: eventId } } }));
      transport.enqueue(jsonResponse(204, {}));
      const deleteOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 5);
      assert.equal(deleteOutcome.kind, "deleted");
      assert.ok(transport.calls.some((c) => c.init.method === "DELETE"));
    }

    // =======================================================================
    // All-day meeting: date-only start/end, exclusive end = start + 1 day.
    // =======================================================================
    {
      const interactionId = uniqueId("int-all-day");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      const eventId = deriveGoogleEventId(interactionId, 0);
      const fields = { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
      const getFields = async () => fields;

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      transport.enqueue(tokenResponse()); // one cached token for this client covers both calls below
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue(jsonResponse(201, { id: eventId, summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" }, extendedProperties: { private: { fosManagedEventId: eventId } }, etag: "\"e\"" }));
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(outcome.kind, "synced");
      const insertCall = transport.calls.find((c) => c.init.method === "POST" && c.url.includes("/calendar/v3/"));
      const body = JSON.parse(insertCall.init.body);
      assert.deepEqual(body.start, { date: "2026-03-05" });
      assert.deepEqual(body.end, { date: "2026-03-06" }, "an all-day event's exclusive end must be exactly start + 1 calendar day");
    }

    // =======================================================================
    // A controlled failure: insert() times out against the real client --
    // an ambiguous outcome, preserved (createStatus stays in_flight, never
    // resolved as a confirmed failure) -- followed by a real retry that
    // succeeds, against the real D1 store.
    // =======================================================================
    {
      const interactionId = uniqueId("int-controlled-timeout");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      const eventId = deriveGoogleEventId(interactionId, 0);
      const fields = { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
      const getFields = async () => fields;

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      transport.enqueue(tokenResponse()); // one cached token for this client covers every call below, including the retry
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue({ throwAbort: true }); // the create attempt times out
      const failedOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(failedOutcome.kind, "failed");
      const link = await store.getLinkByInteraction(interactionId);
      const historyAfterTimeout = await store.getHistory(link.id, 0);
      assert.equal(historyAfterTimeout.createStatus, "in_flight", "an ambiguous (timed-out) creation must be preserved as in_flight against the real D1 store, never recorded as a confirmed failure");

      // Retry, against the real D1 store + real client: GET still 404
      // (the timed-out insert never actually landed), INSERT succeeds.
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue(jsonResponse(201, { id: eventId, summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" }, extendedProperties: { private: { fosManagedEventId: eventId } }, etag: "\"e\"" }));
      const retryOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 2);
      assert.equal(retryOutcome.kind, "synced");
      const historyAfterRetry = await store.getHistory(link.id, 0);
      assert.equal(historyAfterRetry.createStatus, "succeeded");
    }

    // =======================================================================
    // 2026-10-19 independent review, issue 2 -- FIXED (was a reported
    // core limitation as of the prior phase): buildGoogleEventBody still
    // never validates endAt > occurredAt (unchanged, frozen), but
    // validateMeetingDesiredFields now catches it BEFORE any network
    // call, against the real D1 store -- Google is never even contacted
    // for locally-invalid content.
    // =======================================================================
    {
      const interactionId = uniqueId("int-end-before-start");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      // endAt BEFORE occurredAt -- buildGoogleEventBody still has no
      // check for this (frozen, unchanged); confirm it does NOT throw.
      const invalidFields = { interactionId, donorDisplayName: "Test Donor", allDay: false, allDayDate: null, occurredAt: NOW + 7200, endAt: NOW + 3600, timezone: "America/Chicago", location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
      assert.doesNotThrow(() => buildGoogleEventBody(invalidFields), "buildGoogleEventBody itself still does not validate endAt > occurredAt -- unchanged, frozen core");

      const getFields = async () => invalidFields;
      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(outcome.kind, "invalid", "invalid content must now be rejected as a definitive, permanent 'invalid' outcome against the real D1 store + real Google client");
      assert.equal(transport.calls.length, 0, "Google must never be contacted for locally-invalid content, against the real adapters");
      const link = await store.getLinkByInteraction(interactionId);
      const history = await store.getHistory(link.id, 0);
      assert.equal(link.syncStatus, "invalid");
      assert.notEqual(history.createStatus, "in_flight", "FIXED: no longer left in the same ambiguous bucket a genuine timeout uses");
    }

    // =======================================================================
    // A real Google 400 on OTHERWISE-valid content (our own pre-check
    // passes; Google's own, separate validation still rejects it) must
    // ALSO be a definitive, permanent 'invalid' outcome against the real
    // D1 store + real Google client -- never conflated with a transient
    // timeout at the bookkeeping level.
    // =======================================================================
    {
      const interactionId = uniqueId("int-real-google-400");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      const validFields = { interactionId, donorDisplayName: "Test Donor", allDay: false, allDayDate: null, occurredAt: NOW + 3600, endAt: NOW + 7200, timezone: "America/Chicago", location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
      assert.equal(validateMeetingDesiredFields(validFields).valid, true, "sanity: this content passes local validation");

      const getFields = async () => validFields;
      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      transport.enqueue(tokenResponse()); // one cached token for this client covers both calls below
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue(jsonResponse(400, { error: { message: "some Google-side-only validation rule our local checks don't know about" } }));
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(outcome.kind, "invalid", "a real Google 400 must be a definitive, permanent rejection against the real D1 store + real Google client, never the same bucket as a timeout");
      const link = await store.getLinkByInteraction(interactionId);
      const history = await store.getHistory(link.id, 0);
      assert.equal(link.syncStatus, "invalid");
      assert.equal(history.createStatus, "invalid", "FIXED: the generation's own history durably records the permanent rejection against real D1");

      // "Stop automatic retries for permanent invalid requests," against
      // the real D1 store: a second attempt still checks GET (the event
      // genuinely doesn't exist, same as the existing "missing_remotely"
      // pattern's own re-check), but must NEVER re-attempt the INSERT.
      const callsBeforeSecondAttempt = transport.calls.length;
      transport.enqueue(jsonResponse(404, {})); // cached token still valid -- only the GET itself is a new call
      const secondAttempt = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 2);
      assert.equal(secondAttempt.kind, "invalid", "a generation already marked 'invalid' in real D1 must not be silently retried");
      assert.equal(transport.calls.length, callsBeforeSecondAttempt + 1, "the second attempt must make its own GET but never re-attempt the INSERT that already permanently failed");
      assert.ok(!transport.calls.some((c, i) => i >= callsBeforeSecondAttempt && c.init.method === "POST"), "no new INSERT call must ever be sent for an already-'invalid' generation");
    }

    // =======================================================================
    // 2026-10-19 independent review, issue 1 -- against the real D1
    // store + real Google client together: a successful-status but
    // malformed INSERT response must never be confirmed as synced.
    // =======================================================================
    {
      const interactionId = uniqueId("int-malformed-insert-response");
      await seedInteraction(db, { interactionId });
      const transport = new MockHttpTransport();
      const client = createGoogleCalendarClient(CREDENTIALS, transport);
      const fields = { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
      const getFields = async () => fields;

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      transport.enqueue(tokenResponse());
      transport.enqueue(jsonResponse(404, {}));
      transport.enqueue(jsonResponse(200, {})); // pre-fix reproduction: an empty {} on a 200
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.notEqual(outcome.kind, "synced", "an empty/malformed INSERT response must never be confirmed as synced, against the real D1 store + real Google client");
      const link = await store.getLinkByInteraction(interactionId);
      assert.notEqual(link.syncStatus, "synced");
      const history = await store.getHistory(link.id, 0);
      assert.equal(history.createStatus, "in_flight", "a genuinely ambiguous malformed response must leave createStatus in_flight against real D1, never confirmed and never a definitive failure that would trigger a blind replacement insert");
    }

    process.stdout.write("calendar-adapters-integration.test.mjs: all assertions passed against the REAL D1 store + REAL (mocked-transport) Google client\n");
  } finally {
    await dispose();
  }
}

function fields2start(fields) {
  if (fields.allDay) return { date: fields.allDayDate };
  return { dateTime: new Date(fields.occurredAt * 1000).toISOString(), timeZone: fields.timezone };
}
function fields2end(fields) {
  if (fields.allDay) return { date: fields.allDayDate };
  return { dateTime: new Date(fields.endAt * 1000).toISOString(), timeZone: fields.timezone };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
