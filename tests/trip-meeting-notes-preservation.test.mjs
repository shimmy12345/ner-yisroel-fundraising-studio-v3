// AI Meeting Notes preservation through meeting completion/rescheduling
// (2026-10-21, see docs/AI-HANDOFF.md). Calls the REAL, unmodified
// `scheduleProspectMeeting`/`completeProspectMeeting` exported from
// lib/relationships/trips-data.ts -- same "real schema, real migrations,
// intercept cloudflare:workers" rigor as tests/trip-reconciliation-
// concurrency.test.mjs, never a hand-copied reproduction of their SQL.
//
// completeProspectMeeting makes no calendar call at all (its own doc
// comment: "Completion retains calendar history" -- a deliberate no-op),
// and scheduleProspectMeeting's own best-effort calendar reconcile step
// is gated behind this test user's calendar_sync_enabled flag, which is
// never set here -- so neither function attempts any live network call,
// and both are safe to exercise directly against the in-memory adapter.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);
// scheduleProspectMeeting/completeProspectMeeting's best-effort calendar
// helper reads this bare global (see trips-data.ts's own
// attemptBestEffortCalendarReconcile) -- set once, exactly as
// tests/trip-entrypoints-atomicity.test.mjs already does for the same
// reason.
globalThis.__FUNDRAISING_OS_ENVIRONMENT__ = "production-independent";

const { env } = await import("./helpers/cloudflare-workers-shim.mjs");
const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const {
  scheduleProspectMeeting,
  completeProspectMeeting,
  getProspectMeetingNotesTarget,
} = await import("../lib/relationships/trips-data.ts");
const { tripMeetingInteractionId } = await import("../lib/relationships/trip-model.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const PAST_MEETING_AT = "2026-10-20T09:00"; // comfortably before NOW, satisfying validateMeetingCompletion's own "not in the future" rule
const USER_ID = "u1";
const DONOR_ID = "d1";

function freshDb() {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, timezone, created_at, updated_at) VALUES (?, ?, 'America/Chicago', ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, state, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', 'IL', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  return db;
}

function seedTripProspect(db, { tripId, prospectId }) {
  db.prepare("INSERT INTO trips (id, owner_user_id, name, start_date, end_date, created_at, updated_at) VALUES (?, ?, 'Test Trip', ?, ?, ?, ?)").bind(tripId, USER_ID, NOW, NOW + 7 * 86400, NOW, NOW).run();
  db.prepare("INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, created_at, updated_at) VALUES (?, ?, ?, 'manual', 'not_contacted', ?, ?)").bind(prospectId, tripId, DONOR_ID, NOW, NOW).run();
}

// Simulates what either meeting-notes save route actually does (app/api/
// meeting-notes/route.ts and app/api/trips/.../meeting-notes/route.ts) --
// a plain UPDATE touching only `summary` -- without depending on their
// own HTTP handlers.
function saveAiNotes(db, interactionId, summary) {
  db.raw().prepare("UPDATE interactions SET summary = ? WHERE id = ?").run(summary, interactionId);
}

function interactionSummary(db, interactionId) {
  return db.raw().prepare("SELECT summary FROM interactions WHERE id = ?").get(interactionId)?.summary ?? null;
}

async function run() {
  // --- Rescheduling a meeting with saved AI notes must never revert the
  // summary back to the generic scheduling placeholder. ---
  {
    const db = freshDb();
    env.DB = db;
    const tripId = "trip-reschedule";
    const prospectId = "prospect-reschedule";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);

    const first = await scheduleProspectMeeting(USER_ID, tripId, prospectId, "2026-11-01T14:00", "Office", 30, true, "America/Chicago", NOW);
    assert.ok(first.ok, "first scheduling must succeed");
    assert.equal(interactionSummary(db, interactionId), "Trip meeting scheduled with Jane Donor.", "the initial placeholder is written in full on first schedule");

    const aiNotes = "AI-organized: discussed capital campaign, donor leaning toward a $25k pledge.";
    saveAiNotes(db, interactionId, aiNotes);
    assert.equal(interactionSummary(db, interactionId), aiNotes);

    const rescheduled = await scheduleProspectMeeting(USER_ID, tripId, prospectId, "2026-11-05T10:00", "Office", 45, true, "America/Chicago", NOW);
    assert.ok(rescheduled.ok, "rescheduling must succeed");
    assert.equal(interactionSummary(db, interactionId), aiNotes, "rescheduling must never overwrite real saved notes back to the scheduling placeholder");

    const target = await getProspectMeetingNotesTarget(USER_ID, tripId, prospectId);
    assert.ok(target.ok);
    assert.equal(target.existingSummary, aiNotes, "the donor-profile-facing read must see the exact same preserved notes");
  }

  // --- Completing a meeting that was scheduled but never had notes saved
  // writes the full completion summary, exactly as before this fix. ---
  {
    const db = freshDb();
    env.DB = db;
    const tripId = "trip-fresh-complete";
    const prospectId = "prospect-fresh-complete";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);

    await scheduleProspectMeeting(USER_ID, tripId, prospectId, "2026-10-25T14:00", null, 30, true, "America/Chicago", NOW);
    const result = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Met in person, pledged $5,000.", true, "America/Chicago", NOW);
    assert.ok(result.ok);
    assert.equal(interactionSummary(db, interactionId), "Trip meeting with Jane Donor.\nMet in person, pledged $5,000.", "a meeting with no prior real notes still gets the full completion summary written");
  }

  // --- Completing a meeting that already carries real AI-organized notes
  // must APPEND the completion note, never replace the saved notes. ---
  {
    const db = freshDb();
    env.DB = db;
    const tripId = "trip-preserve-complete";
    const prospectId = "prospect-preserve-complete";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);

    await scheduleProspectMeeting(USER_ID, tripId, prospectId, "2026-10-25T14:00", null, 30, true, "America/Chicago", NOW);
    const aiNotes = "AI-organized: donor confirmed matching gift eligibility, follow up with HR form.";
    saveAiNotes(db, interactionId, aiNotes);

    const completionNotes = "Met in person -- donor pledged $10,000, payable over 2 years.";
    const result = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, completionNotes, true, "America/Chicago", NOW);
    assert.ok(result.ok);
    const summary = interactionSummary(db, interactionId);
    assert.ok(summary.includes(aiNotes), "the earlier AI-organized notes must still be present after completion");
    assert.ok(summary.includes(completionNotes), "the completion note must also be present");
    assert.notEqual(summary, aiNotes, "something must have actually changed (the completion note was appended)");

    // Reopening from the donor profile (or the trip) must see BOTH.
    const target = await getProspectMeetingNotesTarget(USER_ID, tripId, prospectId);
    assert.ok(target.ok);
    assert.equal(target.existingSummary, summary);
  }

  // --- A retried completion (identical notes text, e.g. a dropped
  // response followed by a client retry) must never duplicate the
  // appended block. ---
  {
    const db = freshDb();
    env.DB = db;
    const tripId = "trip-retry-complete";
    const prospectId = "prospect-retry-complete";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);

    await scheduleProspectMeeting(USER_ID, tripId, prospectId, "2026-10-25T14:00", null, 30, true, "America/Chicago", NOW);
    saveAiNotes(db, interactionId, "AI-organized: initial context.");

    const completionNotes = "Donor agreed to a site visit next quarter.";
    const first = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, completionNotes, true, "America/Chicago", NOW);
    assert.ok(first.ok);
    const afterFirst = interactionSummary(db, interactionId);

    const retry = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, completionNotes, true, "America/Chicago", NOW + 60);
    assert.ok(retry.ok);
    const afterRetry = interactionSummary(db, interactionId);
    assert.equal(afterRetry, afterFirst, "an identical retry must be a no-op on the summary, never a second appended block");
    assert.equal(afterRetry.split(completionNotes).length - 1, 1, "the completion note text must appear exactly once");
  }

  // --- Two separate meetings for the SAME donor (two different trip
  // prospect rows) must keep fully independent notes -- confirming the
  // fix did not accidentally couple them through the donor id. ---
  {
    const db = freshDb();
    env.DB = db;
    const tripA = "trip-a";
    const prospectA = "prospect-a";
    const tripB = "trip-b";
    const prospectB = "prospect-b";
    seedTripProspect(db, { tripId: tripA, prospectId: prospectA });
    seedTripProspect(db, { tripId: tripB, prospectId: prospectB });
    const interactionA = tripMeetingInteractionId(prospectA);
    const interactionB = tripMeetingInteractionId(prospectB);
    assert.notEqual(interactionA, interactionB);

    await scheduleProspectMeeting(USER_ID, tripA, prospectA, "2026-10-25T14:00", null, 30, true, "America/Chicago", NOW);
    await scheduleProspectMeeting(USER_ID, tripB, prospectB, "2026-10-22T14:00", null, 30, true, "America/Chicago", NOW);
    saveAiNotes(db, interactionA, "Notes for trip A's meeting.");
    saveAiNotes(db, interactionB, "Notes for trip B's meeting.");

    await completeProspectMeeting(USER_ID, tripA, prospectA, PAST_MEETING_AT, "Completed trip A.", true, "America/Chicago", NOW);

    assert.ok(interactionSummary(db, interactionA).includes("Completed trip A."));
    assert.equal(interactionSummary(db, interactionB), "Notes for trip B's meeting.", "completing trip A's meeting must never touch trip B's independent notes for the same donor");
  }

  console.log("trip-meeting-notes-preservation.test.mjs: all assertions passed");
}

await run();
