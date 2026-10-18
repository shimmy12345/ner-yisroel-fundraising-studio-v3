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
