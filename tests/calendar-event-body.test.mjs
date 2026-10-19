import assert from "node:assert/strict";
import { buildGoogleEventBody, exclusiveEndDateForAllDay, mergeFosFieldsIntoExistingEvent, validateMeetingDesiredFields } from "../lib/calendar/calendar-event-body.ts";

const baseFields = { interactionId: "int-1", donorDisplayName: "Rabbi & Mrs. Dovid Bashevkin", fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief" };

// --- All-day meetings: date-only, never an instant, never a timeZone field ---
{
  const body = buildGoogleEventBody({ ...baseFields, allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null });
  assert.deepEqual(body.start, { date: "2026-03-05" });
  assert.deepEqual(body.end, { date: "2026-03-06" }, "end.date must be exclusive -- the day AFTER the last day");
  assert.ok(!("dateTime" in body.start) && !("timeZone" in body.start), "all-day events must never carry dateTime/timeZone");
  assert.ok(!("dateTime" in body.end) && !("timeZone" in body.end));
}

// Exclusive end-date arithmetic across a month/year boundary -- pure
// calendar-date string math, never epoch/DST involvement.
assert.equal(exclusiveEndDateForAllDay("2026-01-31"), "2026-02-01");
assert.equal(exclusiveEndDateForAllDay("2026-12-31"), "2027-01-01");

// An all-day meeting with no all_day_date is never silently inferred --
// it throws, matching "do not invent missing scheduling details."
assert.throws(() => buildGoogleEventBody({ ...baseFields, allDay: true, allDayDate: null, occurredAt: null, endAt: null, timezone: null, location: null }));

// --- Timed meetings: real instants, explicit IANA timezone ---
{
  const occurredAt = Math.floor(Date.parse("2026-03-05T14:00:00Z") / 1000);
  const endAt = Math.floor(Date.parse("2026-03-05T14:30:00Z") / 1000);
  const body = buildGoogleEventBody({ ...baseFields, allDay: false, allDayDate: null, occurredAt, endAt, timezone: "America/New_York", location: "123 Main St" });
  assert.equal(body.start.dateTime, new Date(occurredAt * 1000).toISOString());
  assert.equal(body.start.timeZone, "America/New_York");
  assert.equal(body.end.dateTime, new Date(endAt * 1000).toISOString());
  assert.equal(body.location, "123 Main St");
}

// A timed meeting missing a date, end time, or timezone is never synced
// with a guessed value -- it throws, held back from sync instead.
const now = Math.floor(Date.now() / 1000);
assert.throws(() => buildGoogleEventBody({ ...baseFields, allDay: false, allDayDate: null, occurredAt: null, endAt: now, timezone: "America/New_York", location: null }));
assert.throws(() => buildGoogleEventBody({ ...baseFields, allDay: false, allDayDate: null, occurredAt: now, endAt: null, timezone: "America/New_York", location: null }));
assert.throws(() => buildGoogleEventBody({ ...baseFields, allDay: false, allDayDate: null, occurredAt: now, endAt: now + 1800, timezone: null, location: null }));

// --- Minimal content only: no giving history, balances, notes, or any financial information ---
{
  const body = buildGoogleEventBody({ ...baseFields, allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null });
  const serialized = JSON.stringify(body).toLowerCase();
  for (const forbidden of ["pledge", "balance", "gift", "$", "paid_cents", "giving"]) {
    assert.ok(!serialized.includes(forbidden), `event body must never include "${forbidden}"`);
  }
  assert.match(body.description, /shimmydonors\.org/, "must include an authenticated link back into FOS");
}

// --- Preserving unrelated Google event fields on update (Issue 5) ---
{
  const existing = { id: "evt-1", summary: "old title", description: "old desc", start: { date: "2026-01-01" }, end: { date: "2026-01-02" }, colorId: "7", attendees: [{ email: "someone@example.com" }], reminders: { useDefault: true } };
  const desired = { ...baseFields, allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: "New location" };
  const merged = mergeFosFieldsIntoExistingEvent(existing, desired);
  assert.equal(merged.colorId, "7", "an unrelated field Google carries (never set by FOS) must survive an update untouched");
  assert.deepEqual(merged.attendees, [{ email: "someone@example.com" }], "attendees FOS never manages must be preserved");
  assert.deepEqual(merged.reminders, { useDefault: true });
  assert.deepEqual(merged.start, { date: "2026-03-05" }, "FOS's own fields must win");
  assert.equal(merged.location, "New location");
  assert.equal(merged.id, "evt-1", "the event's own id is untouched");
}

// =============================================================================
// validateMeetingDesiredFields (2026-10-19 review, issue 2): "validate
// real calendar dates, finite timestamps, endAt > occurredAt, and valid
// timezone inputs before any remote mutation." Independent review found
// buildGoogleEventBody alone never catches an end-before-start timed
// meeting (it only throws on MISSING fields, never on an invalid
// RELATIONSHIP between present ones) -- these cases are the pre-fix
// reproduction: all pass buildGoogleEventBody's own checks silently.
// =============================================================================
{
  const occurredAt = Math.floor(Date.parse("2026-03-05T14:00:00Z") / 1000);

  // Valid cases must pass.
  assert.deepEqual(validateMeetingDesiredFields({ ...baseFields, allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null }), { valid: true });
  assert.deepEqual(validateMeetingDesiredFields({ ...baseFields, allDay: false, allDayDate: null, occurredAt, endAt: occurredAt + 1800, timezone: "America/New_York", location: null }), { valid: true });

  // endAt <= occurredAt -- buildGoogleEventBody alone does NOT catch
  // this (confirmed below); validateMeetingDesiredFields must.
  const endBeforeStart = { ...baseFields, allDay: false, allDayDate: null, occurredAt, endAt: occurredAt - 60, timezone: "America/New_York", location: null };
  assert.doesNotThrow(() => buildGoogleEventBody(endBeforeStart), "pre-fix reproduction: buildGoogleEventBody alone never validates endAt > occurredAt");
  assert.equal(validateMeetingDesiredFields(endBeforeStart).valid, false, "endAt <= occurredAt must be rejected");
  const endEqualsStart = { ...endBeforeStart, endAt: occurredAt };
  assert.equal(validateMeetingDesiredFields(endEqualsStart).valid, false, "endAt == occurredAt (zero duration) must also be rejected");

  // Non-finite timestamps.
  assert.equal(validateMeetingDesiredFields({ ...baseFields, allDay: false, allDayDate: null, occurredAt: NaN, endAt: occurredAt + 1800, timezone: "America/New_York", location: null }).valid, false);
  assert.equal(validateMeetingDesiredFields({ ...baseFields, allDay: false, allDayDate: null, occurredAt, endAt: Infinity, timezone: "America/New_York", location: null }).valid, false);

  // An invalid IANA timezone -- buildGoogleEventBody itself never
  // validates the STRING is a real zone (only that it's non-empty), so
  // this is also a real pre-fix gap.
  const badTimezone = { ...baseFields, allDay: false, allDayDate: null, occurredAt, endAt: occurredAt + 1800, timezone: "Not/A_Real_Zone", location: null };
  assert.doesNotThrow(() => buildGoogleEventBody(badTimezone), "pre-fix reproduction: buildGoogleEventBody never validates the timezone string is a real IANA zone");
  assert.equal(validateMeetingDesiredFields(badTimezone).valid, false, "an unrecognized IANA timezone must be rejected");

  // A real calendar date must round-trip; Feb 30 does not exist --
  // buildGoogleEventBody's DATE_ONLY_PATTERN regex accepts it (it only
  // checks shape, not calendar validity), another real pre-fix gap.
  const feb30 = { ...baseFields, allDay: true, allDayDate: "2026-02-30", occurredAt: null, endAt: null, timezone: null, location: null };
  assert.doesNotThrow(() => buildGoogleEventBody(feb30), "pre-fix reproduction: buildGoogleEventBody's regex-only date check accepts a non-existent calendar date");
  assert.equal(validateMeetingDesiredFields(feb30).valid, false, "a non-existent calendar date (Feb 30) must be rejected");
  // A real date must still be accepted, including a real leap day.
  assert.equal(validateMeetingDesiredFields({ ...baseFields, allDay: true, allDayDate: "2028-02-29", occurredAt: null, endAt: null, timezone: null, location: null }).valid, true);
  assert.equal(validateMeetingDesiredFields({ ...baseFields, allDay: true, allDayDate: "2026-02-29", occurredAt: null, endAt: null, timezone: null, location: null }).valid, false, "2026 is not a leap year");
}

process.stdout.write("calendar-event-body.test.mjs: all assertions passed\n");
