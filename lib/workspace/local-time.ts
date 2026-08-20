// Time-of-day helpers for the user's own wall-clock experience of the app
// (greetings, "today" boundaries for daily UI state) -- never the browser's
// or the Cloudflare Worker's own timezone, and never the financial-date
// rules in lib/financial-date.ts, which govern stored transaction dates,
// not "what time is it right now for this user". Every function here takes
// an explicit IANA timezone (the caller's stored profile.timezone) so the
// result is identical regardless of where the code executes -- server or
// browser, in any timezone.

export type TimeOfDayGreeting = "Good morning" | "Good afternoon" | "Good evening";

// Hour of day (0-23) in the given timezone, for an absolute Unix timestamp
// (seconds).
export function localHour(epochSeconds: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(epochSeconds * 1000)));
}

// Calendar day key (YYYY-MM-DD) in the given timezone -- for anything that
// needs to know "is this still the same local day" (e.g. the Morning
// Brief's once-per-day completion state).
export function localDayKey(epochSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

// Good morning: 5:00 AM - 11:59 AM. Good afternoon: 12:00 PM - 4:59 PM.
// Good evening: 5:00 PM - 4:59 AM.
export function timeOfDayGreeting(epochSeconds: number, timezone: string): TimeOfDayGreeting {
  const hour = localHour(epochSeconds, timezone);
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

// Calendar date (year, 1-indexed month, day) in the given timezone, for an
// absolute Unix timestamp (seconds) -- the numeric form of localDayKey,
// for callers that need to do calendar arithmetic on it.
export function localDateParts(epochSeconds: number, timezone: string): { year: number; month: number; day: number } {
  const [year, month, day] = localDayKey(epochSeconds, timezone).split("-").map(Number);
  return { year, month, day };
}

// "Today," expressed as the same date-only, UTC-midnight epoch convention
// lib/calendar/hebrew-date.ts and lib/calendar/gregorian-recurring-date.ts
// use for a recurrence's own gregorianEpoch (both independently compute
// exactly this: Date.UTC(...) of localDateParts(now, timezone)). Callers
// comparing an event's dateEpoch against "is this today" must use this,
// not localDayKey(dateEpoch, timezone)/dayKey(dateEpoch, timezone) --
// those are for MOMENT-IN-TIME epochs (an interaction's occurred_at, a
// reminder's due_at) and would re-apply the timezone offset a second time
// to a value that is already "UTC midnight of the intended local date,"
// silently shifting it a day off in any non-UTC timezone.
export function localDateOnlyEpoch(epochSeconds: number, timezone: string): number {
  const { year, month, day } = localDateParts(epochSeconds, timezone);
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

// Adds (or subtracts) whole calendar days to a Y-M-D date, handling
// month/year rollover. Pure calendar arithmetic -- deliberately anchored
// to UTC internally so it is never affected by DST (a calendar day is a
// calendar day regardless of timezone; only the later local-wall-clock ->
// UTC conversion needs to know about DST).
export function addCalendarDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const anchor = new Date(Date.UTC(date.year, date.month - 1, date.day));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

// The timezone's UTC offset, in minutes to ADD to a UTC instant to get its
// local wall-clock reading (e.g. America/New_York in EDT returns -240;
// in EST, -300).
function timezoneOffsetMinutes(epochMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Reinterpreting the local wall-clock reading as if it were itself UTC
  // gives an instant whose difference from the true UTC instant is
  // exactly the timezone's offset at that moment.
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return (asUtc - epochMs) / 60000;
}

// Converts a local wall-clock date/time (year, 1-indexed month, day, hour,
// minute) in the given IANA timezone into the absolute UTC instant it
// represents. DST-safe: a naive guess (treating the wall-clock fields as
// if they were UTC) is corrected by the timezone's actual offset, then
// re-checked once more in case that correction crossed a DST transition
// (e.g. a "tomorrow at 9am" reminder created the day before, or on the day
// of, a spring-forward/fall-back change still lands on exactly 9:00 AM
// local wall-clock time on the target day).
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = timezoneOffsetMinutes(naiveUtcMs, timezone);
  const correctedMs = naiveUtcMs - offset * 60000;
  const offsetAtCorrected = timezoneOffsetMinutes(correctedMs, timezone);
  const finalMs = offsetAtCorrected === offset ? correctedMs : naiveUtcMs - offsetAtCorrected * 60000;
  return new Date(finalMs);
}
