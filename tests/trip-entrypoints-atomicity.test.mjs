import assert from "node:assert/strict";
import { register } from "node:module";

// Must happen before ANY dynamic import of lib/relationships/trips-data.ts
// -- see tests/fixtures/cloudflare-workers-loader.mjs's own header for
// why this is a loader hook rather than a simpler stub, and why the
// import below must stay dynamic.
register("./fixtures/cloudflare-workers-loader.mjs", import.meta.url);
globalThis.__FUNDRAISING_OS_ENVIRONMENT__ = "production-independent";

import { createLocalD1Database } from "../lib/calendar/testing/local-d1.ts";
import { StatefulCalendarClient } from "../lib/calendar/testing/stateful-calendar-client.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";
import { attemptImmediateTripCalendarSync, recordTripMeetingCancelled } from "../lib/relationships/trip-calendar-sync.ts";
import { tripMeetingInteractionId } from "../lib/relationships/trip-model.ts";
import { env } from "./fixtures/fake-cloudflare-workers.mjs";

// Independent review, second follow-up (2026-10-19): exercises the
// ACTUAL application entry points (scheduleProspectMeeting,
// setSimpleProspectStatus, retryTripMeetingCalendarSync) -- never a
// stand-in UPDATE in place of them -- against a REAL local D1 database,
// via the module-stub loader above. Reproduces, independently, the two
// persistence failures this round's own instruction reported:
//
// 1. "Conflicting meeting/Calendar transitions": scheduleProspectMeeting
//    used to have NO precondition tying its own interactions/
//    trip_prospects writes to the calendar link state it read moments
//    earlier -- a competing cancellation landing in between left FOS
//    saying "meeting scheduled" while the calendar intent stayed
//    "absent." Fixed in lib/relationships/trip-calendar-sync.ts's
//    planTripMeetingScheduledIntent (a D1CrossTableGuard shared across
//    every statement in the combined batch) -- proven here by literally
//    reproducing the race through the real entry point, not merely
//    through the lower-level builder.
// 2. "Stop silently losing Calendar intent on database read failures":
//    the two swallowing wrapper functions this round's instruction named
//    (tripCalendarScheduleStatements/tripCalendarCancelStatements) no
//    longer exist -- a database-read failure while building the
//    calendar intent now aborts the whole request (`calendar_unavailable`)
//    before any db.batch() runs.
//
// CI-only (needs the real local Workers/D1 runtime -- see
// tests/trip-calendar-sync-integration.test.mjs's own header for why
// this project's Windows sandbox cannot run it). Run via `pnpm run
// test:calendar-d1`.

const NOW = 5_000_000;
const OWNER_EMAIL = "owner@example.test";

let nextId = 0;
function uniqueId(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

async function seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId, donorState = "IL" }) {
  await db.prepare("INSERT INTO users (id, email, timezone, created_at, updated_at) VALUES (?, ?, 'America/Chicago', ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW).run();
  await db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, state, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?, ?)").bind(donorId, userId, donorState, NOW, NOW).run();
  await db.prepare("INSERT INTO trips (id, owner_user_id, name, start_date, end_date, created_at, updated_at) VALUES (?, ?, 'Test Trip', ?, ?, ?, ?)").bind(tripId, userId, NOW, NOW + 7 * 86400, NOW, NOW).run();
  await db.prepare("INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, selected_at, created_at, updated_at) VALUES (?, ?, ?, 'manual', 'not_contacted', ?, ?, ?)").bind(prospectId, tripId, donorId, NOW, NOW, NOW).run();
}

function identityTransport() {
  const transport = new MockHttpTransport();
  transport.enqueue(tokenResponse());
  transport.enqueue(jsonResponse(200, { email: OWNER_EMAIL }));
  return transport;
}

// Reproduces "pause after the read, let a competing commit land, then
// resume" deterministically, as pure TEST-side instrumentation -- never
// touching lib/relationships/trips-data.ts itself. Wraps the real local
// D1 binding so the FIRST call to `.batch()` runs `onFirstBatch()`
// (awaited) before forwarding to the real batch -- i.e. after whatever
// read already happened to build those statements, but before they
// land.
function interceptFirstBatch(realDb, onFirstBatch) {
  let intercepted = false;
  return {
    prepare: (sql) => realDb.prepare(sql),
    batch: async (statements) => {
      if (!intercepted) {
        intercepted = true;
        await onFirstBatch();
      }
      return realDb.batch(statements);
    },
  };
}

// Simulates a genuine database-read failure for one specific query --
// the exact reproduction this round's instruction describes ("make the
// scheduling builder throw a database-read error").
function withThrowingSelect(realDb, sqlPattern, error) {
  return {
    prepare: (sql) => {
      if (sqlPattern.test(sql)) return { bind() { throw error; } };
      return realDb.prepare(sql);
    },
    batch: (statements) => realDb.batch(statements),
  };
}

// Simulates a genuine, non-constraint batch failure (a real connectivity
// problem, never a benign guard mismatch) -- must propagate, never be
// silently swallowed.
function withThrowingBatch(realDb, error) {
  let thrown = false;
  return {
    prepare: (sql) => realDb.prepare(sql),
    batch: async (statements) => {
      if (!thrown) {
        thrown = true;
        throw error;
      }
      return realDb.batch(statements);
    },
  };
}

async function run() {
  const { db, dispose } = await createLocalD1Database();
  env.APP_BASE_URL = "https://example.test";
  const trips = await import("../lib/relationships/trips-data.ts");

  try {
    // =======================================================================
    // 1. The precise cancel/reschedule interleaving (requirement 1's own
    // exact reproduction), through the REAL scheduleProspectMeeting entry
    // point: an enrolled, present link; a reschedule request reads it as
    // present; a competing cancellation commits first; the reschedule's
    // own (now-stale) batch runs. The meeting change and the calendar
    // intent must end up agreeing -- never FOS saying "scheduled" while
    // the calendar intent stays "absent."
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);
      env.DB = db;

      const first = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      assert.equal(first.ok, true);
      const linkAfterFirst = await db.prepare("SELECT * FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkAfterFirst.desired_state, "present");
      assert.equal(linkAfterFirst.generation, 0);

      // The race: a competing cancellation commits in the gap between
      // this reschedule's own read and its batch actually running.
      env.DB = interceptFirstBatch(db, async () => {
        await recordTripMeetingCancelled(db, interactionId, NOW + 1);
      });
      const result = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-02T11:00", "New Office", 30, true, "America/Chicago", NOW + 2);
      env.DB = db;
      assert.equal(result.ok, true, "the retry loop must converge once the calendar link's state is re-read fresh, rather than giving up with the meeting and calendar sides disagreeing");

      const link = await db.prepare("SELECT * FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(link.desired_state, "present", "the FINAL calendar intent must agree with FOS's own 'scheduled' state -- never left behind at 'absent'");
      assert.equal(link.generation, 1, "the competing cancellation forced this to become a REOPEN (new generation) once re-read fresh, never a reschedule applied against a stale 'present' assumption");

      const prospect = await db.prepare("SELECT status FROM trip_prospects WHERE id = ?").bind(prospectId).first();
      assert.equal(prospect.status, "meeting_scheduled");
      const interaction = await db.prepare("SELECT location FROM interactions WHERE id = ?").bind(interactionId).first();
      assert.equal(interaction.location, "New Office", "the meeting's own final details must be the ones that actually committed consistently with the calendar, never a stale first attempt's");
    }

    // =======================================================================
    // 2. Competing reopen transitions: two overlapping scheduleProspectMeeting
    // calls both racing to reopen the SAME canceled link (e.g. a double
    // click, or two tabs). Only ONE reopen (one new generation) must ever
    // happen -- the losing attempt's own retry must recognize the link is
    // already present and fall back to an ordinary reschedule, never
    // allocate a second generation for the same cancellation.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);
      env.DB = db;

      await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      const declined = await trips.setSimpleProspectStatus(userId, tripId, prospectId, "declined", NOW + 1);
      assert.equal(declined.ok, true);
      const linkAfterDecline = await db.prepare("SELECT generation, desired_state FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkAfterDecline.desired_state, "absent");
      assert.equal(linkAfterDecline.generation, 0);

      env.DB = interceptFirstBatch(db, async () => {
        const winner = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-05T09:00", "Winner Office", 30, true, "America/Chicago", NOW + 10);
        assert.equal(winner.ok, true, "the first (winning) concurrent reopen attempt must succeed cleanly");
      });
      const loser = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-06T09:00", "Loser Office", 30, true, "America/Chicago", NOW + 11);
      env.DB = db;
      assert.equal(loser.ok, true, "the losing concurrent attempt must also converge, via its own retry, once it re-reads the winner's already-committed reopen");

      const link = await db.prepare("SELECT generation FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(link.generation, 1, "only ONE reopen must have happened across both concurrent attempts, never two generations allocated for the same cancellation");
      const interaction = await db.prepare("SELECT location FROM interactions WHERE id = ?").bind(interactionId).first();
      assert.equal(interaction.location, "Loser Office", "whichever attempt's own retry actually committed last determines the final meeting details, consistent with the single reopened generation");
    }

    // =======================================================================
    // 3. Database read failures: a genuine error reading the current
    // calendar link state must abort the WHOLE request before any save --
    // never silently lose the calendar intent while the meeting change
    // still succeeds (the exact bug the old swallowing wrapper functions
    // produced).
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);

      env.DB = withThrowingSelect(db, /SELECT \* FROM calendar_event_links WHERE interaction_id/, new Error("simulated database read failure"));
      const result = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      env.DB = db;
      assert.deepEqual(result, { ok: false, reason: "calendar_unavailable" });

      const interaction = await db.prepare("SELECT 1 FROM interactions WHERE id = ?").bind(interactionId).first();
      assert.equal(interaction, null, "the meeting change must never be saved when the calendar intent could not even be read");
      const prospect = await db.prepare("SELECT status FROM trip_prospects WHERE id = ?").bind(prospectId).first();
      assert.equal(prospect.status, "not_contacted", "the prospect's own status must be completely unaffected by the aborted attempt");
      const link = await db.prepare("SELECT 1 FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(link, null, "no partial calendar link must have been created either");
    }

    // =======================================================================
    // 4. Batch failures: a genuine, non-constraint database failure (a
    // real connectivity problem, not a benign guard mismatch) must
    // propagate -- never be caught and silently treated as success.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);

      env.DB = withThrowingBatch(db, new Error("simulated connectivity failure"));
      await assert.rejects(
        () => trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW),
        /simulated connectivity failure/,
      );
      env.DB = db;
      const interaction = await db.prepare("SELECT 1 FROM interactions WHERE id = ?").bind(interactionId).first();
      assert.equal(interaction, null, "a genuine batch failure must never be silently swallowed as a successful save");
    }

    // =======================================================================
    // 5. Recovery and subsequent cancellation: once a transient condition
    // clears, a later attempt must succeed cleanly with no leftover state
    // from the earlier aborted one, and a subsequent cancellation must
    // still work correctly afterward.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);

      env.DB = withThrowingSelect(db, /SELECT \* FROM calendar_event_links WHERE interaction_id/, new Error("transient failure"));
      const failed = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      assert.equal(failed.ok, false);

      env.DB = db; // the transient condition clears
      const recovered = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW + 1);
      assert.equal(recovered.ok, true, "a later attempt must succeed cleanly once the transient condition clears");
      const link = await db.prepare("SELECT desired_state, desired_revision FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(link.desired_state, "present");
      assert.equal(link.desired_revision, 1, "the earlier aborted attempt must have left no leftover state -- this is still generation 0's FIRST real enrollment, not a phantom revision bump");

      const cancelled = await trips.setSimpleProspectStatus(userId, tripId, prospectId, "declined", NOW + 2);
      assert.equal(cancelled.ok, true, "a subsequent cancellation must still work correctly after the earlier recovery");
      const linkAfterCancel = await db.prepare("SELECT desired_state FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkAfterCancel.desired_state, "absent");
    }

    // =======================================================================
    // 6. Calendar-disabled scheduling: ordinary scheduling must succeed
    // exactly as before when calendar sync is disabled for the owner (and
    // no credentials are configured) -- the durable calendar intent is
    // still recorded (only the live network attempt is gated by the
    // enabled flag), so this must stay distinguishable from, and never
    // confused with, a database failure.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);
      env.DB = db;

      const enabledRow = await db.prepare("SELECT calendar_sync_enabled FROM users WHERE id = ?").bind(userId).first();
      assert.equal(enabledRow.calendar_sync_enabled, 0, "sanity check: calendar sync defaults to disabled, and no Google credentials are configured in this test's env stub");

      const result = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      assert.equal(result.ok, true, "ordinary scheduling must succeed exactly as before when calendar sync is disabled");
      const link = await db.prepare("SELECT sync_status FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.ok(link, "the durable calendar intent is still recorded even though sync is disabled -- disabling only gates the live network attempt, never this read/write");
      assert.equal(link.sync_status, "pending");
    }

    // =======================================================================
    // 7. Persisted meeting/link/history consistency and simulated remote
    // event existence: after scheduling and cancelling through the REAL
    // entry points, a real reconciliation pass against a STATEFUL
    // simulated Google calendar must behave consistently with what was
    // actually persisted -- proving the recorded intent is not merely
    // internally consistent bookkeeping but genuinely actionable.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);
      env.DB = db;

      const scheduled = await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      assert.equal(scheduled.ok, true);

      const client = new StatefulCalendarClient();
      const sweep = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true,
        credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 1,
        transport: identityTransport(), client,
      });
      assert.equal(sweep.reconciled[0].kind, "synced");
      assert.equal(client.activeEventIds("primary").length, 1, "the simulated remote calendar must now hold exactly one real event, consistent with the persisted link");
      const linkAfterSync = await db.prepare("SELECT sync_status, google_event_id FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkAfterSync.sync_status, "synced");
      assert.deepEqual(client.activeEventIds("primary"), [linkAfterSync.google_event_id], "the persisted link's own google_event_id must match the real simulated event");

      const cancelled = await trips.setSimpleProspectStatus(userId, tripId, prospectId, "declined", NOW + 2);
      assert.equal(cancelled.ok, true);
      const sweep2 = await attemptImmediateTripCalendarSync({
        db, userId, environment: "production-independent", calendarSyncEnabled: true,
        credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
        calendarId: "primary", stagingTestCalendarId: null, fosBaseUrl: "https://example.test", now: NOW + 3,
        transport: identityTransport(), client,
      });
      assert.equal(sweep2.reconciled[0].kind, "deleted");
      assert.deepEqual(client.activeEventIds("primary"), [], "cancelling through the real entry point must result in the simulated remote event actually being removed");
    }

    // =======================================================================
    // Retry (retryTripMeetingCalendarSync), through the real entry point:
    // never touches durable intent, works normally with no credentials
    // configured (a safe no-op), and -- critically -- never reopens a
    // canceled meeting.
    // =======================================================================
    {
      const userId = uniqueId("u");
      const donorId = uniqueId("d");
      const tripId = uniqueId("t");
      const prospectId = uniqueId("p");
      await seedOwnerTripProspect(db, { userId, donorId, tripId, prospectId });
      const interactionId = tripMeetingInteractionId(prospectId);
      env.DB = db;

      await trips.scheduleProspectMeeting(userId, tripId, prospectId, "2026-12-01T10:00", "Office", 30, true, "America/Chicago", NOW);
      await trips.setSimpleProspectStatus(userId, tripId, prospectId, "declined", NOW + 1);
      const linkBeforeRetry = await db.prepare("SELECT desired_state, desired_revision FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkBeforeRetry.desired_state, "absent");

      const found = await trips.retryTripMeetingCalendarSync(userId, tripId, prospectId, NOW + 2);
      assert.equal(found, true);
      const linkAfterRetry = await db.prepare("SELECT desired_state, desired_revision FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first();
      assert.equal(linkAfterRetry.desired_state, "absent", "Retry must never reopen a canceled meeting");
      assert.equal(linkAfterRetry.desired_revision, linkBeforeRetry.desired_revision, "Retry must never write a new intent revision at all -- it only ever reconciles, never records");
    }

    process.stdout.write("trip-entrypoints-atomicity.test.mjs: all assertions passed\n");
  } finally {
    await dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
