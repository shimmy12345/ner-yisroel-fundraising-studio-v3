import assert from "node:assert/strict";
import { isPlausibleGregorianDate, maxPossibleDaysInMonth, isLeapYear, nextGregorianRecurrence, yearsSinceForOccurrence } from "../lib/calendar/gregorian-recurring-date.ts";

// NOW = 2026-08-13T12:00:00Z. 2026 is not a leap year; 2028 is.
const NOW = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
const TIMEZONE = "America/New_York";

function run() {
  // --- isPlausibleGregorianDate: basic validity, independent of any year. ---
  assert.equal(isPlausibleGregorianDate(2, 29), true, "Feb 29 is plausible in principle, even though most years don't have it");
  assert.equal(isPlausibleGregorianDate(2, 30), false, "Feb never has 30 days in any year");
  assert.equal(isPlausibleGregorianDate(4, 31), false, "April never has 31 days");
  assert.equal(isPlausibleGregorianDate(1, 31), true);
  assert.equal(isPlausibleGregorianDate(13, 1), false, "month 13 does not exist");
  assert.equal(isPlausibleGregorianDate(0, 1), false, "month 0 does not exist");
  assert.equal(maxPossibleDaysInMonth(2), 29);
  assert.equal(maxPossibleDaysInMonth(4), 30);
  assert.equal(maxPossibleDaysInMonth(1), 31);

  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(1900), false, "divisible by 100 but not 400 is not a leap year");
  assert.equal(isLeapYear(2000), true, "divisible by 400 is a leap year");

  // --- date-only semantics: no invented time component anywhere. ---
  const augOccurrence = nextGregorianRecurrence(8, 24, TIMEZONE, NOW);
  assert.equal(augOccurrence.primary.gregorianEpoch % 86400, 0, "the occurrence epoch must land exactly on a UTC-midnight day boundary");

  // --- ordinary date still in the future this year: next occurrence is this year. ---
  assert.equal(augOccurrence.primary.year, 2026);
  assert.equal(augOccurrence.primary.month, 8);
  assert.equal(augOccurrence.primary.day, 24);
  assert.equal(augOccurrence.primary.label, "Aug 24");
  assert.equal(augOccurrence.ambiguous, false);
  assert.equal(augOccurrence.ambiguityNote, null);

  // --- a date already passed this year rolls to next year (year-boundary handling). ---
  const passedOccurrence = nextGregorianRecurrence(1, 15, TIMEZONE, NOW);
  assert.equal(passedOccurrence.primary.year, 2027, "Jan 15 has already passed in 2026, so the next occurrence must be in 2027");

  // --- Feb 29 in a non-leap target year (2027): approved policy is Feb 28,
  // flagged ambiguous, with the exact explanatory note. The recorded month/
  // day passed in is never mutated -- callers still pass 29/2 next time. ---
  const feb29NonLeap = nextGregorianRecurrence(2, 29, TIMEZONE, NOW);
  assert.equal(feb29NonLeap.primary.year, 2027, "the next Feb 29 boundary search year after Aug 2026 is 2027");
  assert.equal(feb29NonLeap.primary.month, 2);
  assert.equal(feb29NonLeap.primary.day, 28, "a non-leap target year must fall back to Feb 28, never silently to Mar 1 or some other guess");
  assert.equal(feb29NonLeap.ambiguous, true, "the Feb 29 fallback must always be flagged, never presented as the exact recorded date");
  assert.equal(feb29NonLeap.ambiguityNote, "Recorded as Feb 29; 2027 isn't a leap year, so Feb 28 is shown.");

  // --- Feb 29 when the next occurrence genuinely falls in a leap year: the
  // exact recorded date is used, not flagged. ---
  const nowNearLeapFeb = Math.floor(Date.parse("2028-01-01T12:00:00Z") / 1000);
  const feb29Leap = nextGregorianRecurrence(2, 29, TIMEZONE, nowNearLeapFeb);
  assert.equal(feb29Leap.primary.year, 2028);
  assert.equal(feb29Leap.primary.day, 29, "2028 is a leap year, so the exact recorded Feb 29 must be used");
  assert.equal(feb29Leap.ambiguous, false);
  assert.equal(feb29Leap.ambiguityNote, null);

  // --- yearsSinceForOccurrence: derived purely from the occurrence's own
  // year, never from "now". A birthday whose upcoming occurrence has
  // already rolled into next year must report the age for THAT year, not
  // the current calendar year. ---
  assert.equal(yearsSinceForOccurrence(2026, 1985), 41);
  // Someone born in 1990: their next occurrence (Jan 15) is in 2027 relative
  // to NOW (Aug 2026) -- age must be computed against 2027, not 2026.
  const bornOccurrence = nextGregorianRecurrence(1, 15, TIMEZONE, NOW);
  assert.equal(yearsSinceForOccurrence(bornOccurrence.primary.year, 1990), 37, "age must be derived from the occurrence's own year (2027), not today's calendar year (2026)");

  console.log("Gregorian recurring-date checks passed.");
}

run();
