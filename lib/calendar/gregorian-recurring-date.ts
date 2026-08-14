// Pure Gregorian recurring-date arithmetic for Birthday/Anniversary. Unlike
// lib/calendar/hebrew-date.ts, Gregorian month lengths are fixed year to
// year with exactly one exception -- Feb 29 -- so this module never needs a
// multi-year search or a library: plain calendar math is exact.
//
// Feb 29 policy (approved product decision, not an implementation default):
// in a non-leap target year, the displayed/actionable occurrence is Feb 28.
// The recorded (month, day) is NEVER mutated to 28/2 anywhere -- callers
// always keep storing 29/2 -- this module only computes what to *show* for
// a given year, exactly the same "stored fact stays canonical, displayed
// occurrence is recalculated and may be a flagged nearest-date fallback"
// shape as lib/calendar/hebrew-date.ts's 30-Cheshvan/Kislev handling. The
// result is always marked `ambiguous: true` with a human-readable note so
// no caller can mistake the fallback for the exact recorded date.

import { localDateParts } from "../workspace/local-time.ts";

const DAYS_IN_MONTH_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// The widest a day value could ever be for this month in ANY year (Feb's
// max is 29, even though most years only have 28) -- used to validate a
// manual entry independent of which year it will next recur in.
export function maxPossibleDaysInMonth(month: number): number {
  return DAYS_IN_MONTH_MAX[month - 1] ?? 0;
}

export function isPlausibleGregorianDate(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= maxPossibleDaysInMonth(month);
}

export type GregorianDateCandidate = {
  year: number;
  month: number;
  day: number;
  /** Date-only epoch seconds, UTC midnight -- same convention as lib/calendar/hebrew-date.ts. */
  gregorianEpoch: number;
  label: string;
};

export type GregorianRecurrence = {
  primary: GregorianDateCandidate;
  ambiguous: boolean;
  ambiguityNote: string | null;
};

function toDateOnlyEpoch(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Finds the next occurrence of (month, day) on or after "now" in the given
// timezone. Only ever needs to check the current and following calendar
// year -- a Gregorian recurrence never skips a year the way a Hebrew one
// occasionally can.
export function nextGregorianRecurrence(month: number, day: number, timezone: string, nowEpochSeconds: number): GregorianRecurrence {
  const today = localDateParts(nowEpochSeconds, timezone);
  const todayEpoch = toDateOnlyEpoch(today.year, today.month, today.day);
  const isFeb29 = month === 2 && day === 29;

  for (let year = today.year; year <= today.year + 1; year++) {
    const leapOk = !isFeb29 || isLeapYear(year);
    const resolvedDay = leapOk ? day : 28;
    const gregorianEpoch = toDateOnlyEpoch(year, month, resolvedDay);
    if (gregorianEpoch < todayEpoch) continue;
    return {
      primary: { year, month, day: resolvedDay, gregorianEpoch, label: `${MONTH_LABELS[month - 1]} ${resolvedDay}` },
      ambiguous: !leapOk,
      ambiguityNote: leapOk ? null : `Recorded as Feb 29; ${year} isn't a leap year, so Feb 28 is shown.`,
    };
  }

  // Unreachable for any (month, day) accepted by isPlausibleGregorianDate --
  // every Gregorian date recurs within at most one year. Fail loudly rather
  // than returning a fabricated date.
  throw new Error(`Could not find an upcoming occurrence for ${month}/${day} within 1 year of the search start`);
}

// Derives a display-only count (age in years, years married, etc.) from the
// Gregorian year the UPCOMING occurrence actually falls in -- never from
// today's calendar year directly, so "turning 45" always matches the
// specific occurrence being displayed rather than silently drifting once
// the occurrence rolls into next year (e.g. a December "now" whose next
// occurrence is already in January of next year). Never stored -- callers
// recompute this on every read, same as the occurrence itself.
export function yearsSinceForOccurrence(occurrenceYear: number, referenceYear: number): number {
  return occurrenceYear - referenceYear;
}
