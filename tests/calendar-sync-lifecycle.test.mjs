import assert from "node:assert/strict";
import { enrollMeetingForSync, recordCancel, recordComplete, runReconciliationSweep } from "../lib/calendar/calendar-sync-reconciler.ts";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { ScriptedCalendarClient, ok204, ok201, err404 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";
import { isCalendarSyncAllowed } from "../lib/calendar/calendar-sync-guard.ts";

const NOW = 1000;
function makeFields(interactionId) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1" };
}

async function run() {
  // --- Completion while initial sync is still pending: no calendar effect at all ---
  {
    const store = new InMemoryCalendarStore();
    const link = await enrollMeetingForSync(store, NOW, { interactionId: "int-complete", userId: "u1", googleCalendarId: "primary" });
    assert.equal(link.syncStatus, "pending", "never synced yet at the moment of completion");
    const before = JSON.stringify(await store.getLinkByInteraction("int-complete"));
    await recordComplete(store, NOW + 10, "int-complete");
    const after = JSON.stringify(await store.getLinkByInteraction("int-complete"));
    assert.equal(before, after, "marking a meeting completed must never touch calendar_event_links at all, whether or not the initial sync has happened yet");
  }

  // --- Cancellation while disconnected: the durable intent write succeeds
  // with zero network access, and reconnecting later picks up the
  // already-recorded pending work (no automatic backfill of anything
  // ELSE -- only what was already durably recorded). ---
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient(); // no responses enqueued at all -- any call would throw
    const interactionId = "int-disconnected-cancel";
    await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });

    // Simulate "disconnected": calendar_sync_enabled=false means the real
    // route layer would never even construct a client or call reconcile --
    // proven here structurally by never giving recordCancel a client at
    // all (its signature has no client parameter -- it cannot reach
    // Google even if it tried).
    const ok = await recordCancel(store, NOW + 1, interactionId);
    assert.equal(ok, true, "a cancel must be durably recorded even while fully disconnected from Google");
    assert.equal(client.calls.length, 0, "recording the cancel intent must make zero network calls");

    const link = await store.getLinkByInteraction(interactionId);
    assert.equal(link.desiredState, "absent");
    assert.notEqual(link.syncedRevision, link.desiredRevision, "the pending work (the not-yet-applied cancel) must be durably visible, ready for the next sweep once reconnected");

    // "Reconnect": now a real client is available and a sweep runs.
    const eventId = deriveGoogleEventId(interactionId, 0);
    client.enqueueValue("delete", eventId, ok204());
    const sweep = await runReconciliationSweep(store, client, makeFields, "reconnect-sweep", NOW + 2);
    assert.equal(sweep.reconciled.length, 1);
    assert.equal(sweep.reconciled[0].kind, "deleted");

    const after = await store.getLinkByInteraction(interactionId);
    assert.equal(after.syncedRevision, after.desiredRevision, "reconnecting must pick up and complete exactly the pending work that was already durably recorded");
  }

  // --- Retry-vs-enroll separation: the sweep only ever touches EXISTING
  // link rows -- a meeting with no link row is completely invisible to
  // it, structurally, never auto-enrolled. ---
  {
    const store = new InMemoryCalendarStore();
    const client = new ScriptedCalendarClient();

    // Two meetings: one properly enrolled and needing a retry (simulating
    // a prior failure), one that predates this feature entirely and was
    // NEVER enrolled.
    await enrollMeetingForSync(store, NOW, { interactionId: "int-enrolled", userId: "u1", googleCalendarId: "primary" });
    // "int-never-enrolled" deliberately has no enrollMeetingForSync call at
    // all -- representing a pre-existing meeting the owner never opted in.

    const eventId = deriveGoogleEventId("int-enrolled", 0);
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));

    const sweep = await runReconciliationSweep(store, client, makeFields, "sweep", NOW + 1);
    assert.equal(sweep.reconciled.length, 1, "the sweep must act on exactly the one enrolled meeting");
    assert.equal(sweep.reconciled[0].kind, "synced");

    // The never-enrolled meeting was never looked up, never had any client
    // call made for it, and still has no link row whatsoever.
    assert.ok(!client.calls.some((c) => c.eventId === deriveGoogleEventId("int-never-enrolled", 0)), "the sweep must never make any Google API call for a meeting that was never explicitly enrolled");
    const neverEnrolledLink = await store.getLinkByInteraction("int-never-enrolled");
    assert.equal(neverEnrolledLink, null, "a meeting with no link row stays completely untouched -- 'retrying already-enrolled work' and 'enrolling a new meeting' are structurally distinct operations");
  }

  // --- All-day calendar dates are independent of timezone: building the
  // SAME all_day_date with different (or no) timezone context must
  // produce byte-identical output, since the date-only sync path never
  // reads timezone at all. ---
  {
    const { buildGoogleEventBody } = await import("../lib/calendar/calendar-event-body.ts");
    const base = { interactionId: "int-tz", donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, location: null, fosUrl: "https://x/d1" };
    const bodies = ["America/New_York", "Asia/Jerusalem", "UTC", null, "Pacific/Kiritimati"].map((timezone) => buildGoogleEventBody({ ...base, timezone }));
    for (const body of bodies) {
      assert.deepEqual(body.start, { date: "2026-03-05" });
      assert.deepEqual(body.end, { date: "2026-03-06" });
    }
    const serialized = bodies.map((b) => JSON.stringify(b));
    assert.ok(serialized.every((s) => s === serialized[0]), "an all-day event's date must be completely unaffected by the timezone value -- no timezone conversion ever applies to a date-only meeting");
  }

  // --- Guard sanity check, reused here for a disconnected/reconnect
  // narrative: while disconnected, the guard must refuse sync even if a
  // reconcile function were (incorrectly) called directly by future
  // wiring -- this is what the real route-layer integration (not done
  // this round) must check before ever invoking the reconciler. ---
  {
    const disconnected = isCalendarSyncAllowed({ environment: "production-independent", calendarSyncEnabled: false, credentialsPresent: true, verifiedEmail: "sgoldstein@nirc.edu", calendarId: "primary", stagingTestCalendarId: null });
    assert.equal(disconnected.allowed, false);
    const reconnected = isCalendarSyncAllowed({ environment: "production-independent", calendarSyncEnabled: true, credentialsPresent: true, verifiedEmail: "sgoldstein@nirc.edu", calendarId: "primary", stagingTestCalendarId: null });
    assert.equal(reconnected.allowed, true);
  }

  process.stdout.write("calendar-sync-lifecycle.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
