// AI Meeting Notes -- deterministic due-date resolver (docs/AI-HANDOFF.md,
// "Fix AI Follow-Up Scheduling and Prepare Owner Testing"). Turns the
// free-text suggestedDueDate the AI organizer returns (organize.ts's
// system prompt deliberately invites relative phrasing, e.g. "next week",
// "after Yom Tov") into an actual calendar date WHERE that can be done
// reliably, without ever inventing a precise date for genuinely ambiguous
// or Hebrew-calendar-dependent wording.
//
// Pure date arithmetic, no AI call, no network, no external calendar
// library -- "a simple, reliable solution" per the task's own preference.
// Dates are manipulated as plain "YYYY-MM-DD" strings anchored at UTC noon
// (new Date(`${iso}T12:00:00Z`)), the same date-only convention already
// used elsewhere in this codebase (db/schema.ts's occurredAtDateOnly,
// app/api/meeting-notes/route.ts's own date handling) specifically so a
// calendar day never shifts across a timezone boundary -- this sidesteps
// needing any actual per-user IANA timezone, which this app does not
// otherwise track.

export type DueDateResolution =
  // No due-date language at all (suggestedDueDate was null/empty).
  | { kind: "none" }
  // The transcript stated an actual calendar date (a month name + day, or
  // a numeric date) -- high confidence, not a computed guess.
  | { kind: "explicit"; date: string; phrase: string }
  // A relative phrase that maps unambiguously to one exact date given the
  // meeting date (e.g. "tomorrow", "next Monday", "in two weeks").
  | { kind: "resolved"; date: string; phrase: string }
  // Due-date language was recognized but a precise date cannot be
  // determined reliably (a vague modifier, or a Hebrew-calendar
  // reference) -- the original wording is preserved, never discarded.
  | { kind: "unresolved"; phrase: string; reason: string };

const JEWISH_CALENDAR_TERMS = [
  "yom tov", "yomtov", "pesach", "passover", "sukkos", "sukkot",
  "shavuos", "shavuot", "rosh hashana", "rosh hashanah", "yom kippur",
  "chanukah", "hanukkah", "purim", "shmini atzeres", "shemini atzeret",
  "simchas torah", "simchat torah", "tu bishvat", "tu b'shvat",
  "tisha b'av", "tishah b'av", "lag ba'omer", "lag baomer",
];

const VAGUE_TERMS = [
  "soon", "shortly", "eventually", "at some point", "sometime",
  "in a bit", "down the road", "later on",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function parseDateOnly(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = parseDateOnly(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

// The next occurrence of targetDow strictly AFTER the meeting date -- "next
// Monday" said on a Monday means next week's Monday, not today.
function nextWeekday(iso: string, targetDow: number): string {
  const date = parseDateOnly(iso);
  const currentDow = date.getUTCDay();
  let delta = (targetDow - currentDow + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(iso, delta);
}

function matchNumberWord(text: string): number | null {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  return NUMBER_WORDS[text] ?? null;
}

// A literal calendar date explicitly stated in the conversation -- "the
// 20th of November", "November 20th", "11/20", "11/20/2026". Rolled to the
// following year only if the resulting date would otherwise be in the
// past relative to the meeting date (a follow-up is always in the future).
function tryExplicitDate(lower: string, meetingDateISO: string): string | null {
  const meetingYear = parseDateOnly(meetingDateISO).getUTCFullYear();

  const monthDay = lower.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun[e]?|jul[y]?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (monthDay) {
    const month = MONTHS[monthDay[1]];
    const day = parseInt(monthDay[2], 10);
    return buildDateRollingYearForward(meetingYear, month, day, meetingDateISO);
  }

  const dayMonth = lower.match(
    /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun[e]?|jul[y]?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  );
  if (dayMonth) {
    const month = MONTHS[dayMonth[2]];
    const day = parseInt(dayMonth[1], 10);
    return buildDateRollingYearForward(meetingYear, month, day, meetingDateISO);
  }

  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = parseInt(numeric[1], 10) - 1;
    const day = parseInt(numeric[2], 10);
    if (month < 0 || month > 11) return null;
    if (numeric[3]) {
      const year = numeric[3].length === 2 ? 2000 + parseInt(numeric[3], 10) : parseInt(numeric[3], 10);
      return buildDate(year, month, day);
    }
    return buildDateRollingYearForward(meetingYear, month, day, meetingDateISO);
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day, 12));
  // Reject an invalid day-of-month (e.g. Feb 30) -- Date would otherwise
  // silently roll it into the next month.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return formatDateOnly(date);
}

function buildDateRollingYearForward(year: number, month: number, day: number, meetingDateISO: string): string | null {
  const candidate = buildDate(year, month, day);
  if (!candidate) return null;
  if (candidate < meetingDateISO) return buildDate(year + 1, month, day);
  return candidate;
}

// A relative phrase that maps unambiguously to one exact date -- "today",
// "tomorrow", "next <weekday>", "in N day(s)/week(s)". Deliberately does
// NOT resolve a bare "next week"/"this week" (which day of that week is
// not stated) -- that falls through to tryUnresolved below.
function tryResolvedRelative(lower: string, meetingDateISO: string): string | null {
  if (/\btoday\b/.test(lower)) return meetingDateISO;
  if (/\btomorrow\b/.test(lower)) return addDays(meetingDateISO, 1);

  const nextWeekdayMatch = lower.match(new RegExp(`\\bnext\\s+(${WEEKDAYS.join("|")})\\b`));
  if (nextWeekdayMatch) return nextWeekday(meetingDateISO, WEEKDAYS.indexOf(nextWeekdayMatch[1]));

  const inDays = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|\d+)\s+day(s)?\b/);
  if (inDays) {
    const n = matchNumberWord(inDays[1]);
    if (n !== null) return addDays(meetingDateISO, n);
  }

  const inWeeks = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|\d+)\s+week(s)?\b/);
  if (inWeeks) {
    const n = matchNumberWord(inWeeks[1]);
    if (n !== null) return addDays(meetingDateISO, n * 7);
  }

  return null;
}

function findJewishCalendarTerm(lower: string): string | null {
  return JEWISH_CALENDAR_TERMS.find((term) => lower.includes(term)) ?? null;
}

function findVagueTerm(lower: string): string | null {
  return VAGUE_TERMS.find((term) => lower.includes(term)) ?? null;
}

// Entry point. meetingDateISO must already be a valid "YYYY-MM-DD" --
// callers (follow-ups.ts) only ever pass the review screen's own meeting
// date field, which is itself always a valid date input value.
export function resolveDueDatePhrase(phrase: string | null | undefined, meetingDateISO: string): DueDateResolution {
  const trimmed = phrase?.trim() ?? "";
  if (trimmed.length === 0) return { kind: "none" };

  const lower = trimmed.toLowerCase();

  // Hebrew-calendar references are never computed, regardless of how
  // specific the rest of the phrase sounds -- "two weeks after Pesach"
  // still depends on exactly which Pesach, which this app has no Hebrew
  // calendar data to resolve.
  const jewishTerm = findJewishCalendarTerm(lower);
  if (jewishTerm) {
    return {
      kind: "unresolved",
      phrase: trimmed,
      reason: `References the Jewish calendar ("${jewishTerm}") -- the exact date depends on the Hebrew calendar and must be set manually.`,
    };
  }

  const explicitDate = tryExplicitDate(lower, meetingDateISO);
  if (explicitDate) return { kind: "explicit", date: explicitDate, phrase: trimmed };

  const resolvedDate = tryResolvedRelative(lower, meetingDateISO);
  if (resolvedDate) return { kind: "resolved", date: resolvedDate, phrase: trimmed };

  const vagueTerm = findVagueTerm(lower);
  if (vagueTerm) {
    return { kind: "unresolved", phrase: trimmed, reason: `"${vagueTerm}" is too vague to compute a specific date.` };
  }

  // Anything else the AI flagged as due-date language that this parser
  // doesn't specifically recognize (e.g. a bare "next week" with no day
  // named, "end of the month") -- preserved, never guessed at.
  return { kind: "unresolved", phrase: trimmed, reason: "Could not determine a specific date from this wording." };
}
