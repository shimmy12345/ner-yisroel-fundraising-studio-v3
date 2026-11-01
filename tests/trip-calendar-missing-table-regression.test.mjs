import assert from "node:assert/strict";
import { buildTripMeetingScheduledStatements, buildTripMeetingCancelledStatements } from "../lib/relationships/trip-calendar-sync.ts";

// Production user-facing regression (2026-11-01, see docs/AI-HANDOFF.md
// -- "Could not confirm the calendar sync status for this meeting" error
// on https://shimmydonors.org). Root cause: migration 0048 (Google
// Calendar sync -- creates `calendar_event_links`) was never applied to
// real Production, but the application code that reads that table is
// already live there (deployed as part of this branch's own Worker
// bundle, independent of which migrations have been applied to a given
// environment's database). Every linked-prospect meeting schedule/
// complete attempt on Production throws "no such table:
// calendar_event_links" inside D1CalendarStore.getLinkByInteraction --
// caught by lib/relationships/trips-data.ts's own try/catch around
// buildTripMeetingScheduledStatements/buildTripMeetingCancelledStatements
// and correctly converted into the actionable, retryable
// `calendar_unavailable` result BEFORE any db.batch() runs (the exact
// 2026-10-19 review fix this proves is still intact: a read failure here
// must never let a save partially commit with its calendar intent lost).
//
// Both functions under test take `db: D1Database` directly and import
// nothing from "cloudflare:workers" (confirmed: grep shows no such
// import anywhere in this file or lib/calendar/d1-calendar-store.ts),
// so this is directly testable in plain Node with a minimal stand-in
// database -- no CI-only local-D1/workerd harness needed, unlike the
// full end-to-end path tests/trip-calendar-sync-integration.test.mjs
// already covers.
//
// This test deliberately does NOT fix or paper over the missing-table
// condition -- it proves the CURRENT, CORRECT behavior (throw, don't
// swallow, don't partially save) so that whichever fix is chosen later
// (applying migration 0048 to Production, most likely) can be verified
// against this same test without weakening it.

// A minimal D1Database stand-in whose SELECT against calendar_event_links
// throws the exact real D1 error text for a genuinely missing table --
// every other table/call always succeeds, so a regression that starts
// touching some OTHER table here would surface as a different,
// unexpected throw, not a silent pass.
function missingCalendarTableDb() {
  return {
    prepare(sql) {
      if (sql.includes("calendar_event_links") || sql.includes("calendar_event_link_history")) {
        return { bind: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: calendar_event_links"); }, all: async () => { throw new Error("D1_ERROR: no such table: calendar_event_links"); }, run: async () => { throw new Error("D1_ERROR: no such table: calendar_event_links"); } }) };
      }
      throw new Error(`unexpected query against missingCalendarTableDb: ${sql}`);
    },
  };
}

function run() {
  // Scheduling a meeting for a LINKED (real donor) prospect reads
  // calendar_event_links first (decideTripMeetingScheduledIntent's own
  // existingLink lookup) -- must throw (as a rejected Promise, since
  // both functions under test are async), never silently return an
  // empty or default statement list, which would let the caller's
  // db.batch() proceed and save the meeting with its calendar intent
  // silently lost (the exact bug the 2026-10-19 review fixed).
  return (async () => {
    await assert.rejects(
      () => buildTripMeetingScheduledStatements(missingCalendarTableDb(), "interaction-1", "user-1", "primary", 1000),
      /no such table: calendar_event_links/,
      "buildTripMeetingScheduledStatements must propagate a missing-table read failure, never swallow it into an empty/default statement list",
    );

    // --- Cancelling a meeting (buildTripMeetingCancelledStatements) hits
    // the same getLinkByInteraction lookup first -- same guarantee. ---
    await assert.rejects(
      () => buildTripMeetingCancelledStatements(missingCalendarTableDb(), "interaction-1", 1000),
      /no such table: calendar_event_links/,
      "buildTripMeetingCancelledStatements must propagate a missing-table read failure, never swallow it",
    );

    console.log("trip-calendar-missing-table-regression: all assertions passed");
  })();
}

await run();
