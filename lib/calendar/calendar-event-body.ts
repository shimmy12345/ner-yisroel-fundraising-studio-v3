// Builds a Google Calendar event body from a meeting's CURRENT desired
// fields. Pure: no I/O, no Date.now(), deterministic given its inputs --
// a reconcile attempt calls this fresh every time it actually sends a
// payload, never caching/replaying an earlier build (Issue 1's "reload
// the latest FOS desired state" requirement).
//
// All-day meetings (Issue 5): `allDayDate` ('YYYY-MM-DD') is the ONLY
// date source read here -- never `occurredAt`. This is deliberate: an
// all-day meeting's date is a calendar date, not an instant, and
// treating it as one (even "midnight in some timezone") is exactly the
// bug class already fixed once this session in Meeting Prep's occurrence
// labels. No `dateTime`/`timeZone` field is ever produced for an
// all-day event.

import { addCalendarDays } from "../workspace/local-time.ts";
import type { GoogleEventBody, MeetingDesiredFields } from "./calendar-sync-types.ts";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  if (!DATE_ONLY_PATTERN.test(value)) throw new Error(`all_day_date must be 'YYYY-MM-DD', got "${value}"`);
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function formatDateOnly(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// 2026-10-19 review, issue 2: round-trips year/month/day through
// Date.UTC and reads it back -- JS silently NORMALIZES an out-of-range
// component (month 13 rolls into next year, Feb 30 rolls into March)
// rather than rejecting it, so a naive regex-shape check alone (as
// DATE_ONLY_PATTERN is) accepts "2026-02-30" as a well-formed-looking
// but non-existent date. A mismatch after round-tripping is the proof
// the input was never a real calendar date at all.
function isRealCalendarDate(parts: { year: number; month: number; day: number }): boolean {
  const asMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  const roundTripped = new Date(asMs);
  return roundTripped.getUTCFullYear() === parts.year && roundTripped.getUTCMonth() + 1 === parts.month && roundTripped.getUTCDate() === parts.day;
}

// Google's `end` is documented as exclusive; for a single-day all-day
// event this is universally "the day after the last day" (the
// iCalendar DTEND convention Google Calendar implements). FOS only ever
// creates single-day all-day meetings, so end is always exactly
// start + 1 calendar day -- pure calendar-date string arithmetic via the
// existing, DST-immune addCalendarDays(), never epoch/timezone math.
export function exclusiveEndDateForAllDay(allDayDate: string): string {
  return formatDateOnly(addCalendarDays(parseDateOnly(allDayDate), 1));
}

// Minimal event content only, by design: title, date/time, location, and
// an authenticated link back into FOS. Deliberately never includes
// giving history, balances, internal relationship notes, or any other
// financial/internal information.
export function buildGoogleEventBody(meeting: MeetingDesiredFields): GoogleEventBody {
  const summary = `Meeting with ${meeting.donorDisplayName}`;
  const description = `Scheduled via Fundraising OS.\n${meeting.fosUrl}`;
  const body: GoogleEventBody = {
    summary,
    description,
    start: null as unknown as GoogleEventBody["start"],
    end: null as unknown as GoogleEventBody["end"],
  };
  if (meeting.location) body.location = meeting.location;

  if (meeting.allDay) {
    if (!meeting.allDayDate) throw new Error("an all-day meeting requires all_day_date -- never inferred, never defaulted");
    body.start = { date: meeting.allDayDate };
    body.end = { date: exclusiveEndDateForAllDay(meeting.allDayDate) };
    return body;
  }

  if (meeting.occurredAt === null) throw new Error("a timed meeting requires occurred_at -- a meeting missing a required date is never synced, never guessed");
  if (meeting.endAt === null) throw new Error("a timed meeting requires end_at (a confirmed duration) before it can sync -- never silently defaulted at sync time");
  if (!meeting.timezone) throw new Error("a timed meeting requires an explicit IANA timezone");
  body.start = { dateTime: new Date(meeting.occurredAt * 1000).toISOString(), timeZone: meeting.timezone };
  body.end = { dateTime: new Date(meeting.endAt * 1000).toISOString(), timeZone: meeting.timezone };
  return body;
}

// Issue 5 ("preserve unrelated Google event fields during updates"): when
// rescheduling/editing an existing event, merge only FOS-owned fields
// onto a COPY of whatever Google's own `events.get` just returned --
// every other field Google may carry (attendees, colorId, reminders,
// conferenceData, etc., none of which FOS ever sets) survives untouched.
// FOS's own fields always win on a genuine FOS-side change; nothing else
// is ever touched.
export function mergeFosFieldsIntoExistingEvent(existingEvent: GoogleEventBody, desired: MeetingDesiredFields): GoogleEventBody {
  const fosFields = buildGoogleEventBody(desired);
  return { ...existingEvent, summary: fosFields.summary, description: fosFields.description, location: fosFields.location, start: fosFields.start, end: fosFields.end };
}

export type FieldValidationResult = { valid: true } | { valid: false; reason: string };

// 2026-10-19 review, issue 2: "validate real calendar dates, finite
// timestamps, endAt > occurredAt, and valid timezone inputs before any
// remote mutation." Pure, never throws -- called by the reconciler
// BEFORE buildGoogleEventBody/any network call, so a permanently
// invalid payload is caught and recorded as a definitive, non-retried
// rejection (ReconcileOutcome "invalid") without ever reaching Google,
// rather than only being discoverable via a real Google 400 after the
// fact. buildGoogleEventBody itself is UNCHANGED (still throws on the
// same missing-field cases it always did) -- this is a strictly
// additional, earlier check, run by the reconciler, not a replacement
// for it.
export function validateMeetingDesiredFields(meeting: MeetingDesiredFields): FieldValidationResult {
  if (meeting.allDay) {
    if (!meeting.allDayDate) return { valid: false, reason: "all-day meeting is missing all_day_date" };
    if (!DATE_ONLY_PATTERN.test(meeting.allDayDate)) return { valid: false, reason: `all_day_date "${meeting.allDayDate}" is not in YYYY-MM-DD form` };
    const [year, month, day] = meeting.allDayDate.split("-").map(Number);
    if (!isRealCalendarDate({ year, month, day })) return { valid: false, reason: `all_day_date "${meeting.allDayDate}" is not a real calendar date` };
    return { valid: true };
  }

  if (meeting.occurredAt === null || !Number.isFinite(meeting.occurredAt)) return { valid: false, reason: "occurred_at is missing or not a finite timestamp" };
  if (meeting.endAt === null || !Number.isFinite(meeting.endAt)) return { valid: false, reason: "end_at is missing or not a finite timestamp" };
  if (meeting.endAt <= meeting.occurredAt) return { valid: false, reason: "end_at must be strictly after occurred_at" };
  if (!meeting.timezone) return { valid: false, reason: "a timed meeting requires an explicit IANA timezone" };
  try {
    // The standard way to validate an IANA zone identifier without a
    // hardcoded list: the Intl formatter throws RangeError for an
    // unrecognized `timeZone`, and succeeds (result discarded) for any
    // zone the runtime actually recognizes.
    new Intl.DateTimeFormat("en-US", { timeZone: meeting.timezone });
  } catch {
    return { valid: false, reason: `timezone "${meeting.timezone}" is not a recognized IANA zone` };
  }
  return { valid: true };
}
