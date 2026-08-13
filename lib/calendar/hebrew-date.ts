// Pure Hebrew<->Gregorian calendar arithmetic for yahrtzeit recurrence.
// Wraps jewish-date (MIT-licensed, ~2kb, Rata Die conversion, 100% test
// coverage upstream) rather than hand-rolling leap-year/month-length math.
//
// This module deliberately does NOT resolve every recurrence to a single
// "correct" date. Two source-date shapes are genuinely halachically
// disputed, not just arithmetic:
//   - a death recorded as plain "Adar" (i.e. not distinguished as Adar I/II)
//     recurring in a future LEAP year, which has both Adar I and Adar II;
//   - a death on the 30th of Cheshvan or Kislev -- months whose length
//     (29 or 30 days) varies year to year -- recurring in a year where that
//     month is "deficient" (29 days) and the 30th doesn't exist.
// For both, this module computes and returns every plausible candidate date
// using only verified calendar arithmetic (leap-year status, month length),
// and marks the result `ambiguous: true` with a human-readable note. It
// never silently picks one candidate as "the" answer -- that's a religious
// judgment call for the fundraiser/rabbi, not a computation.

import { isLeapYear, calcDaysInMonth, toGregorianDate, toJewishDate } from "jewish-date";
import type { JewishMonthType } from "jewish-date";
import { localDateParts } from "../workspace/local-time.ts";

// Canonical month keys stored in the database -- deliberately our own
// spelling (matching common Ashkenazi transliteration and the real
// Yahrtzeit.xlsx workbook's own HebMonth values) rather than coupling the
// schema to jewish-date's exact enum strings, which are a third-party
// implementation detail.
export const HEBREW_MONTHS = [
  "Tishrei", "Cheshvan", "Kislev", "Teves", "Shevat",
  "Adar", "AdarI", "AdarII",
  "Nisan", "Iyar", "Sivan", "Tammuz", "Av", "Elul",
] as const;
export type HebrewMonthName = (typeof HEBREW_MONTHS)[number];

export function isHebrewMonthName(value: string): value is HebrewMonthName {
  return (HEBREW_MONTHS as readonly string[]).includes(value);
}

// Hebrew-script month name -> canonical key, for reading a workbook's own
// HebMonth column (which is written in Hebrew, not transliterated). Plain
// "אדר" always maps to the generic "Adar" -- a leap-year-specific Adar I/II
// source distinction isn't expressible in a single Hebrew word and isn't
// present in any real workbook column, so it's out of scope for import (a
// manual entry can still record AdarI/AdarII explicitly if known).
const HEBREW_SCRIPT_TO_MONTH: Record<string, HebrewMonthName> = {
  "תשרי": "Tishrei", "חשון": "Cheshvan", "חשוון": "Cheshvan", "כסלו": "Kislev",
  "טבת": "Teves", "שבט": "Shevat", "אדר": "Adar", "אדר א": "AdarI", "אדר ב": "AdarII",
  "ניסן": "Nisan", "אייר": "Iyar", "סיון": "Sivan", "סיוון": "Sivan",
  "תמוז": "Tammuz", "אב": "Av", "אלול": "Elul",
};

export function hebrewScriptToMonthName(value: string): HebrewMonthName | null {
  return HEBREW_SCRIPT_TO_MONTH[value.trim()] ?? null;
}

const TO_LIBRARY_MONTH: Record<HebrewMonthName, JewishMonthType> = {
  Tishrei: "Tishri", Cheshvan: "Cheshvan", Kislev: "Kislev", Teves: "Tevet", Shevat: "Shevat",
  Adar: "Adar", AdarI: "AdarI", AdarII: "AdarII",
  Nisan: "Nisan", Iyar: "Iyyar", Sivan: "Sivan", Tammuz: "Tammuz", Av: "Av", Elul: "Elul",
};

// Months whose length is fixed across every Hebrew year -- 30 days.
const ALWAYS_30 = new Set<HebrewMonthName>(["Tishrei", "Shevat", "Nisan", "Sivan", "Av", "AdarI"]);
// Months whose length is fixed across every Hebrew year -- 29 days.
const ALWAYS_29 = new Set<HebrewMonthName>(["Teves", "Iyar", "Tammuz", "Elul", "AdarII"]);
// Months whose length varies (29 "deficient" or 30 "full") depending on the
// year -- the source of the 30 Cheshvan / 30 Kislev ambiguity.
const VARIABLE_LENGTH = new Set<HebrewMonthName>(["Cheshvan", "Kislev"]);

// The widest a day value could ever be for this month in ANY year --
// used to validate a manual entry before a Hebrew year is known/entered.
export function maxPossibleDaysInMonth(month: HebrewMonthName): number {
  if (ALWAYS_30.has(month)) return 30;
  if (ALWAYS_29.has(month)) return 29;
  if (VARIABLE_LENGTH.has(month)) return 30;
  if (month === "Adar") return 29; // plain "Adar" only exists in non-leap years, which are always 29 days
  return 30;
}

// Whether (month, day) is even a coherent Hebrew date in principle, ignoring
// any specific year. Rejects e.g. "30 Teves" (Teves never has 30 days)
// outright -- that's not ambiguous, it's invalid.
export function isPlausibleHebrewDate(month: string, day: number): boolean {
  if (!isHebrewMonthName(month)) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= maxPossibleDaysInMonth(month);
}

type MonthResolution = { resolvedMonth: HebrewMonthName; ambiguous: boolean };

// Resolves a source month into the specific month(s) that actually exist in
// a given Hebrew year. A plain "Adar" record has two possible landings in a
// leap year (Adar I or Adar II); an "AdarI"/"AdarII" record has one possible
// landing in a non-leap year (the single "Adar"), but collapsing a
// deliberately-recorded Adar I/II distinction into a single Adar is itself
// a judgment call, so it's flagged too, not treated as obviously correct.
function resolveMonthsForYear(month: HebrewMonthName, hebrewYear: number): MonthResolution[] {
  const leap = isLeapYear(hebrewYear);
  if (month === "Adar") {
    return leap
      ? [{ resolvedMonth: "AdarI", ambiguous: true }, { resolvedMonth: "AdarII", ambiguous: true }]
      : [{ resolvedMonth: "Adar", ambiguous: false }];
  }
  if (month === "AdarI" || month === "AdarII") {
    if (leap) return [{ resolvedMonth: month, ambiguous: false }];
    return [{ resolvedMonth: "Adar", ambiguous: true }];
  }
  return [{ resolvedMonth: month, ambiguous: false }];
}

export type HebrewDateCandidate = {
  hebrewYear: number;
  resolvedMonth: HebrewMonthName;
  /** Date-only epoch seconds, UTC midnight -- same convention as lib/financial-date.ts. */
  gregorianEpoch: number;
  hebrewLabel: string;
};

export type YahrtzeitOccurrence = {
  primary: HebrewDateCandidate;
  /** A second plausible candidate for the same recurrence, when ambiguous. */
  alternate: HebrewDateCandidate | null;
  ambiguous: boolean;
  ambiguityNote: string | null;
};

function toDateOnlyEpoch(gregorianDate: Date): number {
  return Math.floor(Date.UTC(gregorianDate.getFullYear(), gregorianDate.getMonth(), gregorianDate.getDate()) / 1000);
}

// Builds every plausible candidate date for (month, day) landing in a
// specific Hebrew year. Returns an empty array when the day genuinely
// doesn't exist that year for every resolution (e.g. 30 Cheshvan in a
// deficient year) -- callers fall back to the nearest existing day.
function candidatesForYear(month: HebrewMonthName, day: number, hebrewYear: number): HebrewDateCandidate[] {
  const resolutions = resolveMonthsForYear(month, hebrewYear);
  const candidates: HebrewDateCandidate[] = [];
  for (const { resolvedMonth } of resolutions) {
    const daysInMonth = calcDaysInMonth(hebrewYear, TO_LIBRARY_MONTH[resolvedMonth]);
    if (day > daysInMonth) continue;
    const gregorian = toGregorianDate({ year: hebrewYear, monthName: TO_LIBRARY_MONTH[resolvedMonth], day });
    candidates.push({
      hebrewYear,
      resolvedMonth,
      gregorianEpoch: toDateOnlyEpoch(gregorian),
      hebrewLabel: `${day} ${resolvedMonth}`,
    });
  }
  return candidates;
}

// The nearest earlier existing day in the same month/year, for the rare
// case where a variable-length month falls short of the recorded day in a
// given year (30 Cheshvan/Kislev in a deficient year). This is ONE
// reasonable candidate to display, clearly flagged -- never presented as
// the resolved answer.
function fallbackCandidateForYear(month: HebrewMonthName, hebrewYear: number): HebrewDateCandidate {
  const daysInMonth = calcDaysInMonth(hebrewYear, TO_LIBRARY_MONTH[month]);
  const gregorian = toGregorianDate({ year: hebrewYear, monthName: TO_LIBRARY_MONTH[month], day: daysInMonth });
  return { hebrewYear, resolvedMonth: month, gregorianEpoch: toDateOnlyEpoch(gregorian), hebrewLabel: `${daysInMonth} ${month}` };
}

const AMBIGUITY_NOTES: Record<string, string> = {
  adar_leap: "Recorded as plain Adar; the upcoming occurrence falls in a leap year with two Adars (Adar I and Adar II). Confirm which one applies before relying on this date.",
  adar_specific_common: "Recorded as Adar I or Adar II; the upcoming occurrence falls in a year with only one Adar. Confirm the date before relying on it.",
  day_30_variable: "Recorded as the 30th of a month that doesn't have 30 days in the upcoming occurrence's year. Showing the nearest earlier date -- confirm before relying on it.",
};

// Finds the next occurrence of (month, day) on or after "now" in the given
// timezone. Starts from the current Hebrew year and searches forward.
export function nextYahrtzeitOccurrence(month: HebrewMonthName, day: number, timezone: string, nowEpochSeconds: number): YahrtzeitOccurrence {
  const today = localDateParts(nowEpochSeconds, timezone);
  const todayEpoch = Math.floor(Date.UTC(today.year, today.month - 1, today.day) / 1000);
  const todayHebrewYear = toJewishDate(new Date(Date.UTC(today.year, today.month - 1, today.day, 12))).year;

  for (let hebrewYear = todayHebrewYear; hebrewYear <= todayHebrewYear + 2; hebrewYear++) {
    let candidates = candidatesForYear(month, day, hebrewYear);
    let ambiguityKey: string | null = null;

    if (candidates.length === 0 && VARIABLE_LENGTH.has(month) && day === 30) {
      candidates = [fallbackCandidateForYear(month, hebrewYear)];
      ambiguityKey = "day_30_variable";
    } else if (candidates.length > 1) {
      ambiguityKey = "adar_leap";
    } else if (candidates.length === 1 && candidates[0].resolvedMonth !== month && (month === "AdarI" || month === "AdarII")) {
      ambiguityKey = "adar_specific_common";
    }

    const futureCandidates = candidates.filter((candidate) => candidate.gregorianEpoch >= todayEpoch);
    if (futureCandidates.length === 0) continue;

    futureCandidates.sort((a, b) => a.gregorianEpoch - b.gregorianEpoch);
    const [primary, alternate = null] = futureCandidates;
    return {
      primary,
      alternate,
      ambiguous: ambiguityKey !== null,
      ambiguityNote: ambiguityKey ? AMBIGUITY_NOTES[ambiguityKey] : null,
    };
  }

  // Should be unreachable for any plausible (month, day) -- every Hebrew
  // date recurs at least once within 2 years even accounting for deficient
  // variable-length months. Fail loudly rather than returning a fabricated date.
  throw new Error(`Could not find an upcoming occurrence for ${day} ${month} within 2 years of the search start`);
}

// Exact validation once a specific Hebrew year is known (manual entry with
// a year, or import rows that include HebYear) -- stricter than
// isPlausibleHebrewDate, which only bounds the day against the month's
// widest possible length across any year.
export function isValidHebrewDateForYear(month: HebrewMonthName, day: number, hebrewYear: number): boolean {
  if (!isPlausibleHebrewDate(month, day)) return false;
  return candidatesForYear(month, day, hebrewYear).length > 0
    || (VARIABLE_LENGTH.has(month) && day === 30); // still a coherent (if year-ambiguous) date, not invalid
}
